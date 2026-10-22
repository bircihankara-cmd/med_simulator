import React, { useEffect, useMemo, useState } from "react";
import {
  Sun,
  Moon,
  Flame,
  Droplets,
  Gauge,
  Layers,
  Activity,
  Zap,
  Thermometer,
  AlertTriangle,
  CheckCircle2,
  Play,
  Pause,
  Waves,
  Battery,
} from "lucide-react";

/* =====================================================================
 * PV + Molten Salt destekli MED (Multi-Effect Distillation) Simülatörü
 * Tek dosya React + TypeScript bileşeni. Stil: yalnızca standart Tailwind
 * sınıfları + dinamik renkler için inline style (Artifacts uyumlu).
 * ===================================================================== */

/* ----------------------------- Tipler ------------------------------ */

type StageCount = 3 | 10;
type OperatingMode = "day" | "night";
type AlarmLevel = "ok" | "warn" | "crit";

interface MEDInputs {
  stages: StageCount;
  qInKW: number; // MED 1. kademeye verilen termal güç [kW_th]
  tTop: number; // En yüksek salamura sıcaklığı (TBT) [°C]
  tLast: number; // Son kademe salamura sıcaklığı [°C]
  feedM3h: number; // Ham deniz suyu besleme debisi [m³/h]
}

interface EffectState {
  index: number;
  tBrine: number; // Salamura sıcaklığı [°C]
  bpe: number; // Kaynama noktası yükselmesi [°C]
  tVapor: number; // Buharın doyma sıcaklığı [°C]
  pressureKPa: number; // Kademe vakum basıncı [kPa]
  hfg: number; // Gizli ısı [kJ/kg]
  heatInKW: number; // Kademeye giren ısıl güç [kW]
  distillateKgS: number;
  distillateLh: number;
  brineOutKgS: number;
  salinityPpm: number;
}

interface MEDResult {
  effects: EffectState[];
  deltaT: number;
  feedKgS: number;
  feedSensibleKW: number;
  totalKgS: number;
  totalLh: number;
  m3Day: number;
  hfgAvg: number;
  gor: number;
  recovery: number;
  brineSalinityPpm: number;
  brineM3h: number;
  stecKWhM3: number;
  condenserKW: number;
  coolingWaterM3h: number;
  dryout: boolean;
}

interface EnergyInputs {
  mode: OperatingMode;
  qDemandKW: number;
  pvKWp: number;
  irradiance: number; // W/m²
  soc: number; // 0..1
}

interface EnergyState {
  pvKWe: number;
  heaterKWth: number;
  saltDrawKWth: number; // Tuzdan HX'e çekilen güç
  netChargeKW: number; // + şarj, - deşarj
  qDeliveredKW: number; // MED'e fiilen verilen güç
  pvShare: number; // 0..1
  saltTempC: number;
  storedKWh: number;
  autonomyH: number;
  starved: boolean;
}

interface Alarm {
  level: AlarmLevel;
  title: string;
  detail: string;
}

/* ------------------------ Fiziksel sabitler ------------------------ */

const CP_SW = 4.0; // Deniz suyu özgül ısısı [kJ/kg·K]
const RHO_SW = 1025; // Deniz suyu yoğunluğu [kg/m³]
const RHO_DIST = 995; // Distilat yoğunluğu [kg/m³]
const S_FEED = 35000; // Ham deniz suyu tuzluluğu [ppm]
const ETA_TRANSFER = 0.95; // Kademeler arası ısı aktarım verimi
const T_SEAWATER = 25; // Deniz suyu alım sıcaklığı [°C]
const CONDENSER_APPROACH = 4; // Son kondenser yaklaşım farkı [K]
const TBT_SCALING_LIMIT = 70; // CaSO4 (anhidrit) kışır riski için TBT sınırı [°C]
const SALINITY_SCALING_LIMIT = 70000; // Brine tuzluluk sınırı [ppm]
const SALINITY_WARN = 65000;

// Erimiş tuz deposu (Solar Salt: %60 NaNO3 / %40 KNO3)
const SALT_MASS_KG = 80000;
const SALT_CP = 1.53; // [kJ/kg·K]
const SALT_T_MIN = 260; // Donma (~238 °C) üstünde emniyet payı [°C]
const SALT_T_MAX = 400; // [°C]
const SALT_CAPACITY_KWH = (SALT_MASS_KG * SALT_CP * (SALT_T_MAX - SALT_T_MIN)) / 3600;
const ETA_HEATER = 0.98; // PV → elektrikli ısıtıcı
const ETA_HX = 0.96; // Tuz → MED ısı değiştirici
const PV_PERFORMANCE_RATIO = 0.86;

const SIM_STEP_H = 1 / 6; // Her tick = 10 dk simülasyon zamanı
const SIM_TICK_MS = 600;

/* ---------------------- Termodinamik bağıntılar --------------------- */

/** Gizli ısı: h_fg(T) ≈ 2501 − 2.36·T [kJ/kg] */
const latentHeat = (tC: number): number => 2501 - 2.36 * tC;

/** Antoine (su, 1–100 °C): log10(P[mmHg]) = 8.07131 − 1730.63 / (233.426 + T) → kPa */
const antoinePressureKPa = (tC: number): number =>
  Math.pow(10, 8.07131 - 1730.63 / (233.426 + tC)) * 0.133322;

/** Kaynama noktası yükselmesi (El-Dessouky & Ettouney), X: ppm, T: °C → BPE [°C] */
const boilingPointElevation = (tC: number, ppm: number): number => {
  const b = (6.71 + 6.34e-2 * tC + 9.74e-5 * tC * tC) * 1e-3;
  const c = (22.238 + 9.59e-3 * tC + 9.42e-5 * tC * tC) * 1e-8;
  return ppm * (b + c * ppm) * 1e-3;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/* --------------------------- MED motoru ---------------------------- */

function simulateMED(inp: MEDInputs): MEDResult {
  const n = inp.stages;
  const deltaT = (inp.tTop - inp.tLast) / (n - 1);
  const feedKgS = (inp.feedM3h * RHO_SW) / 3600;
  const tBrine = Array.from({ length: n }, (_, i) => inp.tTop - i * deltaT);

  // Besleme lineer ön ısıtıcılarla T1 − ΔT'ye kadar ısıtılır; kalan duyulur ısı 1. kademede karşılanır.
  const feedSensibleKW = feedKgS * CP_SW * deltaT;

  let salinity: number[] = new Array(n).fill(S_FEED);
  let effects: EffectState[] = [];
  let dryout = false;

  // BPE ↔ tuzluluk bağlaşımı için sabit nokta iterasyonu
  for (let iter = 0; iter < 5; iter++) {
    const next: EffectState[] = [];
    let brine = feedKgS;
    dryout = false;
    for (let i = 0; i < n; i++) {
      const bpe = boilingPointElevation(tBrine[i], Math.min(salinity[i], 150000));
      const tVapor = tBrine[i] - bpe;
      const hfg = latentHeat(tVapor);
      let heatIn: number;
      let d: number;
      if (i === 0) {
        heatIn = inp.qInKW;
        d = Math.max(0, (inp.qInKW - feedSensibleKW) / hfg); // D1 = (Q_in − Q_sens) / h_fg(T1)
      } else {
        const prev = next[i - 1];
        heatIn = prev.distillateKgS * prev.hfg * ETA_TRANSFER; // D_{i-1}·h_fg(T_{i-1})·η
        d = heatIn / hfg;
      }
      const maxEvap = brine * 0.85; // Kademe kurumasını engelle
      if (d > maxEvap) {
        d = maxEvap;
        dryout = true;
      }
      brine -= d;
      next.push({
        index: i + 1,
        tBrine: tBrine[i],
        bpe,
        tVapor,
        pressureKPa: antoinePressureKPa(tVapor),
        hfg,
        heatInKW: heatIn,
        distillateKgS: d,
        distillateLh: (d * 3600 * 1000) / RHO_DIST,
        brineOutKgS: brine,
        salinityPpm: brine > 1e-6 ? (feedKgS * S_FEED) / brine : 250000,
      });
    }
    salinity = next.map((e) => e.salinityPpm);
    effects = next;
  }

  const totalKgS = effects.reduce((s, e) => s + e.distillateKgS, 0);
  const hfgAvg = effects.reduce((s, e) => s + e.hfg, 0) / n;
  const totalM3h = (totalKgS * 3600) / RHO_DIST;
  const last = effects[n - 1];
  const condenserKW = last.distillateKgS * last.hfg;
  const tCwOut = last.tVapor - CONDENSER_APPROACH;
  const coolingKgS = condenserKW / (CP_SW * Math.max(1, tCwOut - T_SEAWATER));

  return {
    effects,
    deltaT,
    feedKgS,
    feedSensibleKW,
    totalKgS,
    totalLh: totalM3h * 1000,
    m3Day: totalM3h * 24,
    hfgAvg,
    gor: inp.qInKW > 0 ? (totalKgS * hfgAvg) / inp.qInKW : 0,
    recovery: feedKgS > 0 ? totalKgS / feedKgS : 0,
    brineSalinityPpm: last.salinityPpm,
    brineM3h: (last.brineOutKgS * 3600) / RHO_SW,
    stecKWhM3: totalM3h > 0 ? inp.qInKW / totalM3h : 0,
    condenserKW,
    coolingWaterM3h: (coolingKgS * 3600) / RHO_SW,
    dryout,
  };
}

/* ------------------------ Enerji / tuz motoru ----------------------- */

function simulateEnergy(e: EnergyInputs): EnergyState {
  const pvKWe = e.mode === "day" ? e.pvKWp * (e.irradiance / 1000) * PV_PERFORMANCE_RATIO : 0;
  const heaterKWth = pvKWe * ETA_HEATER;
  const storedKWh = e.soc * SALT_CAPACITY_KWH;
  const requiredDraw = e.qDemandKW / ETA_HX;
  const empty = storedKWh <= 0.5;

  // Depo boşsa yalnızca anlık ısıtıcı gücü kadar çekilebilir
  const saltDrawKWth = empty ? Math.min(requiredDraw, heaterKWth) : requiredDraw;
  const qDeliveredKW = saltDrawKWth * ETA_HX;
  const netChargeKW = heaterKWth - saltDrawKWth;
  const pvShare = requiredDraw > 0 ? clamp(heaterKWth / requiredDraw, 0, 1) : 0;

  return {
    pvKWe,
    heaterKWth,
    saltDrawKWth,
    netChargeKW,
    qDeliveredKW,
    pvShare,
    saltTempC: SALT_T_MIN + e.soc * (SALT_T_MAX - SALT_T_MIN),
    storedKWh,
    autonomyH: netChargeKW < 0 ? storedKWh / -netChargeKW : Infinity,
    starved: qDeliveredKW < e.qDemandKW - 0.5,
  };
}

/* --------------------------- Yardımcılar --------------------------- */

const fmt = (v: number, digits = 0): string =>
  Number.isFinite(v)
    ? v.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "∞";

/** Sıcaktan (kırmızı) soğuğa (mavi) yumuşak geçiş: frac = 1 sıcak, 0 soğuk */
const thermalColor = (frac: number, light = 55, alpha = 1): string => {
  const hue = 210 - 210 * clamp(frac, 0, 1);
  return `hsla(${hue.toFixed(0)}, 85%, ${light}%, ${alpha})`;
};

const formatClock = (h: number): string => {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

/* ======================== Alt bileşenler ========================== */

interface PanelProps {
  title: string;
  icon: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const Panel: React.FC<PanelProps> = ({ title, icon, right, children, className = "" }) => (
  <section className={`rounded-xl border border-slate-800 bg-slate-900/60 shadow-lg ${className}`}>
    <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
        <span className="text-cyan-400">{icon}</span>
        {title}
      </div>
      {right}
    </header>
    <div className="p-4">{children}</div>
  </section>
);

interface MetricCardProps {
  label: string;
  value: string;
  unit: string;
  sub: string;
  icon: React.ReactNode;
  accent: "cyan" | "amber" | "emerald" | "rose";
  status?: AlarmLevel;
}

const ACCENTS: Record<MetricCardProps["accent"], { text: string; ring: string; bg: string }> = {
  cyan: { text: "text-cyan-300", ring: "border-cyan-500/30", bg: "bg-cyan-500/10" },
  amber: { text: "text-amber-300", ring: "border-amber-500/30", bg: "bg-amber-500/10" },
  emerald: { text: "text-emerald-300", ring: "border-emerald-500/30", bg: "bg-emerald-500/10" },
  rose: { text: "text-rose-300", ring: "border-rose-500/30", bg: "bg-rose-500/10" },
};

const MetricCard: React.FC<MetricCardProps> = ({ label, value, unit, sub, icon, accent, status = "ok" }) => {
  const a = ACCENTS[accent];
  const dot = status === "crit" ? "bg-rose-500" : status === "warn" ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className={`relative overflow-hidden rounded-xl border ${a.ring} bg-slate-900/70 p-4`}>
      <div className="flex items-start justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</span>
        <span className={`rounded-lg ${a.bg} p-1.5 ${a.text}`}>{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`font-mono text-3xl font-bold tabular-nums ${a.text}`}>{value}</span>
        <span className="text-sm text-slate-400">{unit}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
        {sub}
      </div>
    </div>
  );
};

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  digits?: number;
  hint?: string;
  icon: React.ReactNode;
  onChange: (v: number) => void;
  disabled?: boolean;
}

const SliderControl: React.FC<SliderControlProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit,
  digits = 0,
  hint,
  icon,
  onChange,
  disabled = false,
}) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={`space-y-1.5 ${disabled ? "opacity-40" : ""}`}>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
          <span className="text-slate-500">{icon}</span>
          {label}
        </label>
        <span className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 font-mono text-xs tabular-nums text-cyan-300">
          {fmt(value, digits)} {unit}
        </span>
      </div>
      <div className="relative h-5">
        <div className="absolute top-2 h-1 w-full rounded-full bg-slate-800" />
        <div
          className="absolute top-2 h-1 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-300"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(ev) => onChange(Number(ev.target.value))}
          className="absolute inset-0 h-5 w-full cursor-pointer opacity-0"
          aria-label={label}
        />
        <div
          className="pointer-events-none absolute top-0.5 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-cyan-300 bg-slate-950 shadow"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-600">
        <span>
          {fmt(min, digits)} {unit}
        </span>
        {hint && <span className="text-slate-500">{hint}</span>}
        <span>
          {fmt(max, digits)} {unit}
        </span>
      </div>
    </div>
  );
};

interface ToggleOption<T extends string | number> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

interface SegmentedToggleProps<T extends string | number> {
  value: T;
  options: ToggleOption<T>[];
  onChange: (v: T) => void;
  activeClass: string;
}

function SegmentedToggle<T extends string | number>({ value, options, onChange, activeClass }: SegmentedToggleProps<T>) {
  return (
    <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
            value === o.value ? activeClass : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface EffectCardProps {
  effect: EffectState;
  frac: number;
  compact: boolean;
  running: boolean;
}

const EffectCard: React.FC<EffectCardProps> = ({ effect, frac, compact, running }) => {
  const color = thermalColor(frac);
  const scaling = effect.salinityPpm > SALINITY_SCALING_LIMIT;
  const rows: [string, string, string][] = [
    ["Sıcaklık", fmt(effect.tBrine, 1), "°C"],
    ["Vakum", fmt(effect.pressureKPa, compact ? 1 : 2), "kPa"],
    ["Distilat", fmt(effect.distillateLh, 0), "L/h"],
    ["Tuzluluk", fmt(effect.salinityPpm / 1000, 1), "ppt"],
  ];
  return (
    <div
      className="relative overflow-hidden rounded-lg border bg-slate-950/80"
      style={{ borderColor: thermalColor(frac, 50, 0.45), boxShadow: `inset 0 3px 0 0 ${color}` }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="font-mono text-xs font-bold tracking-wider" style={{ color }}>
          E-{String(effect.index).padStart(2, "0")}
        </span>
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "animate-pulse" : ""}`}
            style={{ backgroundColor: scaling ? "#f43f5e" : running ? "#34d399" : "#64748b" }}
          />
          {scaling ? "KIŞIR" : running ? "RUN" : "STOP"}
        </span>
      </div>
      {!compact && (
        <div className="px-3 pt-2">
          <div className="h-16 w-full overflow-hidden rounded border border-slate-800 bg-slate-900">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full">
              <rect x="0" y="22" width="100" height="18" fill={thermalColor(frac, 40, 0.5)} />
              {running &&
                [12, 30, 48, 66, 84].map((x, k) => (
                  <circle key={x} cx={x} cy="34" r="1.6" fill={thermalColor(frac, 75, 0.9)}>
                    <animate attributeName="cy" values="36;8;36" dur={`${1.6 + k * 0.25}s`} repeatCount="indefinite" />
                    <animate attributeName="opacity" values="1;0;1" dur={`${1.6 + k * 0.25}s`} repeatCount="indefinite" />
                  </circle>
                ))}
              <line x1="0" y1="22" x2="100" y2="22" stroke={color} strokeWidth="0.6" />
            </svg>
          </div>
        </div>
      )}
      <dl className={`grid ${compact ? "grid-cols-1 gap-0.5 px-3 pb-2.5 pt-1.5" : "grid-cols-2 gap-2 p-3"}`}>
        {rows.map(([k, v, u]) => (
          <div key={k} className={compact ? "flex items-baseline justify-between" : ""}>
            <dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt>
            <dd className={`font-mono tabular-nums text-slate-100 ${compact ? "text-xs" : "text-base"}`}>
              {v} <span className="text-xs text-slate-500">{u}</span>
            </dd>
          </div>
        ))}
      </dl>
      {!compact && (
        <div className="border-t border-slate-800 px-3 py-1.5 font-mono text-xs text-slate-500">
          T_buhar {fmt(effect.tVapor, 2)} °C · BPE {fmt(effect.bpe, 2)} K · Q {fmt(effect.heatInKW, 0)} kW
        </div>
      )}
    </div>
  );
};

/* ---------------------- MED akış şeridi (SVG) ---------------------- */

interface FlowStripProps {
  effects: EffectState[];
  tTop: number;
  tLast: number;
  running: boolean;
  condenserKW: number;
}

const FlowStrip: React.FC<FlowStripProps> = ({ effects, tTop, tLast, running, condenserKW }) => {
  const n = effects.length;
  const w = 1000;
  const x0 = 110;
  const x1 = 890;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const r = n > 5 ? 22 : 34;
  const maxD = Math.max(...effects.map((e) => e.distillateLh), 1);
  return (
    <svg viewBox={`0 0 ${w} 162`} className="h-auto w-full" role="img" aria-label="MED kademe akış şeması">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
      </defs>
      {/* Isı girişi */}
      <text x="10" y="58" fill="#fbbf24" fontSize="13" fontFamily="monospace">
        Q_in
      </text>
      <line x1="10" y1="70" x2={x0 - r - 4} y2="70" stroke="#f59e0b" strokeWidth="3" markerEnd="url(#arrow)" strokeDasharray="8 6">
        {running && <animate attributeName="stroke-dashoffset" from="28" to="0" dur="0.8s" repeatCount="indefinite" />}
      </line>
      {effects.map((e, i) => {
        const cx = x0 + i * step;
        const frac = (e.tBrine - tLast) / Math.max(1e-6, tTop - tLast);
        const nextX = cx + step;
        return (
          <g key={e.index}>
            {i < n - 1 && (
              <line
                x1={cx + r + 2}
                y1="70"
                x2={nextX - r - 4}
                y2="70"
                stroke={thermalColor(frac, 60)}
                strokeWidth={2 + (3 * e.distillateLh) / maxD}
                strokeDasharray="6 5"
                markerEnd="url(#arrow)"
              >
                {running && <animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.9s" repeatCount="indefinite" />}
              </line>
            )}
            <circle cx={cx} cy="70" r={r} fill="#0b0f19" stroke={thermalColor(frac)} strokeWidth="3" />
            <circle cx={cx} cy="70" r={r - 6} fill={thermalColor(frac, 45, 0.25)} />
            <text x={cx} y="75" textAnchor="middle" fill="#e2e8f0" fontSize={n > 5 ? 13 : 16} fontFamily="monospace" fontWeight="700">
              {e.index}
            </text>
            <text x={cx} y={70 - r - 8} textAnchor="middle" fill={thermalColor(frac, 70)} fontSize="12" fontFamily="monospace">
              {fmt(e.tBrine, 1)}°
            </text>
            <text x={cx} y={70 + r + 18} textAnchor="middle" fill="#94a3b8" fontSize="11" fontFamily="monospace">
              {fmt(e.pressureKPa, 1)} kPa
            </text>
            <line x1={cx} y1={70 + r + 24} x2={cx} y2="140" stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="2 3" />
          </g>
        );
      })}
      {/* Distilat toplayıcı ve kondenser */}
      <line x1={x0} y1="140" x2={x1 + 60} y2="140" stroke="#22d3ee" strokeWidth="3" />
      <text x={x1 + 68} y="156" fill="#67e8f9" fontSize="11" fontFamily="monospace" textAnchor="middle">
        distilat
      </text>
      <rect x={x1 + 40} y="48" width="56" height="44" rx="6" fill="#0f172a" stroke="#38bdf8" strokeWidth="2" />
      <text x={x1 + 68} y="68" fill="#7dd3fc" fontSize="11" fontFamily="monospace" textAnchor="middle">
        KOND.
      </text>
      <text x={x1 + 68} y="83" fill="#94a3b8" fontSize="10" fontFamily="monospace" textAnchor="middle">
        {fmt(condenserKW, 0)} kW
      </text>
      <line x1={x1 + r + 2} y1="70" x2={x1 + 38} y2="70" stroke="#38bdf8" strokeWidth="2" strokeDasharray="6 5" markerEnd="url(#arrow)">
        {running && <animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.9s" repeatCount="indefinite" />}
      </line>
    </svg>
  );
};

/* -------------------- Profil grafiği (bar + çizgi) ------------------ */

interface ProfileChartProps {
  effects: EffectState[];
  tTop: number;
  tLast: number;
}

const ProfileChart: React.FC<ProfileChartProps> = ({ effects, tTop, tLast }) => {
  const w = 600;
  const h = 220;
  const pad = { l: 44, r: 44, t: 16, b: 30 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const n = effects.length;
  const bw = (iw / n) * 0.55;
  const maxD = Math.max(...effects.map((e) => e.distillateLh)) * 1.15 || 1;
  const maxP = Math.max(...effects.map((e) => e.pressureKPa)) * 1.15 || 1;
  const xc = (i: number): number => pad.l + (iw / n) * (i + 0.5);
  const yD = (v: number): number => pad.t + ih - (v / maxD) * ih;
  const yP = (v: number): number => pad.t + ih - (v / maxP) * ih;
  const path = effects.map((e, i) => `${i === 0 ? "M" : "L"}${xc(i).toFixed(1)},${yP(e.pressureKPa).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label="Kademe distilat ve basınç profili">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={pad.t + ih * (1 - t)} y2={pad.t + ih * (1 - t)} stroke="#1e293b" strokeWidth="1" />
          <text x={pad.l - 6} y={pad.t + ih * (1 - t) + 4} fill="#64748b" fontSize="10" textAnchor="end" fontFamily="monospace">
            {fmt(maxD * t, 0)}
          </text>
          <text x={w - pad.r + 6} y={pad.t + ih * (1 - t) + 4} fill="#64748b" fontSize="10" fontFamily="monospace">
            {fmt(maxP * t, 0)}
          </text>
        </g>
      ))}
      {effects.map((e, i) => {
        const frac = (e.tBrine - tLast) / Math.max(1e-6, tTop - tLast);
        return (
          <g key={e.index}>
            <rect
              x={xc(i) - bw / 2}
              y={yD(e.distillateLh)}
              width={bw}
              height={pad.t + ih - yD(e.distillateLh)}
              rx="2"
              fill={thermalColor(frac, 55, 0.75)}
            >
              <title>{`E-${e.index}: ${fmt(e.distillateLh, 0)} L/h`}</title>
            </rect>
            <text x={xc(i)} y={h - 10} fill="#94a3b8" fontSize="10" textAnchor="middle" fontFamily="monospace">
              {e.index}
            </text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke="#fbbf24" strokeWidth="2" />
      {effects.map((e, i) => (
        <circle key={e.index} cx={xc(i)} cy={yP(e.pressureKPa)} r="3.5" fill="#0b0f19" stroke="#fbbf24" strokeWidth="2">
          <title>{`E-${e.index}: ${fmt(e.pressureKPa, 2)} kPa`}</title>
        </circle>
      ))}
      <text x={pad.l} y={10} fill="#94a3b8" fontSize="10" fontFamily="monospace">
        Distilat [L/h]
      </text>
      <text x={w - pad.r} y={10} fill="#fbbf24" fontSize="10" fontFamily="monospace" textAnchor="end">
        Vakum [kPa]
      </text>
    </svg>
  );
};

/* -------------------- Enerji akış şeması (SVG) --------------------- */

interface EnergyFlowProps {
  energy: EnergyState;
  mode: OperatingMode;
  running: boolean;
}

const EnergyFlow: React.FC<EnergyFlowProps> = ({ energy, mode, running }) => {
  const pvActive = mode === "day" && energy.pvKWe > 1;
  const medActive = energy.qDeliveredKW > 1;
  const node = (x: number, label: string, value: string, color: string, active: boolean) => (
    <g>
      <rect x={x} y="22" width="110" height="56" rx="8" fill="#0f172a" stroke={active ? color : "#334155"} strokeWidth="2" />
      <text x={x + 55} y="44" textAnchor="middle" fill={active ? color : "#64748b"} fontSize="12" fontFamily="monospace" fontWeight="700">
        {label}
      </text>
      <text x={x + 55} y="64" textAnchor="middle" fill="#cbd5e1" fontSize="12" fontFamily="monospace">
        {value}
      </text>
    </g>
  );
  const link = (xa: number, xb: number, color: string, active: boolean) => (
    <line x1={xa} y1="50" x2={xb} y2="50" stroke={active ? color : "#334155"} strokeWidth="3" strokeDasharray="7 5">
      {active && running && <animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.8s" repeatCount="indefinite" />}
    </line>
  );
  return (
    <svg viewBox="0 0 640 100" className="h-auto w-full" role="img" aria-label="Enerji akış şeması">
      {link(120, 176, "#fbbf24", pvActive)}
      {link(286, 342, "#f97316", pvActive)}
      {link(452, 508, "#f43f5e", medActive)}
      {node(10, "PV", `${fmt(energy.pvKWe, 0)} kWe`, "#fbbf24", pvActive)}
      {node(176, "ISITICI", `${fmt(energy.heaterKWth, 0)} kWt`, "#f97316", pvActive)}
      {node(342, "TUZ DEPO", `${fmt(energy.saltTempC, 0)} °C`, "#f43f5e", energy.storedKWh > 1)}
      {node(508, "HX → MED", `${fmt(energy.qDeliveredKW, 0)} kWt`, "#22d3ee", medActive)}
    </svg>
  );
};

/* ------------------------ Erimiş tuz deposu ------------------------ */

interface SaltTankProps {
  soc: number;
  energy: EnergyState;
  mode: OperatingMode;
}

const SaltTank: React.FC<SaltTankProps> = ({ soc, energy, mode }) => {
  const level = clamp(soc, 0, 1);
  const fillH = 120 * level;
  const charging = energy.netChargeKW > 0.5;
  const frac = (energy.saltTempC - SALT_T_MIN) / (SALT_T_MAX - SALT_T_MIN);
  const saltColor = `hsl(${(45 - 40 * frac).toFixed(0)}, 95%, ${(45 + 10 * frac).toFixed(0)}%)`;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 90 160" className="h-40 w-24 shrink-0" role="img" aria-label="Erimiş tuz deposu dolum seviyesi">
        <rect x="10" y="15" width="70" height="130" rx="10" fill="#0f172a" stroke="#475569" strokeWidth="2" />
        <clipPath id="tankClip">
          <rect x="14" y="19" width="62" height="122" rx="7" />
        </clipPath>
        <g clipPath="url(#tankClip)">
          <rect x="14" y={141 - fillH} width="62" height={fillH + 2} fill={saltColor} opacity="0.85" />
          <path d={`M14,${141 - fillH} q8,-4 16,0 t16,0 t16,0 t16,0 v6 h-64 z`} fill={saltColor}>
            <animateTransform attributeName="transform" type="translate" values="0,0;-8,0;0,0" dur="3s" repeatCount="indefinite" />
          </path>
        </g>
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1="76" x2="84" y1={141 - 122 * t} y2={141 - 122 * t} stroke="#64748b" strokeWidth="1" />
        ))}
        <rect x="35" y="5" width="20" height="10" rx="2" fill="#334155" />
        <text x="45" y="85" textAnchor="middle" fill="#0b0f19" fontSize="16" fontWeight="800" fontFamily="monospace">
          {fmt(level * 100, 0)}%
        </text>
      </svg>
      <dl className="grid flex-1 grid-cols-1 gap-2 text-xs">
        <div className="flex justify-between">
          <dt className="text-slate-500">Tuz sıcaklığı</dt>
          <dd className="font-mono text-amber-300">{fmt(energy.saltTempC, 1)} °C</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Depolanan enerji</dt>
          <dd className="font-mono text-slate-200">
            {fmt(energy.storedKWh, 0)} / {fmt(SALT_CAPACITY_KWH, 0)} kWh
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Net akış</dt>
          <dd className={`font-mono ${charging ? "text-emerald-300" : "text-rose-300"}`}>
            {charging ? "+" : ""}
            {fmt(energy.netChargeKW, 0)} kW
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Durum</dt>
          <dd className={`font-mono ${charging ? "text-emerald-300" : "text-amber-300"}`}>
            {charging ? "ŞARJ" : mode === "night" ? "DEŞARJ (GECE)" : "DEŞARJ (PV yetersiz)"}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Otonomi</dt>
          <dd className="font-mono text-cyan-300">{charging ? "∞ (şarjda)" : `${fmt(energy.autonomyH, 1)} saat`}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">PV payı</dt>
          <dd className="font-mono text-slate-200">%{fmt(energy.pvShare * 100, 0)}</dd>
        </div>
        <div className="text-slate-600">
          Solar Salt %60 NaNO₃ / %40 KNO₃ · {fmt(SALT_MASS_KG / 1000, 0)} t · {SALT_T_MIN}–{SALT_T_MAX} °C
        </div>
      </dl>
    </div>
  );
};

/* --------------------------- Alarm paneli -------------------------- */

const AlarmList: React.FC<{ alarms: Alarm[] }> = ({ alarms }) => (
  <ul className="space-y-2">
    {alarms.map((a) => {
      const cls =
        a.level === "crit"
          ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
          : a.level === "warn"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
          : "border-emerald-500/30 bg-emerald-500/5 text-emerald-200";
      return (
        <li key={a.title} className={`flex gap-2 rounded-lg border px-3 py-2 text-xs ${cls}`}>
          {a.level === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            <div className="font-semibold">{a.title}</div>
            <div className="opacity-80">{a.detail}</div>
          </div>
        </li>
      );
    })}
  </ul>
);

/* ========================== Ana bileşen =========================== */

const RECOMMENDED_FEED: Record<StageCount, number> = { 3: 6, 10: 14 };

export default function MEDSimulator() {
  const [stages, setStages] = useState<StageCount>(3);
  const [mode, setMode] = useState<OperatingMode>("day");
  const [qInKW, setQInKW] = useState<number>(500);
  const [tTop, setTTop] = useState<number>(70);
  const [tLast, setTLast] = useState<number>(40);
  const [feedM3h, setFeedM3h] = useState<number>(RECOMMENDED_FEED[3]);
  const [pvKWp, setPvKWp] = useState<number>(1200);
  const [irradiance, setIrradiance] = useState<number>(850);
  const [soc, setSoc] = useState<number>(0.65);
  const [running, setRunning] = useState<boolean>(true);
  const [clockH, setClockH] = useState<number>(12);

  const changeStages = (s: StageCount): void => {
    setStages(s);
    setFeedM3h(RECOMMENDED_FEED[s]);
  };

  const energy = useMemo<EnergyState>(
    () => simulateEnergy({ mode, qDemandKW: qInKW, pvKWp, irradiance, soc }),
    [mode, qInKW, pvKWp, irradiance, soc]
  );

  const med = useMemo<MEDResult>(
    () => simulateMED({ stages, qInKW: energy.qDeliveredKW, tTop, tLast, feedM3h }),
    [stages, energy.qDeliveredKW, tTop, tLast, feedM3h]
  );

  const medRunning = energy.qDeliveredKW > 1 && med.totalKgS > 0;

  // Depo dinamiği: her tick 10 dk simülasyon zamanı
  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => {
      setSoc((s) => clamp(s + (energy.netChargeKW * SIM_STEP_H) / SALT_CAPACITY_KWH, 0, 1));
      setClockH((h) => (h + SIM_STEP_H) % 24);
    }, SIM_TICK_MS);
    return () => window.clearInterval(id);
  }, [running, energy.netChargeKW]);

  const alarms = useMemo<Alarm[]>(() => {
    const list: Alarm[] = [];
    if (tTop > TBT_SCALING_LIMIT) {
      list.push({
        level: "warn",
        title: `TBT > ${TBT_SCALING_LIMIT} °C`,
        detail: "CaSO₄ (anhidrit) kışır riski artar. Antiskalant dozajını kontrol edin.",
      });
    }
    if (med.brineSalinityPpm > SALINITY_SCALING_LIMIT) {
      list.push({
        level: "crit",
        title: "Brine tuzluluk sınırı aşıldı",
        detail: `${fmt(med.brineSalinityPpm, 0)} ppm > ${fmt(SALINITY_SCALING_LIMIT, 0)} ppm. Besleme debisini artırın.`,
      });
    } else if (med.brineSalinityPpm > SALINITY_WARN) {
      list.push({
        level: "warn",
        title: "Brine tuzluluğu sınıra yakın",
        detail: `${fmt(med.brineSalinityPpm, 0)} ppm (sınır ${fmt(SALINITY_SCALING_LIMIT, 0)} ppm).`,
      });
    }
    if (med.dryout) {
      list.push({
        level: "crit",
        title: "Kademe kuruma riski",
        detail: "Buharlaşma, kademedeki salamura debisini aşıyor. Besleme debisi yetersiz.",
      });
    }
    if (energy.starved) {
      list.push({
        level: "crit",
        title: "Termal depo tükendi",
        detail: `MED'e yalnızca ${fmt(energy.qDeliveredKW, 0)} kW verilebiliyor (talep ${fmt(qInKW, 0)} kW).`,
      });
    } else if (!(energy.netChargeKW >= 0) && energy.autonomyH < 3) {
      list.push({
        level: "warn",
        title: "Düşük depo otonomisi",
        detail: `Mevcut çekişle ${fmt(energy.autonomyH, 1)} saat sonra depo minimum sıcaklığa iner.`,
      });
    }
    if (energy.saltTempC < SALT_T_MIN + 10) {
      list.push({
        level: "warn",
        title: "Tuz donma emniyet bandı",
        detail: "Solar Salt ~238 °C'de katılaşır. İz ısıtıcıları devreye alın.",
      });
    }
    if (list.length === 0) {
      list.push({ level: "ok", title: "Tüm parametreler normal", detail: "Kışır, vakum ve termal depo sınırları içinde." });
    }
    return list;
  }, [tTop, med, energy, qInKW]);

  const gorTarget = stages === 3 ? "hedef 2,0–2,5" : "hedef 7,0–8,5";
  const gorStatus: AlarmLevel =
    stages === 3 ? (med.gor >= 2 && med.gor <= 2.6 ? "ok" : "warn") : med.gor >= 7 && med.gor <= 8.6 ? "ok" : "warn";
  const brineStatus: AlarmLevel =
    med.brineSalinityPpm > SALINITY_SCALING_LIMIT ? "crit" : med.brineSalinityPpm > SALINITY_WARN ? "warn" : "ok";
  const compact = stages === 10;

  return (
    <div className="min-h-screen w-full text-slate-200" style={{ backgroundColor: "#0b0f19" }}>
      {/* HEADER */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-2 text-cyan-300">
              <Waves className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wide text-slate-100 sm:text-base">PV + MOLTEN SALT · MED DESALİNASYON</h1>
              <p className="font-mono text-xs text-slate-500">
                SCADA · {stages} kademe · ΔT {fmt(med.deltaT, 2)} K · {formatClock(clockH)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedToggle<StageCount>
              value={stages}
              onChange={changeStages}
              activeClass="bg-cyan-500/20 text-cyan-200"
              options={[
                { value: 3, label: "3 Kademe · Prototip", icon: <Layers className="h-3.5 w-3.5" /> },
                { value: 10, label: "10 Kademe · Pilot", icon: <Layers className="h-3.5 w-3.5" /> },
              ]}
            />
            <SegmentedToggle<OperatingMode>
              value={mode}
              onChange={setMode}
              activeClass={mode === "day" ? "bg-amber-500/20 text-amber-200" : "bg-indigo-500/20 text-indigo-200"}
              options={[
                { value: "day", label: "Gündüz · PV + Şarj", icon: <Sun className="h-3.5 w-3.5" /> },
                { value: "night", label: "Gece · Depo Deşarj", icon: <Moon className="h-3.5 w-3.5" /> },
              ]}
            />
            <button
              type="button"
              onClick={() => setRunning((r) => !r)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold ${
                running ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-slate-700 bg-slate-900 text-slate-400"
              }`}
            >
              {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {running ? "Canlı" : "Durdu"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-2xl space-y-4 px-4 py-4">
        {/* KPI KARTLARI */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="GOR"
            value={fmt(med.gor, 2)}
            unit="kg/kg"
            sub={`${gorTarget} · STEC ${fmt(med.stecKWhM3, 0)} kWh/m³`}
            icon={<Activity className="h-4 w-4" />}
            accent="emerald"
            status={medRunning ? gorStatus : "crit"}
          />
          <MetricCard
            label="Saatlik Üretim"
            value={fmt(med.totalLh, 0)}
            unit="L/h"
            sub={`Geri kazanım %${fmt(med.recovery * 100, 1)}`}
            icon={<Droplets className="h-4 w-4" />}
            accent="cyan"
            status={medRunning ? "ok" : "crit"}
          />
          <MetricCard
            label="Günlük Üretim"
            value={fmt(med.m3Day, 1)}
            unit="m³/gün"
            sub={`Besleme ${fmt(feedM3h, 1)} m³/h · ${fmt(S_FEED, 0)} ppm`}
            icon={<Gauge className="h-4 w-4" />}
            accent="amber"
            status={medRunning ? "ok" : "crit"}
          />
          <MetricCard
            label="Atık Brine Tuzluluğu"
            value={fmt(med.brineSalinityPpm / 1000, 1)}
            unit="ppt"
            sub={`${fmt(med.brineSalinityPpm, 0)} ppm · ${fmt(med.brineM3h, 2)} m³/h deşarj`}
            icon={<Waves className="h-4 w-4" />}
            accent="rose"
            status={brineStatus}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* SOL KONTROL PANELİ */}
          <div className="space-y-4 lg:col-span-4 xl:col-span-3">
            <Panel title="Proses Kontrol" icon={<Gauge className="h-4 w-4" />}>
              <div className="space-y-5">
                <SliderControl
                  label="Giriş termal gücü Q_in"
                  value={qInKW}
                  min={100}
                  max={1500}
                  step={10}
                  unit="kW"
                  icon={<Flame className="h-3.5 w-3.5" />}
                  onChange={setQInKW}
                />
                <SliderControl
                  label="Üst salamura sıcaklığı T_top"
                  value={tTop}
                  min={60}
                  max={80}
                  step={0.5}
                  digits={1}
                  unit="°C"
                  hint={tTop > TBT_SCALING_LIMIT ? "kışır riski" : undefined}
                  icon={<Thermometer className="h-3.5 w-3.5" />}
                  onChange={setTTop}
                />
                <SliderControl
                  label="Son kademe sıcaklığı T_last"
                  value={tLast}
                  min={35}
                  max={45}
                  step={0.5}
                  digits={1}
                  unit="°C"
                  icon={<Thermometer className="h-3.5 w-3.5" />}
                  onChange={setTLast}
                />
                <SliderControl
                  label="Ham deniz suyu debisi"
                  value={feedM3h}
                  min={2}
                  max={30}
                  step={0.5}
                  digits={1}
                  unit="m³/h"
                  hint={`öneri ${RECOMMENDED_FEED[stages]}`}
                  icon={<Droplets className="h-3.5 w-3.5" />}
                  onChange={setFeedM3h}
                />
              </div>
            </Panel>

            <Panel
              title="PV Alanı"
              icon={<Sun className="h-4 w-4" />}
              right={
                <span className={`font-mono text-xs ${mode === "day" ? "text-amber-300" : "text-slate-500"}`}>
                  {fmt(energy.pvKWe, 0)} kWe
                </span>
              }
            >
              <div className="space-y-5">
                <SliderControl
                  label="PV kurulu güç"
                  value={pvKWp}
                  min={200}
                  max={3000}
                  step={50}
                  unit="kWp"
                  icon={<Zap className="h-3.5 w-3.5" />}
                  onChange={setPvKWp}
                />
                <SliderControl
                  label="Işınım G"
                  value={irradiance}
                  min={100}
                  max={1100}
                  step={10}
                  unit="W/m²"
                  icon={<Sun className="h-3.5 w-3.5" />}
                  onChange={setIrradiance}
                  disabled={mode === "night"}
                  hint={mode === "night" ? "gece: PV = 0" : undefined}
                />
              </div>
            </Panel>

            <Panel
              title="Erimiş Tuz Deposu"
              icon={<Battery className="h-4 w-4" />}
              right={
                <button
                  type="button"
                  onClick={() => setSoc(0.65)}
                  className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200"
                >
                  Sıfırla
                </button>
              }
            >
              <SaltTank soc={soc} energy={energy} mode={mode} />
            </Panel>
          </div>

          {/* SAĞ AKIŞ ŞEMASI */}
          <div className="space-y-4 lg:col-span-8 xl:col-span-9">
            <Panel
              title="Enerji Zinciri"
              icon={<Zap className="h-4 w-4" />}
              right={
                <span
                  className={`rounded px-2 py-0.5 font-mono text-xs ${
                    medRunning ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"
                  }`}
                >
                  {medRunning ? (mode === "night" ? "MED KESİNTİSİZ · DEPODAN" : "MED ÇALIŞIYOR") : "MED DURDU"}
                </span>
              }
            >
              <EnergyFlow energy={energy} mode={mode} running={running} />
            </Panel>

            <Panel
              title={`MED Akış Şeması · ${stages} Kademe`}
              icon={<Layers className="h-4 w-4" />}
              right={
                <span className="font-mono text-xs text-slate-500">
                  ΣD {fmt(med.totalKgS, 3)} kg/s · h̄fg {fmt(med.hfgAvg, 0)} kJ/kg
                </span>
              }
            >
              <FlowStrip
                effects={med.effects}
                tTop={tTop}
                tLast={tLast}
                running={running && medRunning}
                condenserKW={med.condenserKW}
              />
              <div className={`mt-4 grid gap-3 ${compact ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-5" : "grid-cols-1 md:grid-cols-3"}`}>
                {med.effects.map((e) => (
                  <EffectCard
                    key={e.index}
                    effect={e}
                    frac={(e.tBrine - tLast) / Math.max(1e-6, tTop - tLast)}
                    compact={compact}
                    running={running && medRunning}
                  />
                ))}
              </div>
            </Panel>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
              <Panel title="Kademe Profili" icon={<Activity className="h-4 w-4" />} className="xl:col-span-3">
                <ProfileChart effects={med.effects} tTop={tTop} tLast={tLast} />
              </Panel>
              <Panel title="Alarmlar & Sınırlar" icon={<AlertTriangle className="h-4 w-4" />} className="xl:col-span-2">
                <AlarmList alarms={alarms} />
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs">
                  <dt className="text-slate-500">Besleme duyulur ısı</dt>
                  <dd className="text-right text-slate-300">{fmt(med.feedSensibleKW, 0)} kW</dd>
                  <dt className="text-slate-500">Kondenser yükü</dt>
                  <dd className="text-right text-slate-300">{fmt(med.condenserKW, 0)} kW</dd>
                  <dt className="text-slate-500">Soğutma suyu</dt>
                  <dd className="text-right text-slate-300">{fmt(med.coolingWaterM3h, 1)} m³/h</dd>
                  <dt className="text-slate-500">P₁ / P_N</dt>
                  <dd className="text-right text-slate-300">
                    {fmt(med.effects[0].pressureKPa, 1)} / {fmt(med.effects[med.effects.length - 1].pressureKPa, 1)} kPa
                  </dd>
                </dl>
              </Panel>
            </div>

            <Panel title="Hesap Bağıntıları" icon={<Flame className="h-4 w-4" />}>
              <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 font-mono text-xs text-slate-400 md:grid-cols-2">
                <li>ΔT = (T_top − T_last) / (N − 1)</li>
                <li>P_i = 10^(8.07131 − 1730.63 / (233.426 + T_v,i)) · 0.1333 kPa</li>
                <li>BPE = X·(B + C·X)·10⁻³ (El-Dessouky), T_v = T_b − BPE</li>
                <li>h_fg(T) = 2501 − 2.36·T kJ/kg</li>
                <li>D₁ = (Q_in − ṁ_f·c_p·ΔT) / h_fg(T₁)</li>
                <li>D_i = D_(i−1)·h_fg(T_(i−1))·η / h_fg(T_i), η = {ETA_TRANSFER}</li>
                <li>GOR = ΣD_i · h̄_fg / Q_in</li>
                <li>S_i = ṁ_f · 35 000 / (ṁ_f − ΣD_1..i) ppm</li>
              </ul>
            </Panel>
          </div>
        </div>
      </main>
    </div>
  );
}
