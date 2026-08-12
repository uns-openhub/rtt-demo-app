#!/usr/bin/env tsx
/**
 * Watch the HRM production line status in real time (refreshes every 2s).
 *
 * Usage:  pnpm run hrm:watch
 */
import {
  createAuthSession,
  createServiceTokenSession,
  hasConfiguredServiceToken,
  loadConfig,
  promptLine,
  promptPassword,
  type HrmAuthSession,
} from "./hrm-auth.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types mirrored from hrm-types.ts ─────────────────────────────────────────
interface ZoneState { zoneId: number; measuredTempC: number; heaterOn: boolean; gasConsumptionNm3h: number; measuredExhaustO2Pct: number }
interface FurnaceState { zones: ZoneState[]; slotMaterialIds: string[]; measuredMaterialTempC: number; measuredChamberTempC: number; measuredFurnacePressurePa: number; pusherPositionPct: number; pusherPushCount: number; pusherSlotIndex: number; pusherTotalSlots: number; pusherPaceMin: number; nextPushProgressPct: number; minutesToNextPush: number; totalFuelFlowNm3h: number; subState: string; soakingElapsedMin: number; soakingTargetMin: number }
interface FurnaceRecipeView { targetTempC: number; pusherPaceMin: number; soakingTimeMin: number }
interface RecipeView { id: string; furnace: FurnaceRecipeView }
interface DescalingState { measuredPressureBar: number; measuredHeaderPressureBar: number; measuredFlowM3h: number; measuredPumpSpeedRpm: number; measuredPumpCurrentA: number; measuredNozzleValveOpenPct: number; measuredWaterTempC: number; totalWaterConsumptionM3: number; measuredHydraulicOilLevelPct: number; measuredHydraulicOilTempC: number; subState: string; elapsedTicks: number; totalTicks: number }
interface RollingState { currentPass: number; totalPasses: number; direction: string; measuredSpeedMps: number; measuredThicknessMm: number; targetThicknessMm: number; measuredRollForcekN: number; measuredMotorPowerKw: number; measuredMotorCurrentA: number; measuredRollGapMm: number; measuredStandTorqueKnm: number; measuredHydraulicPressureBar: number; measuredLubricationFlowLpm: number; measuredBearingTempC: number; measuredVibrationMmS: number; subState: string }
interface WarehouseState { finalThicknessMm: number; finalTempC: number; hardnessHB: number; surfaceGrade: string; passFail: boolean }
interface FurnaceMaterialSummary { slot: number; materialId: string; soakingElapsedMin: number; subState: string; measuredMaterialTempC?: number }
interface StationStatus<T> { occupied: boolean; batchId: string | undefined; recipeId?: string | undefined; materialId?: string | undefined; furnaceMaterials?: FurnaceMaterialSummary[]; state: T | undefined }
interface StatusResponse {
  timestamp: string;
  stations: {
    furnace:   StationStatus<FurnaceState>;
    descaling: StationStatus<DescalingState>;
    rolling:   StationStatus<RollingState>;
    warehouse: StationStatus<WarehouseState>;
  };
  queue: Array<{ batchId: string; recipeId: string; materialId: string }>;
  completed: Array<{ batchId: string; completedAt: string; passFail: boolean }>;
}
interface RecipeMapResponse { recipes: RecipeView[] }

function loadRecipeMapFromConfig(): Map<string, RecipeView> {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../config.json"), "utf8")) as {
    hrm?: { recipes?: RecipeView[] };
  };
  return new Map((raw.hrm?.recipes ?? []).map((recipe) => [recipe.id, recipe]));
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
};

let _screenInitialized = false;
const clrScreen = () => {
  if (!_screenInitialized) {
    process.stdout.write("\x1b[2J"); // full clear + push to scrollback only on first render
    _screenInitialized = true;
  }
  process.stdout.write("\x1b[H"); // cursor to top-left, overwrite in place
};

/** Width of the visible content area between the box borders. */
const INNER = 104;

/** Strip ANSI escape codes and return the visible character count. */
const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Pad a (possibly ANSI-coloured) string to exactly `width` visible chars. */
const padVisible = (s: string, width: number) =>
  s + " ".repeat(Math.max(0, width - visibleLen(s)));

const boxTop    = (label: string) =>
  `  ${C.bold}┌─ ${label} ${"─".repeat(Math.max(0, INNER - label.length - 3))}┐${C.reset}`;
const boxBottom = () => `  └${"─".repeat(INNER)}┘`;
const boxRow    = (content: string) => `  │ ${padVisible(content, INNER - 2)} │`;

/** Write a line and erase any stale characters to the right of it. */
const println = (s = "") => process.stdout.write(s + "\x1b[K\n");

const bar = (filled: number, total: number, width = 20): string => {
  const n = Math.round((filled / Math.max(total, 1)) * width);
  return "[" + "█".repeat(n) + "░".repeat(width - n) + "]";
};
const fmt = (n: number | undefined | null, decimals = 1) =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(decimals) : "--";

function buildZoneCard(z: ZoneState): [string, string, string] {
  const heater = z.heaterOn ? `${C.yellow}ON${C.reset}` : `${C.dim}OFF${C.reset}`;
  const heaterLine = padVisible(`Heat ${heater}`, 25);
  return [
    `┌─ Z${z.zoneId} ${"─".repeat(22)}┐`,
    `│ ${padVisible(`${fmt(z.measuredTempC, 0)}C  O2 ${fmt(z.measuredExhaustO2Pct, 1)}%  Gas ${fmt(z.gasConsumptionNm3h, 0)}`, 25)} │`,
    `│ ${heaterLine} │`,
  ];
}

function buildZoneRows(zones: ZoneState[]): string[] {
  const pairs: ZoneState[][] = [];
  for (let i = 0; i < zones.length; i += 2) pairs.push(zones.slice(i, i + 2));

  const rows: string[] = [];
  for (const pair of pairs) {
    const cards = pair.map(buildZoneCard);
    for (let line = 0; line < 3; line += 1) {
      rows.push(`  ${cards.map((card) => card[line]).join("  ")}`);
    }
    rows.push(`  ${pair.map(() => `└${"─".repeat(27)}┘`).join("  ")}`);
  }
  return rows;
}

function slotLabel(materialId: string | undefined): string {
  if (!materialId) return "";
  const tail = materialId.split("-").pop() ?? materialId;
  return tail.slice(-3);
}

function buildFurnaceSlots(slotMaterialIds: string[], totalSlots: number): string[] {
  const slotCount = Math.max(1, totalSlots);
  const slotWidth = 7;
  const rows: string[] = [];
  rows.push(`  ${Array.from({ length: slotCount }, (_, idx) => `┌${"─".repeat(slotWidth)}┐`).join(" ")}`);
  rows.push(`  ${Array.from({ length: slotCount }, (_, idx) => `│${padVisible(`S${idx + 1}`, slotWidth)}│`).join(" ")}`);
  for (let charIndex = 0; charIndex < 3; charIndex += 1) {
    rows.push(`  ${Array.from({ length: slotCount }, (_, idx) => {
      const label = slotLabel(slotMaterialIds[idx]).padEnd(3, " ");
      const content = slotMaterialIds[idx] ? `${C.cyan}${label[charIndex]}${C.reset}` : " ";
      return `│${padVisible(content, slotWidth)}│`;
    }).join(" ")}`);
  }
  rows.push(`  ${Array.from({ length: slotCount }, () => `└${"─".repeat(slotWidth)}┘`).join(" ")}`);
  return rows;
}

function buildFurnaceMaterialRows(materials: FurnaceMaterialSummary[] | undefined): string[] {
  if (!materials || materials.length === 0) {
    return ["Materials:", "none"];
  }
  return [
    "Materials:",
    ...materials
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((item) => `S${item.slot}  ${C.cyan}${slotLabel(item.materialId)}${C.reset}  ${C.yellow}${fmt(item.measuredMaterialTempC)}C${C.reset}  ${item.subState}  Soak ${fmt(item.soakingElapsedMin, 1)} min`),
  ];
}

function combineColumns(left: string[], right: string[], leftWidth = 44, gap = 4): string[] {
  const totalRows = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let i = 0; i < totalRows; i += 1) {
    const leftCell = padVisible(left[i] ?? "", leftWidth);
    const rightCell = right[i] ?? "";
    rows.push(`  ${leftCell}${" ".repeat(gap)}${rightCell}`.trimEnd());
  }
  return rows;
}

function renderFurnace(s: StationStatus<FurnaceState>, recipeMap: Map<string, RecipeView>): string[] {
  if (!s.state) return [`  ${C.dim}○ IDLE${C.reset}`];
  const f = s.state;
  const recipe = s.recipeId ? recipeMap.get(s.recipeId) : undefined;
  const lines = [
    s.occupied
      ? `  ${C.green}● ${f.subState}${C.reset}  batch: ${C.cyan}${s.batchId?.slice(0, 8)}${C.reset}`
      : `  ${C.yellow}● HOT IDLE${C.reset}`,
    `  Chamber ${C.yellow}${fmt(f.measuredChamberTempC)}°C${C.reset}  P ${fmt(f.measuredFurnacePressurePa, 0)} Pa  Fuel ${fmt(f.totalFuelFlowNm3h)} Nm3/h`,
  ];
  lines.push(`  Pace runtime ${fmt(f.pusherPaceMin, 1)} min/push  Next push in ${fmt(f.minutesToNextPush, 1)} min  Actuator ${fmt(f.pusherPositionPct, 0)}%`);
  if (recipe) {
    lines.push(`  Recipe target pace ${fmt(recipe.furnace.pusherPaceMin, 1)} min/push  Soak target ${fmt(recipe.furnace.soakingTimeMin, 1)} min  Temp target ${fmt(recipe.furnace.targetTempC, 0)} C`);
  }
  lines.push(...combineColumns(
    ["Furnace slots:", ...buildFurnaceSlots(f.slotMaterialIds, f.pusherTotalSlots)],
    buildFurnaceMaterialRows(s.furnaceMaterials),
  ));
  lines.push("  Zones:");
  lines.push(...buildZoneRows(f.zones));
  return lines;
}

function renderDescaling(s: StationStatus<DescalingState>): string[] {
  if (!s.state) return [`  ${C.dim}○ IDLE${C.reset}`];
  const d = s.state;
  if (!s.occupied) {
    return [
      `  ${C.yellow}● IDLE${C.reset}  Pump ${fmt(d.measuredPressureBar)} bar ${fmt(d.measuredPumpSpeedRpm, 0)} rpm  ${fmt(d.measuredPumpCurrentA, 1)} A`,
      `  Water ${fmt(d.measuredFlowM3h)} m³/h  ${fmt(d.measuredWaterTempC)}°C  Header ${fmt(d.measuredHeaderPressureBar)} bar`,
      `  Oil ${fmt(d.measuredHydraulicOilLevelPct)}%  ${fmt(d.measuredHydraulicOilTempC)}°C  Valve ${fmt(d.measuredNozzleValveOpenPct)}%`,
    ];
  }
  return [
    `  ${C.green}● PROCESSING${C.reset}  batch: ${C.cyan}${s.batchId?.slice(0, 8)}${C.reset}`,
    `  ${bar(d.elapsedTicks, d.totalTicks)}  Pump ${fmt(d.measuredPressureBar)} bar ${fmt(d.measuredPumpSpeedRpm, 0)} rpm  ${fmt(d.measuredPumpCurrentA, 1)} A`,
    `  Water ${fmt(d.totalWaterConsumptionM3, 2)} m³  Flow ${fmt(d.measuredFlowM3h)} m³/h  ${fmt(d.measuredWaterTempC)}°C  Oil ${fmt(d.measuredHydraulicOilLevelPct)}%`,
  ];
}

function renderRolling(s: StationStatus<RollingState>): string[] {
  if (!s.state) return [`  ${C.dim}○ IDLE${C.reset}`];
  const r = s.state;
  if (!s.occupied) {
    return [
      `  ${C.yellow}● IDLE${C.reset}  Speed ${fmt(r.measuredSpeedMps)} m/s  Gap ${fmt(r.measuredRollGapMm)} mm  Hyd ${fmt(r.measuredHydraulicPressureBar)} bar`,
      `  Motor ${fmt(r.measuredMotorCurrentA, 1)} A  Lube ${fmt(r.measuredLubricationFlowLpm)} l/min  Bearing ${fmt(r.measuredBearingTempC)}°C`,
      `  Vib ${fmt(r.measuredVibrationMmS, 2)} mm/s  Torque ${fmt(r.measuredStandTorqueKnm, 0)} kNm  Pwr ${fmt(r.measuredMotorPowerKw, 0)} kW`,
    ];
  }
  const dir = r.direction === "forward" ? "→" : "←";
  return [
    `  ${C.green}● Pass ${r.currentPass}/${r.totalPasses}  ${dir} ${r.direction}${C.reset}  batch: ${C.cyan}${s.batchId?.slice(0, 8)}${C.reset}`,
    `  Thk ${fmt(r.measuredThicknessMm)} -> ${fmt(r.targetThicknessMm)} mm  Gap ${fmt(r.measuredRollGapMm)} mm  Speed ${fmt(r.measuredSpeedMps)} m/s`,
    `  Force ${fmt(r.measuredRollForcekN, 0)} kN  Torque ${fmt(r.measuredStandTorqueKnm, 0)} kNm  Hyd ${fmt(r.measuredHydraulicPressureBar)} bar  Pwr ${fmt(r.measuredMotorPowerKw, 0)} kW`,
  ];
}

function renderWarehouse(s: StationStatus<WarehouseState>): string[] {
  if (!s.occupied || !s.state) return [`  ${C.dim}○ IDLE${C.reset}`];
  const w = s.state;
  const pf = w.passFail ? `${C.green}✓ PASS${C.reset}` : `${C.red}✗ FAIL${C.reset}`;
  return [
    `  ${C.green}● QUALITY CHECK${C.reset}  batch: ${C.cyan}${s.batchId?.slice(0, 8)}${C.reset}`,
    `  ${pf}   Thickness: ${fmt(w.finalThicknessMm)} mm   Temp: ${fmt(w.finalTempC)}°C   Hardness: ${fmt(w.hardnessHB, 0)} HB   Surface: ${w.surfaceGrade}`,
  ];
}

function render(data: StatusResponse, recipeMap: Map<string, RecipeView>): void {
  const passed  = data.completed.filter(c => c.passFail).length;
  const failed  = data.completed.filter(c => !c.passFail).length;
  const ts = new Date(data.timestamp).toLocaleTimeString();

  // Header — title on left, timestamp (cyan) on right, padded to exactly INNER visible chars
  const title    = "HRM Production Line";
  const prefix   = `   ${title}`;           // 3 spaces + title
  const suffix   = `   `;                   // 3 trailing spaces after ts
  const midPad   = " ".repeat(Math.max(1, INNER - prefix.length - ts.length - suffix.length));

  clrScreen();
  println(`${C.bold}  ╔${"═".repeat(INNER)}╗`);
  println(`  ║${C.reset}${C.bold}${prefix}${midPad}${C.cyan}${ts}${C.reset}${C.bold}${suffix}║`);
  println(`  ╚${"═".repeat(INNER)}╝${C.reset}`);

  // maxRows: the tallest this station can ever be (SOAKING adds soak-bar row to furnace)
  const sections: Array<[string, string[], number]> = [
    ["FURNACE",   renderFurnace(data.stations.furnace, recipeMap),     25],
    ["DESCALING", renderDescaling(data.stations.descaling), 3],
    ["ROLLING",   renderRolling(data.stations.rolling),     3],
    ["WAREHOUSE", renderWarehouse(data.stations.warehouse), 2],
  ];

  for (const [label, lines, maxRows] of sections) {
    println(boxTop(label));
    // Pad to fixed height so shorter states don't leave stale rows from taller ones
    const padded = [...lines];
    while (padded.length < maxRows) padded.push("");
    for (const line of padded) println(boxRow(line));
    println(boxBottom());
  }

  const queueStr = data.queue.length === 0
    ? `${C.dim}empty${C.reset}`
    : data.queue.map(q => `${C.cyan}${q.batchId.slice(0, 8)}${C.reset}(${q.recipeId})`).join(", ");

  println(`  Queue:     ${data.queue.length} waiting — ${queueStr}`);
  println(`  Completed: ${data.completed.length} total  ${C.green}✓ ${passed} passed${C.reset}  ${failed > 0 ? C.red : C.dim}✗ ${failed} failed${C.reset}`);
  println();
  println(`  ${C.dim}Refreshing every 2s — Ctrl+C to exit${C.reset}`);
  process.stdout.write("\x1b[J"); // erase anything below the last line (safety net)
}

// ── Main ──────────────────────────────────────────────────────────────────────
const cfg = loadConfig();
const recipeMap = loadRecipeMapFromConfig();

console.log("\n  HRM — Watch Production Line");
console.log("  ──────────────────────────────────────────\n");

let auth: HrmAuthSession;
try {
  if (hasConfiguredServiceToken(cfg)) {
    console.log("  Using configured service token\n");
    auth = createServiceTokenSession(cfg);
  } else {
    const email = await promptLine("Email", cfg.defaultEmail);
    const password = await promptPassword("Password");
    auth = await createAuthSession(cfg.baseUrl, email, password);
  }
} catch (e) {
  console.error(`\n  ✗ ${(e as Error).message}`);
  process.exit(1);
}

const statusPath = `system/hrm/service/${cfg.processName}/status`;

const poll = async () => {
  try {
    const data = await auth.apiGet(statusPath) as Promise<StatusResponse>;
    render(data, recipeMap);
  } catch (e) {
    clrScreen();
    console.error(`\n  Error: ${(e as Error).message}\n`);
  }
};

await poll();
setInterval(poll, 2000);
