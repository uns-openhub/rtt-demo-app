import type { HrmProductionLine } from "../hrm-production-line.js";
import type { BatchSubmitRequest, BatchSubmitResponse, HrmBatch } from "../hrm-types.js";

const UNS_SAFE_ID = /^[A-Za-z0-9._-]+$/;
const REPEAT_STAGES = new Set(["furnace", "descaling", "rolling"]);

type ParseBatchSubmitResult =
  | { ok: true; value: BatchSubmitRequest }
  | { ok: false; error: string };

type GetBatchResult =
  | { ok: true; value: HrmBatch }
  | { ok: false; error: string };

type SubmitBatchResult =
  | { ok: true; statusCode: 201 | 422; value: BatchSubmitResponse }
  | { ok: false; error: string };

export function getBatchById(line: HrmProductionLine, batchId: string | null): GetBatchResult {
  if (!batchId) {
    return { ok: false, error: "Batch path not found" };
  }

  const batch = line.getBatch(batchId);
  if (!batch) {
    return { ok: false, error: `Batch '${batchId}' not found` };
  }

  return { ok: true, value: batch };
}

export function submitBatch(
  line: HrmProductionLine,
  body: Record<string, unknown> | undefined,
): SubmitBatchResult {
  const request = parseBatchSubmitRequest(body);
  if (!request.ok) {
    return request;
  }

  const result = line.submitBatch(request.value);
  return {
    ok: true,
    statusCode: result.status === "accepted" ? 201 : 422,
    value: result,
  };
}

function parseBatchSubmitRequest(body: Record<string, unknown> | undefined): ParseBatchSubmitResult {
  const recipeId = typeof body?.["recipeId"] === "string" ? body["recipeId"].trim() : "";
  const materialId = typeof body?.["materialId"] === "string" ? body["materialId"].trim() : "";
  const quantity = body?.["quantity"];
  const repeatStageRaw = typeof body?.["repeatStage"] === "string" ? body["repeatStage"].trim() : "";
  const repeatStage = repeatStageRaw ? repeatStageRaw.toLowerCase() : undefined;
  const mergeOutputMaterialId = typeof body?.["mergeOutputMaterialId"] === "string"
    ? body["mergeOutputMaterialId"].trim()
    : undefined;
  const mergeInputMaterialIds = Array.isArray(body?.["mergeInputMaterialIds"])
    ? body["mergeInputMaterialIds"].flatMap((item) => typeof item === "string" ? [item.trim()] : [])
    : undefined;
  if (
    !recipeId ||
    !materialId ||
    !UNS_SAFE_ID.test(materialId) ||
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    return { ok: false, error: "recipeId, materialId, and a positive numeric quantity are required; materialId may contain only letters, numbers, dot, underscore, and hyphen" };
  };
  if (repeatStage && !REPEAT_STAGES.has(repeatStage)) {
    return { ok: false, error: "repeatStage must be one of furnace, descaling, or rolling" };
  }
  if (mergeOutputMaterialId && !UNS_SAFE_ID.test(mergeOutputMaterialId)) {
    return { ok: false, error: "mergeOutputMaterialId may contain only letters, numbers, dot, underscore, and hyphen" };
  }
  if (mergeInputMaterialIds) {
    const invalidMergeInput = mergeInputMaterialIds.find((item) => !item || !UNS_SAFE_ID.test(item));
    if (invalidMergeInput) {
      return { ok: false, error: "mergeInputMaterialIds may contain only letters, numbers, dot, underscore, and hyphen" };
    }
  }
  if (mergeOutputMaterialId && (!mergeInputMaterialIds || mergeInputMaterialIds.length < 2)) {
    return { ok: false, error: "mergeInputMaterialIds with at least two materials is required when mergeOutputMaterialId is provided" };
  }

  const requestId = body?.['requestId'];
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(requestId))) return {ok: false, error: 'requestId must contain 1 to 100 letters, numbers, dot, underscore or hyphen'};
  const value: BatchSubmitRequest = {
    recipeId,
    materialId,
    quantity,
    ...(typeof requestId === 'string' ? {requestId} : {}),
  };
  if (repeatStage) {
    value.repeatStage = repeatStage as NonNullable<BatchSubmitRequest["repeatStage"]>;
  }
  if (mergeOutputMaterialId && mergeInputMaterialIds) {
    value.mergeOutputMaterialId = mergeOutputMaterialId;
    value.mergeInputMaterialIds = mergeInputMaterialIds;
  }

  return { ok: true, value };
}
