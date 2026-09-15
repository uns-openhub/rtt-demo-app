import { randomUUID } from "crypto";
import { logger } from "@uns-kit/core";
import type {
  HrmConfig, HrmBatch, BatchStage, Recipe, QualitySpec,
  BatchSubmitRequest, BatchSubmitResponse,
  ProductionLineStateResponse, FurnacePhysicsState,
  DescalingPhysicsState, RollingPhysicsState, WarehousePhysicsState,
  HrmRuntimeConfigResponse, HrmRepeatStage,
} from "./hrm-types.js";
import type { AlarmEvent, IHrmTransport } from "./hrm-publisher.js";
import { buildActiveFurnaceZones, tickFurnaceBatchPhysics, tickIdleFurnace } from "./hrm-station-furnace.js";
import { tickDescaling, tickIdleDescaling } from "./hrm-station-descaling.js";
import { tickIdleRolling, tickRolling } from "./hrm-station-rolling.js";
import { runQualityCheck } from "./hrm-station-warehouse.js";

const DEFAULT_QUEUE_ASSET = {
  assetId: "hrm-queue",
  description: "Čakalna vrsta proizvodnje",
} as const;
const AMBIENT_TEMP_C = 20;

export class HrmProductionLine {
  private readonly config: HrmConfig;
  private readonly transports: IHrmTransport[];
  private readonly tickMs: number;
  private readonly effectiveTickMs: number;
  private readonly simulationStartTimeIso: string;
  private readonly realtimeClock: boolean;
  private currentSimulationTimeMs: number;

  private readonly batches = new Map<string, HrmBatch>();
  private readonly queue: string[] = [];
  private readonly completed: Array<{ batchId: string; completedAt: string; passFail: boolean }> = [];
  private furnaceState: FurnacePhysicsState | undefined;
  private descalingState: DescalingPhysicsState | undefined;
  private rollingState: RollingPhysicsState | undefined;
  private readonly pendingMerges = new Map<string, { outputMaterialId: string; inputMaterialIds: string[]; batchIds: string[] }>();
  private readonly furnaceSlotBatchIds: Array<string | undefined> = Array.from({ length: 5 }, () => undefined);
  private furnacePaceElapsedMin = 0;
  private furnaceTotalFuelConsumptionNm3 = 0;
  private furnaceTotalPusherPushCount = 0;

  // One batch per station at a time
  private descalingBatchId: string | undefined;
  private rollingBatchId: string | undefined;
  private warehouseBatchId: string | undefined;

  // Track last seen rolling pass to detect pass completions between ticks
  private rollingPrevPass = 0;
  private readonly activeFurnaceAlarms = new Set<string>();
  private furnaceIdleStep = 0;
  private descalingIdleStep = 0;
  private rollingIdleStep = 0;

  constructor(config: HrmConfig, transports: IHrmTransport[]) {
    this.config = config;
    this.transports = transports;
    const tickMs = config.tickIntervalMs ?? 2000;
    const speed = config.simulationSpeed ?? 1;
    const configuredStartTimeMs = config.simulationStartTime ? Date.parse(config.simulationStartTime) : Number.NaN;
    this.realtimeClock = !Number.isFinite(configuredStartTimeMs);
    const simulationStartTimeMs = this.realtimeClock ? Date.now() : configuredStartTimeMs;
    this.tickMs = tickMs;
    this.effectiveTickMs = tickMs * speed;
    this.currentSimulationTimeMs = simulationStartTimeMs;
    this.simulationStartTimeIso = new Date(simulationStartTimeMs).toISOString();
    this.furnaceState = tickIdleFurnace(undefined, this.config.productionLine.furnace, this.effectiveTickMs, this.furnaceIdleStep);
    this.applyFurnaceCounterValues(this.furnaceState);
    this.descalingState = tickIdleDescaling(undefined, this.config.productionLine.descaling, this.effectiveTickMs, this.descalingIdleStep);
    this.rollingState = tickIdleRolling(undefined, this.config.productionLine.rollingStand, this.effectiveTickMs, this.rollingIdleStep);
  }

  submitBatch(req: BatchSubmitRequest): BatchSubmitResponse {
    const recipe = this.config.recipes.find((r) => r.id === req.recipeId);
    if (!recipe) {
      return {
        batchId: "",
        recipeId: req.recipeId,
        materialId: req.materialId,
        quantity: req.quantity,
        status: "rejected",
        reason: `Recipe '${req.recipeId}' not found`,
        submittedAt: this.currentSimulationIso(),
      };
    }

    const batchId = randomUUID();
    const now = this.currentSimulationIso();
    const batch: HrmBatch = {
      batchId,
      recipeId: req.recipeId,
      materialId: req.materialId,
      quantity: req.quantity,
      stage: "QUEUED",
      createdAt: now,
      stageEnteredAt: now,
      ticksInStage: 0,
      recipe: this.cloneRecipe(recipe),
      measured: {
        rollingSpeedSumMps: 0,
        rollingSpeedSamples: 0,
      },
      ...(req.repeatStage ? { repeatStage: req.repeatStage, repeatRemaining: 1 } : {}),
      ...(req.mergeOutputMaterialId && req.mergeInputMaterialIds?.length
        ? {
            mergeGroupId: this.mergeGroupId(req.mergeOutputMaterialId, req.mergeInputMaterialIds),
            mergeInputMaterialIds: [...req.mergeInputMaterialIds],
            mergeOutputMaterialId: req.mergeOutputMaterialId,
          }
        : {}),
    };

    this.batches.set(batchId, batch);
    this.queue.push(batchId);
    logger.info(`HRM: Batch ${batchId} queued (recipe=${req.recipeId}, material=${req.materialId})`);
    const queueAsset = this.getQueueAsset();
    this.emitMaterialTransition(queueAsset.assetId, queueAsset.description, batch, "ENTERED", now);
    this.emitMaterialStatus(queueAsset.assetId, queueAsset.description, batch, now);

    return {
      batchId,
      recipeId: req.recipeId,
      materialId: req.materialId,
      quantity: req.quantity,
      status: "accepted",
      submittedAt: now,
      ...(req.repeatStage ? { repeatStage: req.repeatStage } : {}),
      ...(req.mergeOutputMaterialId && req.mergeInputMaterialIds?.length
        ? { mergeOutputMaterialId: req.mergeOutputMaterialId, mergeInputMaterialIds: [...req.mergeInputMaterialIds] }
        : {}),
    };
  }

  tick(step: number): void {
    this.advanceSimulationTime();
    this.tickQueuedBatches();

    // Tick each occupied station
    this.tickFurnaceStation(step);
    this.tickDescalingStation();
    this.tickRollingStation(step);
    this.tickWarehouseStation(step);

    // Publish telemetry for all active batches
    this.publishTelemetry(step);
  }

  getState(): ProductionLineStateResponse {
    const furnaceBatchId = this.furnaceLeadBatchId();
    const furnaceBatch = furnaceBatchId ? this.batches.get(furnaceBatchId) : undefined;
    const descalingBatch = this.descalingBatchId ? this.batches.get(this.descalingBatchId) : undefined;
    const rollingBatch = this.rollingBatchId ? this.batches.get(this.rollingBatchId) : undefined;
    const warehouseBatch = this.warehouseBatchId ? this.batches.get(this.warehouseBatchId) : undefined;

    return {
      timestamp: this.currentSimulationIso(),
      stations: {
        furnace: {
          occupied: this.furnaceSlotBatchIds.some(Boolean),
          batchId: furnaceBatchId,
          recipeId: furnaceBatch?.recipeId,
          materialId: furnaceBatch?.materialId,
          furnaceMaterials: this.furnaceSlotBatchIds.flatMap((batchId, index) => {
            if (!batchId) return [];
            const batch = this.batches.get(batchId);
            if (!batch?.furnace) return [];
            return [{
              slot: index + 1,
              batchId: batch.batchId,
              recipeId: batch.recipeId,
              materialId: batch.materialId,
              soakingElapsedMin: batch.furnace.soakingElapsedMin,
              subState: batch.furnace.subState,
              measuredMaterialTempC: batch.furnace.measuredMaterialTempC,
            }];
          }),
          state: furnaceBatch?.furnace ?? this.furnaceState,
        },
        descaling: {
          occupied: !!this.descalingBatchId,
          batchId: this.descalingBatchId,
          recipeId: descalingBatch?.recipeId,
          materialId: descalingBatch?.materialId,
          state: descalingBatch?.descaling ?? this.descalingState,
        },
        rolling: {
          occupied: !!this.rollingBatchId,
          batchId: this.rollingBatchId,
          recipeId: rollingBatch?.recipeId,
          materialId: rollingBatch?.materialId,
          state: rollingBatch?.rolling ?? this.rollingState,
        },
        warehouse: {
          occupied: !!this.warehouseBatchId,
          batchId: this.warehouseBatchId,
          recipeId: warehouseBatch?.recipeId,
          materialId: warehouseBatch?.materialId,
          state: warehouseBatch?.warehouse,
        },
      },
      queue: this.queue.map((id) => {
        const b = this.batches.get(id)!;
        return { batchId: id, recipeId: b.recipeId, materialId: b.materialId };
      }),
      completed: [...this.completed],
    };
  }

  getBatch(batchId: string): HrmBatch | undefined {
    return this.batches.get(batchId);
  }

  getRuntimeConfig(): HrmRuntimeConfigResponse {
    const tickIntervalMs = this.config.tickIntervalMs ?? 2000;
    const simulationSpeed = this.config.simulationSpeed ?? 1;
    const simulationResolution = this.config.simulationResolution ?? 100;
    const skipFactor = Math.max(1, Math.round(100 / simulationResolution));
    return {
      topicBase: this.config.topicBase,
      tickIntervalMs,
      simulationStartTime: this.simulationStartTimeIso,
      currentSimulationTime: this.currentSimulationIso(),
      simulationSpeed,
      simulationResolution,
      skipFactor,
      telemetryIntervalMs: tickIntervalMs * skipFactor,
      effectiveTickMs: this.effectiveTickMs,
    };
  }

  private cloneRecipe(recipe: Recipe): Recipe {
    return structuredClone(recipe);
  }

  getRecipes(): Recipe[] {
    return this.config.recipes.map((recipe) => this.cloneRecipe(recipe));
  }

  getRecipe(recipeId: string): Recipe | undefined {
    const recipe = this.config.recipes.find((item) => item.id === recipeId);
    return recipe ? this.cloneRecipe(recipe) : undefined;
  }

  updateRecipe(
    recipeId: string,
    patch: {
      targetTempC?: number;
      pusherPaceMin?: number;
      stoichiometricRatioTarget?: number;
      soakingTimeMin?: number;
      zones?: Array<{ zoneId: number; setpointC: number }>;
    },
  ): Recipe | undefined {
    const recipe = this.config.recipes.find((item) => item.id === recipeId);
    if (!recipe) return undefined;

    if (patch.targetTempC != null) recipe.furnace.targetTempC = patch.targetTempC;
    if (patch.pusherPaceMin != null) recipe.furnace.pusherPaceMin = patch.pusherPaceMin;
    if (patch.stoichiometricRatioTarget != null) recipe.furnace.stoichiometricRatioTarget = patch.stoichiometricRatioTarget;
    if (patch.soakingTimeMin != null) recipe.furnace.soakingTimeMin = patch.soakingTimeMin;
    if (patch.zones != null) recipe.furnace.zones = patch.zones.map((zone) => ({ ...zone }));

    for (const batchId of this.furnaceSlotBatchIds) {
      const activeBatch = batchId ? this.batches.get(batchId) : undefined;
      if (activeBatch?.recipe.id === recipeId) {
        activeBatch.recipe = this.cloneRecipe(recipe);
      }
      if (activeBatch?.recipe.id === recipeId && activeBatch.furnace) {
        activeBatch.furnace.soakingTargetMin = activeBatch.recipe.furnace.soakingTimeMin;
      }
    }

    return this.cloneRecipe(recipe);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private tickFurnaceStation(step: number): void {
    const occupiedSlotIndices = this.furnaceSlotBatchIds
      .map((batchId, index) => (batchId ? index : -1))
      .filter((index) => index >= 0);
    const hasQueuedCharge = this.queue.length > 0;

    if (occupiedSlotIndices.length === 0 && !hasQueuedCharge) {
      this.furnaceIdleStep += 1;
      this.furnaceState = tickIdleFurnace(this.furnaceState, this.config.productionLine.furnace, this.effectiveTickMs, this.furnaceIdleStep);
      this.furnaceState.slotMaterialIds = Array.from({ length: 5 }, () => "");
      this.furnacePaceElapsedMin = 0;
      this.advanceFurnaceConsumptionCounter(this.furnaceState);
      return;
    }

    if (occupiedSlotIndices.length === 0) {
      this.chargeQueueToFurnaceSlot1();
      this.furnacePaceElapsedMin = 0;
      this.furnaceIdleStep += 1;
      this.furnaceState = tickIdleFurnace(this.furnaceState, this.config.productionLine.furnace, this.effectiveTickMs, this.furnaceIdleStep);
      this.furnaceState.slotMaterialIds = this.currentFurnaceMaterialIds();
    }

    const leadBatchId = this.furnaceLeadBatchId() ?? this.queue[0];
    if (!leadBatchId) return;
    const leadBatch = this.batches.get(leadBatchId)!;
    const leadSlotIndex = occupiedSlotIndices.length > 0 ? Math.max(...occupiedSlotIndices) : -1;
    this.furnacePaceElapsedMin += this.effectiveTickMs / 60_000;

    const safePaceMin = Math.max(leadBatch.recipe.furnace.pusherPaceMin, 0.001);
    const dischargeBlocked = Boolean(this.furnaceSlotBatchIds[4] && (this.descalingBatchId || this.rollingBatchId));
    const pushDue = this.furnacePaceElapsedMin >= safePaceMin;
    const canPush = pushDue && !dischargeBlocked;
    const nextPushProgressPct = pushDue
      ? 100
      : Number(Math.max(0, Math.min(100, (this.furnacePaceElapsedMin / safePaceMin) * 100)).toFixed(1));
    const minutesToNextPush = pushDue ? 0 : Number((safePaceMin - this.furnacePaceElapsedMin).toFixed(2));
    const pusherPositionPct = canPush ? 100 : 0;
    const projectedPushCount = this.furnaceSlotBatchIds.filter(Boolean).length > 0
      ? Math.min(5, leadSlotIndex + (canPush ? 1 : 0))
      : 0;
    const zones = buildActiveFurnaceZones(
      this.furnaceState,
      leadBatch.recipe.furnace,
      this.config.productionLine.furnace,
      this.effectiveTickMs,
      step,
    );

    for (const slotIndex of occupiedSlotIndices) {
      const batchId = this.furnaceSlotBatchIds[slotIndex]!;
      const batch = this.batches.get(batchId)!;
      if (this.furnaceState && !batch.furnace) {
        batch.furnace = {
          ...this.furnaceState,
          slotMaterialIds: this.currentFurnaceMaterialIds(),
          actualMaterialTempC: AMBIENT_TEMP_C,
          measuredMaterialTempC: AMBIENT_TEMP_C,
          subState: "HEATING",
          soakingElapsedMin: 0,
          soakingTargetMin: batch.recipe.furnace.soakingTimeMin,
        };
      }
      batch.furnace = tickFurnaceBatchPhysics(
        batch,
        batch.furnace,
        zones,
        this.effectiveTickMs,
        slotIndex + 1,
        safePaceMin,
        projectedPushCount,
        nextPushProgressPct,
        minutesToNextPush,
        pusherPositionPct,
      );
      batch.furnace.slotMaterialIds = this.currentFurnaceMaterialIds();
      batch.ticksInStage++;
    }

    const currentLeadBatchId = this.furnaceLeadBatchId();
    const currentLeadBatch = currentLeadBatchId ? this.batches.get(currentLeadBatchId) : undefined;
    this.furnaceState = currentLeadBatch?.furnace ?? this.furnaceState;
    if (this.furnaceState) {
      this.furnaceState.slotMaterialIds = this.currentFurnaceMaterialIds();
      this.furnaceState.pusherPaceMin = Number(safePaceMin.toFixed(2));
      this.furnaceState.nextPushProgressPct = nextPushProgressPct;
      this.furnaceState.minutesToNextPush = minutesToNextPush;
      this.furnaceState.pusherPositionPct = pusherPositionPct;
      this.advanceFurnaceConsumptionCounter(this.furnaceState);
    }
    if (currentLeadBatch) {
      this.syncFurnaceZoneAlarms(currentLeadBatch, this.currentSimulationIso());
    }

    if (canPush) {
      this.performFurnacePush();
      this.furnacePaceElapsedMin = 0;
    }
  }

  private tickDescalingStation(): void {
    if (!this.descalingBatchId) {
      this.descalingIdleStep += 1;
      this.descalingState = tickIdleDescaling(this.descalingState, this.config.productionLine.descaling, this.effectiveTickMs, this.descalingIdleStep);
      return;
    }
    const batch = this.batches.get(this.descalingBatchId)!;
    const { state, done } = tickDescaling(batch, this.config.productionLine.descaling, this.effectiveTickMs);
    batch.descaling = state;
    this.descalingState = state;
    batch.ticksInStage++;

    if (done) {
      logger.info(`HRM: Batch ${batch.batchId} DESCALING complete`);
      if (!this.rollingBatchId) {
        const exitedDescalingAt = this.currentSimulationIso();
        const durationMin = (batch.ticksInStage * this.effectiveTickMs) / 60_000;
        const descalingExitTempC = this.estimateDescalingExitTemp(batch, durationMin);
        if (descalingExitTempC != null) {
          batch.measured.descalingExitTempC = descalingExitTempC;
          batch.measured.rollingEntryTempC = descalingExitTempC;
        }
        this.descalingBatchId = undefined;
        this.emitMaterialTransition(
          this.config.productionLine.descaling.assetId, this.config.productionLine.descaling.description,
          batch, "EXITED", exitedDescalingAt, durationMin,
        );
        this.emitAssetMaterialOccupancy(
          this.config.productionLine.descaling.assetId,
          this.config.productionLine.descaling.description,
          undefined,
          exitedDescalingAt,
        );
        if (this.consumeRepeat(batch, "descaling")) {
          delete batch.descaling;
          this.moveToStage(batch.batchId, "DESCALING", exitedDescalingAt);
          this.descalingBatchId = batch.batchId;
          logger.info(`HRM: Batch ${batch.batchId} repeating DESCALING`);
          this.emitMaterialTransition(
            this.config.productionLine.descaling.assetId,
            this.config.productionLine.descaling.description,
            batch,
            "ENTERED",
            batch.stageEnteredAt,
          );
          this.emitAssetMaterialOccupancy(
            this.config.productionLine.descaling.assetId,
            this.config.productionLine.descaling.description,
            batch,
            exitedDescalingAt,
          );
          this.emitMaterialStatus(
            this.config.productionLine.descaling.assetId,
            this.config.productionLine.descaling.description,
            batch,
            exitedDescalingAt,
          );
          return;
        }
        this.moveToStage(batch.batchId, "ROLLING", exitedDescalingAt);
        this.rollingBatchId = batch.batchId;
        this.rollingPrevPass = 0;
        logger.info(`HRM: Batch ${batch.batchId} entered ROLLING`);
        this.emitMaterialTransition(
          this.config.productionLine.rollingStand.assetId, this.config.productionLine.rollingStand.description,
          batch, "ENTERED", batch.stageEnteredAt,
        );
        this.emitAssetMaterialOccupancy(
          this.config.productionLine.rollingStand.assetId,
          this.config.productionLine.rollingStand.description,
          batch,
          exitedDescalingAt,
        );
        this.emitMaterialStatus(
          this.config.productionLine.rollingStand.assetId,
          this.config.productionLine.rollingStand.description,
          batch,
          exitedDescalingAt,
        );
      }
    }
  }

  private tickRollingStation(step: number): void {
    if (!this.rollingBatchId) {
      this.rollingIdleStep += 1;
      this.rollingState = tickIdleRolling(this.rollingState, this.config.productionLine.rollingStand, this.effectiveTickMs, this.rollingIdleStep);
      return;
    }
    const batch = this.batches.get(this.rollingBatchId)!;
    const { state, done } = tickRolling(batch, this.config.productionLine.rollingStand, this.effectiveTickMs);
    const now = this.currentSimulationIso();
    batch.rolling = state;
    this.rollingState = state;
    batch.ticksInStage++;
    batch.measured.rollingSpeedSumMps += state.measuredSpeedMps;
    batch.measured.rollingSpeedSamples += 1;

    // Detect pass advancement: when currentPass increases, the previous pass just completed.
    const currentPass = state.currentPass;
    if (currentPass > this.rollingPrevPass && this.rollingPrevPass > 0) {
      this.emitCompletedPass(batch, this.rollingPrevPass, now);
    }
    // When rolling is fully done, the final pass completes (currentPass didn't advance, done fired).
    if (done) {
      this.emitCompletedPass(batch, currentPass, now);
    }
    this.rollingPrevPass = currentPass;

    if (done) {
      logger.info(`HRM: Batch ${batch.batchId} ROLLING complete`);
      if (!this.warehouseBatchId) {
        const exitedRollingAt = this.currentSimulationIso();
        const durationMin = (batch.ticksInStage * this.effectiveTickMs) / 60_000;
        this.captureRollingMeasurements(batch, durationMin);
        this.rollingBatchId = undefined;
        this.emitMaterialTransition(
          this.config.productionLine.rollingStand.assetId, this.config.productionLine.rollingStand.description,
          batch, "EXITED", exitedRollingAt, durationMin,
        );
        this.emitAssetMaterialOccupancy(
          this.config.productionLine.rollingStand.assetId,
          this.config.productionLine.rollingStand.description,
          undefined,
          exitedRollingAt,
        );
        if (this.consumeRepeat(batch, "rolling")) {
          delete batch.rolling;
          this.resetRollingMeasurements(batch);
          this.moveToStage(batch.batchId, "ROLLING", exitedRollingAt);
          this.rollingBatchId = batch.batchId;
          this.rollingPrevPass = 0;
          logger.info(`HRM: Batch ${batch.batchId} repeating ROLLING`);
          this.emitMaterialTransition(
            this.config.productionLine.rollingStand.assetId,
            this.config.productionLine.rollingStand.description,
            batch,
            "ENTERED",
            batch.stageEnteredAt,
          );
          this.emitAssetMaterialOccupancy(
            this.config.productionLine.rollingStand.assetId,
            this.config.productionLine.rollingStand.description,
            batch,
            exitedRollingAt,
          );
          this.emitMaterialStatus(
            this.config.productionLine.rollingStand.assetId,
            this.config.productionLine.rollingStand.description,
            batch,
            exitedRollingAt,
          );
          return;
        }
        const mergedBatch = this.consumeRollingMergeInput(batch, exitedRollingAt);
        if (mergedBatch) {
          this.enterWarehouse(mergedBatch, exitedRollingAt, step);
          return;
        }
        if (batch.mergeGroupId) {
          return;
        }
        this.enterWarehouse(batch, exitedRollingAt, step);
      }
    }
  }

  private enterWarehouse(batch: HrmBatch, time: string, step: number): void {
    this.moveToStage(batch.batchId, "WAREHOUSE", time);
    this.warehouseBatchId = batch.batchId;
    if (!batch.warehouse) {
      const spec = this.findQualitySpec(batch.recipe);
      if (spec) {
        batch.warehouse = runQualityCheck(batch, spec, step);
      }
    }
    if (batch.warehouse) {
      this.emitWarehouseFacts(batch, batch.stageEnteredAt);
    }
    logger.info(`HRM: Batch ${batch.batchId} entered WAREHOUSE`);
    this.emitMaterialTransition(
      this.config.productionLine.warehouse.assetId,
      this.config.productionLine.warehouse.description,
      batch,
      "ENTERED",
      batch.stageEnteredAt,
    );
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.warehouse.assetId,
      this.config.productionLine.warehouse.description,
      batch,
      time,
    );
    this.emitMaterialStatus(
      this.config.productionLine.warehouse.assetId,
      this.config.productionLine.warehouse.description,
      batch,
      time,
    );
  }

  private consumeRepeat(batch: HrmBatch, stage: HrmRepeatStage): boolean {
    if (batch.repeatStage !== stage || (batch.repeatRemaining ?? 0) <= 0) {
      return false;
    }
    batch.repeatRemaining = (batch.repeatRemaining ?? 0) - 1;
    return true;
  }

  private consumeRollingMergeInput(batch: HrmBatch, time: string): HrmBatch | undefined {
    if (!batch.mergeGroupId || !batch.mergeOutputMaterialId || !batch.mergeInputMaterialIds?.length) {
      return undefined;
    }

    const pending = this.pendingMerges.get(batch.mergeGroupId) ?? {
      outputMaterialId: batch.mergeOutputMaterialId,
      inputMaterialIds: [...batch.mergeInputMaterialIds],
      batchIds: [],
    };
    if (!pending.batchIds.includes(batch.batchId)) {
      pending.batchIds.push(batch.batchId);
    }
    batch.mergeConsumedAt = time;
    this.pendingMerges.set(batch.mergeGroupId, pending);

    logger.info(
      `HRM: Batch ${batch.batchId} ready for merge ${batch.mergeGroupId} (${pending.batchIds.length}/${pending.inputMaterialIds.length})`,
    );

    if (pending.batchIds.length < pending.inputMaterialIds.length) {
      return undefined;
    }

    this.pendingMerges.delete(batch.mergeGroupId);
    const inputBatches = pending.batchIds.flatMap((batchId) => {
      const inputBatch = this.batches.get(batchId);
      return inputBatch ? [inputBatch] : [];
    });
    const template = inputBatches[inputBatches.length - 1] ?? batch;
    const outputBatch: HrmBatch = {
      batchId: randomUUID(),
      recipeId: template.recipeId,
      materialId: pending.outputMaterialId,
      quantity: 1,
      stage: "WAREHOUSE",
      createdAt: time,
      stageEnteredAt: time,
      ticksInStage: 0,
      recipe: this.cloneRecipe(template.recipe),
      measured: this.mergeMeasuredState(inputBatches.length ? inputBatches : [batch]),
      mergeGroupId: batch.mergeGroupId,
      mergeInputMaterialIds: [...pending.inputMaterialIds],
      mergeOutputMaterialId: pending.outputMaterialId,
      previousMaterialObjectIds: pending.inputMaterialIds.map((materialId) => this.rollingMaterialObjectId(materialId)),
    };
    this.batches.set(outputBatch.batchId, outputBatch);
    logger.info(
      `HRM: Merge ${batch.mergeGroupId} created ${outputBatch.materialId} from ${pending.inputMaterialIds.join(", ")}`,
    );
    return outputBatch;
  }

  private mergeMeasuredState(inputBatches: HrmBatch[]): HrmBatch["measured"] {
    const latest = inputBatches[inputBatches.length - 1];
    if (!latest) {
      return {
        rollingSpeedSumMps: 0,
        rollingSpeedSamples: 0,
      };
    }
    const average = (selector: (batch: HrmBatch) => number | undefined): number | undefined => {
      const values = inputBatches.flatMap((batch) => {
        const value = selector(batch);
        return typeof value === "number" && Number.isFinite(value) ? [value] : [];
      });
      if (values.length === 0) return undefined;
      return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
    };

    const measured: HrmBatch["measured"] = {
      ...latest.measured,
      rollingSpeedSumMps: 0,
      rollingSpeedSamples: 0,
    };
    const averagedFields = {
      furnaceExitTempC: average((batch) => batch.measured.furnaceExitTempC),
      descalingExitTempC: average((batch) => batch.measured.descalingExitTempC),
      rollingEntryTempC: average((batch) => batch.measured.rollingEntryTempC),
      rollingExitTempC: average((batch) => batch.measured.rollingExitTempC),
      finalThicknessMm: average((batch) => batch.measured.finalThicknessMm),
      averageRollingSpeedMps: average((batch) => batch.measured.averageRollingSpeedMps),
    };
    for (const [key, value] of Object.entries(averagedFields)) {
      if (value !== undefined) {
        (measured as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return measured;
  }

  private resetRollingMeasurements(batch: HrmBatch): void {
    batch.measured.rollingSpeedSumMps = 0;
    batch.measured.rollingSpeedSamples = 0;
  }

  private rollingMaterialObjectId(materialId: string): string {
    return `${materialId}-2`;
  }

  private mergeGroupId(outputMaterialId: string, inputMaterialIds: string[]): string {
    return `${outputMaterialId}:${inputMaterialIds.join("+")}`;
  }

  /** Emit a pass-complete event for the given 1-based pass number. */
  private emitCompletedPass(batch: HrmBatch, passNumber: number, time: string): void {
    const passes = batch.recipe.rollingPlan.passes;
    const passIdx = passNumber - 1;
    const pass = passes[passIdx];
    if (!pass) return;
    const prevPass = passIdx > 0 ? passes[passIdx - 1] : null;
    const startThicknessMm = prevPass?.targetThicknessMm ?? batch.recipe.initialThicknessMm;
    this.emitPassComplete(batch, {
      passNumber,
      direction: pass.direction,
      startThicknessMm,
      endThicknessMm: pass.targetThicknessMm,
      // Effective process duration from recipe config (realistic, not wall-clock)
      durationSec: this.config.productionLine.rollingStand.durationMinPerPass * 60,
    }, time);
  }

  private tickWarehouseStation(step: number): void {
    if (!this.warehouseBatchId) return;
    const batch = this.batches.get(this.warehouseBatchId)!;

    // Quality check runs on first tick in warehouse
    if (!batch.warehouse) {
      const spec = this.findQualitySpec(batch.recipe);
      if (spec) {
        batch.warehouse = runQualityCheck(batch, spec, step);
      }
    }

    batch.ticksInStage++;

    // After a short dwell, finalize as DONE or FAILED based on quality outcome
    if (batch.ticksInStage >= 5) {
      const passFail = batch.warehouse?.passFail ?? false;
      const completedAt = this.currentSimulationIso();
      const durationMin = (batch.ticksInStage * this.effectiveTickMs) / 60_000;
      const finalStage: BatchStage = passFail ? "DONE" : "FAILED";
      logger.info(`HRM: Batch ${batch.batchId} ${finalStage} — passFail=${passFail}`);
      this.warehouseBatchId = undefined;
      this.moveToStage(batch.batchId, finalStage, completedAt);
      this.completed.push({ batchId: batch.batchId, completedAt, passFail });
      if (this.completed.length > 100) this.completed.shift();
      this.emitMaterialTransition(
        this.config.productionLine.warehouse.assetId, this.config.productionLine.warehouse.description,
        batch, "EXITED", completedAt, durationMin,
      );
      this.emitAssetMaterialOccupancy(
        this.config.productionLine.warehouse.assetId,
        this.config.productionLine.warehouse.description,
        undefined,
        completedAt,
      );
      this.emitMaterialStatus(
        this.config.productionLine.warehouse.assetId,
        this.config.productionLine.warehouse.description,
        batch,
        completedAt,
      );
    }
  }

  /** Fire-and-forget wrapper — transport errors never crash the simulation loop. */
  private emit(fn: () => Promise<void>): void {
    fn().catch((e) => logger.error(`HRM: transport event error: ${e}`));
  }

  private getQueueAsset(): { assetId: string; description: string } {
    return this.config.productionLine.queue ?? DEFAULT_QUEUE_ASSET;
  }

  private tickQueuedBatches(): void {
    for (const batchId of this.queue) {
      const batch = this.batches.get(batchId);
      if (batch) {
        batch.ticksInStage++;
      }
    }
  }

  private emitMaterialTransition(
    assetId: string,
    assetDescription: string,
    batch: HrmBatch,
    event: "ENTERED" | "EXITED",
    time: string,
    durationMin: number | null = null,
  ): void {
    const snapshot = structuredClone(batch);
    for (const transport of this.transports) {
      this.emit(() =>
        transport.publishMaterialTransition(assetId, assetDescription, this.config.topicBase, snapshot, event, time, durationMin)
      );
    }
  }

  private emitMaterialStatus(
    assetId: string,
    assetDescription: string,
    batch: HrmBatch,
    time: string,
  ): void {
    const snapshot = structuredClone(batch);
    for (const transport of this.transports) {
      this.emit(() =>
        transport.publishMaterialStatus(assetId, assetDescription, this.config.topicBase, snapshot, time)
      );
    }
  }

  private emitAssetMaterialOccupancy(
    assetId: string,
    assetDescription: string,
    batch: HrmBatch | undefined,
    time: string,
  ): void {
    for (const transport of this.transports) {
      this.emit(() =>
        transport.publishAssetMaterialOccupancy(assetId, assetDescription, this.config.topicBase, batch, time)
      );
    }
  }

  private emitPassComplete(batch: HrmBatch, pass: import("./hrm-publisher.js").PassEvent, time: string): void {
    const snapshot = structuredClone(batch);
    for (const transport of this.transports) {
      this.emit(() =>
        transport.publishPassComplete(this.config.productionLine.rollingStand.assetId, this.config.topicBase, snapshot, pass, time)
      );
    }
  }

  private emitWarehouseFacts(batch: HrmBatch, time: string): void {
    const snapshot = structuredClone(batch);
    for (const transport of this.transports) {
      this.emit(() =>
        transport.publishWarehouseState(this.config.productionLine.warehouse.assetId, this.config.topicBase, snapshot, time)
      );
    }
  }

  private emitAlarm(assetId: string, assetDescription: string, objectId: string, alarm: AlarmEvent, time: string): void {
        for (const transport of this.transports) {
      this.emit(() =>
        transport.publishAlarm(assetId, assetDescription, objectId, this.config.topicBase, alarm, time)
      );
    }
  }

  private moveToStage(batchId: string, stage: BatchStage, time?: string): void {
    const batch = this.batches.get(batchId)!;
    const effectiveTime = time ?? this.currentSimulationIso();
    batch.stage = stage;
    batch.stageEnteredAt = effectiveTime;
    batch.ticksInStage = 0;
  }

  private estimateDescalingExitTemp(batch: HrmBatch, durationMin: number): number | undefined {
    const furnaceExitTempC = batch.measured.furnaceExitTempC;
    if (furnaceExitTempC == null) return undefined;

    const pressureBar = batch.descaling?.measuredPressureBar ?? this.config.productionLine.descaling.nominalPressureBar;
    const coolingRateCPerMin = 6 + (pressureBar / 1200);
    return Number(Math.max(AMBIENT_TEMP_C, furnaceExitTempC - (durationMin * coolingRateCPerMin)).toFixed(1));
  }

  private advanceFurnaceConsumptionCounter(state: FurnacePhysicsState | undefined): void {
    if (!state) return;
    this.furnaceTotalFuelConsumptionNm3 = Number((
      this.furnaceTotalFuelConsumptionNm3
      + ((state.totalFuelFlowNm3h * this.effectiveTickMs) / 3_600_000)
    ).toFixed(3));
    this.applyFurnaceCounterValues(state);
  }

  private applyFurnaceCounterValues(state: FurnacePhysicsState | undefined): void {
    if (!state) return;
    state.totalFuelConsumptionNm3 = this.furnaceTotalFuelConsumptionNm3;
    state.totalPusherPushCount = this.furnaceTotalPusherPushCount;
  }

  private captureRollingMeasurements(batch: HrmBatch, rollingDurationMin: number): void {
    const avgSpeedMps = batch.measured.rollingSpeedSamples > 0
      ? batch.measured.rollingSpeedSumMps / batch.measured.rollingSpeedSamples
      : batch.rolling?.measuredSpeedMps ?? batch.recipe.rollingPlan.passes[0]?.speedMps ?? 0;
    const finalThicknessMm = batch.rolling?.measuredThicknessMm ?? batch.recipe.targetThicknessMm;
    const rollingEntryTempC = batch.measured.rollingEntryTempC
      ?? batch.measured.descalingExitTempC
      ?? batch.measured.furnaceExitTempC
      ?? batch.recipe.furnace.targetTempC;
    const passCount = batch.rolling?.totalPasses ?? batch.recipe.rollingPlan.passes.length;
    const reductionRatio = Math.max(0, 1 - (finalThicknessMm / batch.recipe.initialThicknessMm));
    const coolingC =
      (rollingDurationMin * 13)
      + (passCount * 4)
      + (reductionRatio * 55)
      + (Math.max(0, avgSpeedMps - 1) * 8)
      + this.materialSignalBias(batch.materialId, 10);
    batch.measured.averageRollingSpeedMps = Number(avgSpeedMps.toFixed(3));
    batch.measured.finalThicknessMm = Number(finalThicknessMm.toFixed(2));
    batch.measured.totalPasses = passCount;
    const lastPassDirection = batch.rolling?.direction ?? batch.recipe.rollingPlan.passes[passCount - 1]?.direction;
    if (lastPassDirection) {
      batch.measured.lastPassDirection = lastPassDirection;
    }
    batch.measured.rollingExitTempC = Number(Math.max(AMBIENT_TEMP_C, rollingEntryTempC - coolingC).toFixed(1));
  }

  private materialSignalBias(materialId: string, amplitude: number): number {
    const seed = [...materialId].reduce((sum, char, index) => sum + (char.charCodeAt(0) * (index + 1)), 0);
    return (((seed % 2001) / 1000) - 1) * amplitude;
  }

  private syncFurnaceZoneAlarms(batch: HrmBatch, time: string): void {
    const furnace = batch.furnace;
    if (!furnace) return;

    const assetId = this.config.productionLine.furnace.assetId;
    const assetDescription = this.config.productionLine.furnace.description;
    const activeNow = new Set<string>();

    for (const zone of furnace.zones) {
      const threshold = Number((zone.setpointC + 3.5).toFixed(1));
      const alarmKey = `${assetId}:zone-${zone.zoneId}:FURNACE_ZONE_OVERTEMP`;
      if (zone.measuredTempC > threshold) {
        activeNow.add(alarmKey);
        if (!this.activeFurnaceAlarms.has(alarmKey)) {
          this.activeFurnaceAlarms.add(alarmKey);
          this.emitAlarm(assetId, assetDescription, `zone-${zone.zoneId}`, {
            code: "FURNACE_ZONE_OVERTEMP",
            severity: "WARNING",
            state: "ACTIVE",
            message: `Temperatura cone ${zone.zoneId} (${zone.measuredTempC} C) je presegla prag ${threshold} C`,
            measuredValue: zone.measuredTempC,
            threshold,
          }, time);
        }
      }
    }

    for (const alarmKey of [...this.activeFurnaceAlarms]) {
      if (activeNow.has(alarmKey)) continue;
      const [alarmAssetId, objectId, alarmCode] = alarmKey.split(":");
      if (alarmAssetId !== assetId || !objectId || !alarmCode) continue;
      const zoneId = Number(objectId.replace("zone-", ""));
      const zone = furnace.zones.find((item) => item.zoneId === zoneId);
      const threshold = zone ? Number((zone.setpointC + 3.5).toFixed(1)) : 0;
      const measuredValue = zone?.measuredTempC ?? threshold;
      this.activeFurnaceAlarms.delete(alarmKey);
      this.emitAlarm(assetId, assetDescription, objectId, {
        code: alarmCode,
        severity: "WARNING",
        state: "CLEARED",
        message: `Temperatura cone ${zoneId} se je vrnila pod prag`,
        measuredValue,
        threshold,
      }, time);
    }
  }

  private clearAllFurnaceZoneAlarms(time: string): void {
    const assetId = this.config.productionLine.furnace.assetId;
    const assetDescription = this.config.productionLine.furnace.description;
    for (const alarmKey of [...this.activeFurnaceAlarms]) {
      const [alarmAssetId, objectId, alarmCode] = alarmKey.split(":");
      if (alarmAssetId !== assetId || !objectId || !alarmCode) continue;
      this.activeFurnaceAlarms.delete(alarmKey);
      this.emitAlarm(assetId, assetDescription, objectId, {
        code: alarmCode,
        severity: "WARNING",
        state: "CLEARED",
        message: "Alarm je bil zaprt ob zaključku aktivnosti peči",
        measuredValue: 0,
        threshold: 0,
      }, time);
    }
  }

  private findQualitySpec(recipe: Recipe): QualitySpec | undefined {
    return this.config.qualitySpecs.find((s) => s.applicableMaterialType === recipe.materialType);
  }

  private publishTelemetry(step: number): void {
    // Resolution controls data density independently of simulation speed.
    // 100 = every tick, 10 = every 10th tick, 1 = every 100th tick.
    const resolution = this.config.simulationResolution ?? 100;
    const skipFactor = Math.max(1, Math.round(100 / resolution));
    if (step % skipFactor !== 0) return;
    const now = this.currentSimulationIso();
        const queueAsset = this.getQueueAsset();

    for (const batchId of this.queue) {
      const batch = this.batches.get(batchId);
      if (batch) {
        this.emitMaterialStatus(queueAsset.assetId, queueAsset.description, batch, now);
      }
    }

    // Furnace
    const furnaceLeadBatchId = this.furnaceLeadBatchId();
    const furnaceLeadBatch = furnaceLeadBatchId ? this.batches.get(furnaceLeadBatchId) : undefined;
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.furnace.assetId,
      this.config.productionLine.furnace.description,
      furnaceLeadBatch,
      now,
    );
    if (furnaceLeadBatchId) {
      for (const batchId of this.furnaceSlotBatchIds) {
        if (!batchId) continue;
        const batch = this.batches.get(batchId)!;
        this.emitMaterialStatus(
          this.config.productionLine.furnace.assetId,
          this.config.productionLine.furnace.description,
          batch,
          now,
        );
      }
      const batch = this.batches.get(furnaceLeadBatchId)!;
      if (batch.furnace) {
        for (const transport of this.transports) {
          transport.publishFurnaceState(
            this.config.productionLine.furnace.assetId,
            this.config.topicBase,
            batch,
            now,
          ).catch((e) => logger.error(`HRM: furnace publish error: ${e}`));
        }
      }
    } else if (this.furnaceState) {
      for (const transport of this.transports) {
        transport.publishIdleFurnaceState(
          this.config.productionLine.furnace.assetId,
          this.config.topicBase,
          this.furnaceState,
          now,
        ).catch((e) => logger.error(`HRM: furnace publish error: ${e}`));
      }
    }

    // Descaling
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.descaling.assetId,
      this.config.productionLine.descaling.description,
      this.descalingBatchId ? this.batches.get(this.descalingBatchId) : undefined,
      now,
    );
    if (this.descalingBatchId) {
      const batch = this.batches.get(this.descalingBatchId)!;
      this.emitMaterialStatus(
        this.config.productionLine.descaling.assetId,
        this.config.productionLine.descaling.description,
        batch,
        now,
      );
      if (batch.descaling) {
        for (const transport of this.transports) {
          transport.publishDescalingState(
            this.config.productionLine.descaling.assetId,
            this.config.topicBase,
            batch,
            now,
          ).catch((e) => logger.error(`HRM: descaling publish error: ${e}`));
        }
      }
    } else if (this.descalingState) {
      for (const transport of this.transports) {
        transport.publishIdleDescalingState(
          this.config.productionLine.descaling.assetId,
          this.config.topicBase,
          this.descalingState,
          now,
        ).catch((e) => logger.error(`HRM: descaling publish error: ${e}`));
      }
    }

    // Rolling
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.rollingStand.assetId,
      this.config.productionLine.rollingStand.description,
      this.rollingBatchId ? this.batches.get(this.rollingBatchId) : undefined,
      now,
    );
    if (this.rollingBatchId) {
      const batch = this.batches.get(this.rollingBatchId)!;
      this.emitMaterialStatus(
        this.config.productionLine.rollingStand.assetId,
        this.config.productionLine.rollingStand.description,
        batch,
        now,
      );
      if (batch.rolling) {
        for (const transport of this.transports) {
          transport.publishRollingState(
            this.config.productionLine.rollingStand.assetId,
            this.config.topicBase,
            batch,
            now,
          ).catch((e) => logger.error(`HRM: rolling publish error: ${e}`));
        }
      }
    } else if (this.rollingState) {
      for (const transport of this.transports) {
        transport.publishIdleRollingState(
          this.config.productionLine.rollingStand.assetId,
          this.config.topicBase,
          this.rollingState,
          now,
        ).catch((e) => logger.error(`HRM: rolling publish error: ${e}`));
      }
    }

    // Warehouse
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.warehouse.assetId,
      this.config.productionLine.warehouse.description,
      this.warehouseBatchId ? this.batches.get(this.warehouseBatchId) : undefined,
      now,
    );
    if (this.warehouseBatchId) {
      const batch = this.batches.get(this.warehouseBatchId)!;
      this.emitMaterialStatus(
        this.config.productionLine.warehouse.assetId,
        this.config.productionLine.warehouse.description,
        batch,
        now,
      );
    }

  }

  private furnaceLeadBatchId(): string | undefined {
    for (let index = this.furnaceSlotBatchIds.length - 1; index >= 0; index -= 1) {
      const batchId = this.furnaceSlotBatchIds[index];
      if (batchId) return batchId;
    }
    return undefined;
  }

  private currentFurnaceMaterialIds(): string[] {
    return this.furnaceSlotBatchIds.map((batchId) => batchId ? (this.batches.get(batchId)?.materialId ?? "") : "");
  }

  private performFurnacePush(): void {
    this.furnaceTotalPusherPushCount += 1;
    const dischargeBatchId = this.furnaceSlotBatchIds[4];
    if (dischargeBatchId && !this.descalingBatchId && !this.rollingBatchId) {
      const batch = this.batches.get(dischargeBatchId)!;
      const exitedFurnaceAt = this.currentSimulationIso();
      const durationMin = (batch.ticksInStage * this.effectiveTickMs) / 60_000;
      const furnaceExitTempC = batch.furnace?.measuredMaterialTempC;
      if (furnaceExitTempC != null) {
        batch.measured.furnaceExitTempC = furnaceExitTempC;
      }
      this.emitMaterialTransition(
        this.config.productionLine.furnace.assetId, this.config.productionLine.furnace.description,
        batch, "EXITED", exitedFurnaceAt, durationMin,
      );
      if (this.consumeRepeat(batch, "furnace")) {
        delete batch.furnace;
        const queueAsset = this.getQueueAsset();
        this.moveToStage(batch.batchId, "QUEUED", exitedFurnaceAt);
        this.queue.unshift(batch.batchId);
        logger.info(`HRM: Batch ${batch.batchId} repeating FURNACE`);
        this.emitMaterialTransition(
          queueAsset.assetId,
          queueAsset.description,
          batch,
          "ENTERED",
          batch.stageEnteredAt,
        );
        this.emitMaterialStatus(queueAsset.assetId, queueAsset.description, batch, exitedFurnaceAt);
      } else {
        this.moveToStage(batch.batchId, "DESCALING", exitedFurnaceAt);
        this.descalingBatchId = batch.batchId;
        logger.info(`HRM: Batch ${batch.batchId} entered DESCALING`);
        this.emitMaterialTransition(
          this.config.productionLine.descaling.assetId, this.config.productionLine.descaling.description,
          batch, "ENTERED", batch.stageEnteredAt,
        );
        this.emitAssetMaterialOccupancy(
          this.config.productionLine.descaling.assetId,
          this.config.productionLine.descaling.description,
          batch,
          exitedFurnaceAt,
        );
        this.emitMaterialStatus(
          this.config.productionLine.descaling.assetId,
          this.config.productionLine.descaling.description,
          batch,
          exitedFurnaceAt,
        );
      }
    }

    for (let index = this.furnaceSlotBatchIds.length - 1; index > 0; index -= 1) {
      this.furnaceSlotBatchIds[index] = this.furnaceSlotBatchIds[index - 1];
    }
    this.furnaceSlotBatchIds[0] = undefined;

    this.chargeQueueToFurnaceSlot1();

    for (let index = 0; index < this.furnaceSlotBatchIds.length; index += 1) {
      const batchId = this.furnaceSlotBatchIds[index];
      if (!batchId) continue;
      const batch = this.batches.get(batchId);
      if (batch?.furnace) {
        batch.furnace.pusherSlotIndex = index + 1;
        batch.furnace.slotMaterialIds = this.currentFurnaceMaterialIds();
      } else if (batch && this.furnaceState) {
        batch.furnace = {
          ...this.furnaceState,
          slotMaterialIds: this.currentFurnaceMaterialIds(),
          actualMaterialTempC: AMBIENT_TEMP_C,
          measuredMaterialTempC: AMBIENT_TEMP_C,
          pusherSlotIndex: index + 1,
          subState: "HEATING",
          soakingElapsedMin: 0,
          soakingTargetMin: batch.recipe.furnace.soakingTimeMin,
        };
      }
    }

    const leadBatchId = this.furnaceLeadBatchId();
    if (!leadBatchId) {
      const now = this.currentSimulationIso();
      this.clearAllFurnaceZoneAlarms(now);
      this.applyFurnaceCounterValues(this.furnaceState);
      this.emitAssetMaterialOccupancy(
        this.config.productionLine.furnace.assetId,
        this.config.productionLine.furnace.description,
        undefined,
        now,
      );
      return;
    }
    const leadBatch = this.batches.get(leadBatchId);
    this.furnaceState = leadBatch?.furnace;
    if (this.furnaceState) {
      this.furnaceState.slotMaterialIds = this.currentFurnaceMaterialIds();
    }
    this.applyFurnaceCounterValues(this.furnaceState);
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.furnace.assetId,
      this.config.productionLine.furnace.description,
      leadBatch,
      this.currentSimulationIso(),
    );
  }

  private chargeQueueToFurnaceSlot1(): void {
    if (this.furnaceSlotBatchIds[0] || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    const batch = this.batches.get(next)!;
    const queueAsset = this.getQueueAsset();
    const enteredFurnaceAt = this.currentSimulationIso();
    const queueDurationMin = (batch.ticksInStage * this.effectiveTickMs) / 60_000;
    this.emitMaterialTransition(
      queueAsset.assetId, queueAsset.description,
      batch, "EXITED", enteredFurnaceAt, queueDurationMin,
    );
    this.moveToStage(next, "FURNACE", enteredFurnaceAt);
    this.furnaceSlotBatchIds[0] = next;
    logger.info(`HRM: Batch ${next} entered FURNACE`);
    this.emitMaterialTransition(
      this.config.productionLine.furnace.assetId, this.config.productionLine.furnace.description,
      batch, "ENTERED", batch.stageEnteredAt,
    );
    this.emitAssetMaterialOccupancy(
      this.config.productionLine.furnace.assetId,
      this.config.productionLine.furnace.description,
      batch,
      enteredFurnaceAt,
    );
    this.emitMaterialStatus(
      this.config.productionLine.furnace.assetId,
      this.config.productionLine.furnace.description,
      batch,
      enteredFurnaceAt,
    );
  }

  private currentSimulationIso(): string {
    if (this.realtimeClock) {
      return new Date().toISOString();
    }
    return new Date(this.currentSimulationTimeMs).toISOString();
  }

  private advanceSimulationTime(): void {
    if (this.realtimeClock) return;
    this.currentSimulationTimeMs += this.effectiveTickMs;
  }
}
