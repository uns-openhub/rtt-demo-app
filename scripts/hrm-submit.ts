#!/usr/bin/env tsx
/**
 * Submit a batch to the HRM production line.
 *
 * Usage:  pnpm run hrm:submit
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

function formatMaterialId(rawInput: string): string {
  const trimmed = rawInput.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return `slab-${String(numeric).padStart(3, "0")}`;
  }
  return trimmed || "slab-001";
}

function expandMaterialIds(baseMaterialId: string, quantity: number): string[] {
  const match = /^(.*?)(\d+)$/.exec(baseMaterialId);
  if (!match) {
    return Array.from({ length: quantity }, (_, index) => `${baseMaterialId}-${index + 1}`);
  }

  const [, prefix, digits] = match;
  const start = Number.parseInt(digits, 10);
  const width = digits.length;
  return Array.from({ length: quantity }, (_, index) => `${prefix}${String(start + index).padStart(width, "0")}`);
}

function parseRepeatStage(rawInput: string): "furnace" | "descaling" | "rolling" | undefined {
  const normalized = rawInput.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "no" || normalized === "n") return undefined;
  if (normalized === "furnace" || normalized === "pec" || normalized === "peč") return "furnace";
  if (normalized === "descaling") return "descaling";
  if (normalized === "rolling" || normalized === "valjanje") return "rolling";
  fail("Repeat stage must be none, furnace, descaling, or rolling");
}

function parseYes(rawInput: string): boolean {
  const normalized = rawInput.trim().toLowerCase();
  return normalized === "y" || normalized === "yes" || normalized === "da" || normalized === "d";
}

function fail(message: string): never {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

const cfg = loadConfig();

console.log("\n  HRM — Submit Batch");
console.log("  ──────────────────────────────────────────\n");

const auth: HrmAuthSession = await (async () => {
  try {
    if (hasConfiguredServiceToken(cfg)) {
      console.log("  Using configured service token\n");
      return createServiceTokenSession(cfg);
    }
    const email = await promptLine("Email", cfg.defaultEmail);
    const password = await promptPassword("Password");
    return await createAuthSession(cfg.baseUrl, email, password);
  } catch (e) {
    fail((e as Error).message);
  }
})();
console.log("  ✓ Authenticated\n");

// ── Batch details ─────────────────────────────────────────────────────────────
const recipeId   = await promptLine("Recipe ID",   "s355-20mm");
const materialId = formatMaterialId(await promptLine("Material No.", "1"));
const qtyStr     = await promptLine("Quantity",    "1");
const quantity   = Math.max(1, parseInt(qtyStr, 10) || 1);
const materialIds = expandMaterialIds(materialId, quantity);
const repeatStage = parseRepeatStage(await promptLine("Repeat stage (none/furnace/descaling/rolling)", "none"));
const mergeEnabled = materialIds.length >= 2
  ? parseYes(await promptLine("Merge submitted materials after rolling? (y/N)", "N"))
  : false;
const mergeOutputMaterialId = mergeEnabled
  ? formatMaterialId(await promptLine("Merged Material No.", `${materialIds[0]}-merged`))
  : undefined;

console.log(`\n  Submitting ${materialIds.length} batch${materialIds.length === 1 ? "" : "es"}…`);
if (repeatStage) {
  console.log(`  Repeat: ${repeatStage}`);
}
if (mergeOutputMaterialId) {
  console.log(`  Merge output: ${mergeOutputMaterialId}`);
}

const results: Array<Record<string, unknown>> = [];
for (const currentMaterialId of materialIds) {
  const result = await auth.apiPost(
    `system/hrm/service/${cfg.processName}/batch`,
    {
      recipeId,
      materialId: currentMaterialId,
      quantity: 1,
      ...(repeatStage ? { repeatStage } : {}),
      ...(mergeOutputMaterialId ? { mergeOutputMaterialId, mergeInputMaterialIds: materialIds } : {}),
    },
  ) as Record<string, unknown>;
  results.push(result);
}

const rejected = results.filter((result) => result["status"] !== "accepted");
if (rejected.length === 0) {
  console.log(`\n  ✓ ${results.length} batches accepted`);
  for (const result of results) {
    console.log(`    ${result["materialId"]}  ${result["batchId"]}`);
  }
  console.log(`\n  Run  pnpm run hrm:watch  to follow progress.\n`);
} else {
  console.log(`\n  ✗ ${rejected.length} batch submissions failed`);
  for (const result of rejected) {
    console.log(`    ${result["materialId"] ?? "unknown"}  ${result["reason"] ?? "unknown reason"}`);
  }
}
