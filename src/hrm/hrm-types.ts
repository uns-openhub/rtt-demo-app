// ─── Recipe & Config Types ────────────────────────────────────────────────────

export interface FurnaceZoneSetpoint {
  zoneId: number;
  setpointC: number;
}

export interface FurnaceRecipe {
  targetTempC: number;
  pusherPaceMin: number;
  stoichiometricRatioTarget: number;
  soakingTimeMin: number;
  zones: FurnaceZoneSetpoint[];
}

export interface RollingPass {
  passNumber: number;
  direction: "forward" | "reverse";
  targetThicknessMm: number;
  speedMps: number;
}

export interface Recipe {
  id: string;
  name: string;
  materialType: string;
  targetThicknessMm: number;
  targetWidthMm: number;
  initialThicknessMm: number;
  furnace: FurnaceRecipe;
  rollingPlan: { passes: RollingPass[] };
}

export interface QualitySpec {
  id: string;
  name: string;
  applicableMaterialType: string;
  idealThicknessMm: number;
  thicknessToleranceMm: number;
  idealExitTempC: number;
  exitTempToleranceC: number;
  minHardnessHB: number;
  maxHardnessHB: number;
  surfaceGrade: string;
}

// ─── Production Line Config ───────────────────────────────────────────────────

export interface FurnaceConfig {
  assetId: string;
  description: string;
  zones: number;
  maxTempC: number;
  gasConsumptionNm3PerHour: number;
}

export interface DescalingConfig {
  assetId: string;
  description: string;
  nominalPressureBar: number;
  nominalFlowM3PerHour: number;
  /** Real-world duration of a descaling pass in minutes (e.g. 5). Scaled by simulationSpeed. */
  durationMin: number;
}

export interface RollingStandConfig {
  assetId: string;
  description: string;
  nominalSpeedMps: number;
  maxMotorPowerKw: number;
  maxForceKn: number;
  /** Real-world duration per rolling pass in minutes (e.g. 3). Scaled by simulationSpeed. */
  durationMinPerPass: number;
}

export interface WarehouseConfig {
  assetId: string;
  description: string;
}

export interface QueueConfig {
  assetId: string;
  description: string;
}

export interface ProductionLineConfig {
  queue?: QueueConfig | undefined;
  furnace: FurnaceConfig;
  descaling: DescalingConfig;
  rollingStand: RollingStandConfig;
  warehouse: WarehouseConfig;
}

export interface HrmConfig {
  topicBase: string;
  tickIntervalMs?: number;
  /**
   * Optional simulated process start timestamp used for published event time.
   * When omitted, published timestamps use the realtime system clock while
   * physics and station progress still use simulationSpeed.
   */
  simulationStartTime?: string | undefined;
  /**
   * Time acceleration factor. Each simulation tick advances physics by
   * (tickIntervalMs × simulationSpeed) milliseconds of process time.
   * 1 = real time, 50 = 50× faster than reality (default).
   */
  simulationSpeed?: number;
  /**
   * Percentage of ticks that produce MQTT telemetry output (1–100).
   * 100 = publish every tick (full density, default).
   * 10  = publish every 10th tick (10% of measurements).
   * 1   = publish every 100th tick (minimal data).
   * Transition events (ENTERED/EXITED, pass complete) always publish regardless of this setting.
   */
  simulationResolution?: number;
  productionLine: ProductionLineConfig;
  recipes: Recipe[];
  qualitySpecs: QualitySpec[];
}

// ─── Batch Lifecycle ──────────────────────────────────────────────────────────

export type BatchStage =
  | "QUEUED"
  | "FURNACE"
  | "DESCALING"
  | "ROLLING"
  | "WAREHOUSE"
  | "DONE"
  | "FAILED";

export type HrmRepeatStage = "furnace" | "descaling" | "rolling";

// ─── Physics State Snapshots (published to MQTT each tick) ────────────────────

export interface FurnaceZoneState {
  zoneId: number;
  setpointC: number;
  actualTempC: number;
  measuredTempC: number;
  heaterOn: boolean;
  gasConsumptionNm3h: number;
  burnerLoadPct: number;
  actualExhaustO2Pct: number;
  measuredExhaustO2Pct: number;
}

export interface FurnacePhysicsState {
  zones: FurnaceZoneState[];
  slotMaterialIds: string[];
  actualMaterialTempC: number;
  measuredMaterialTempC: number;
  actualChamberTempC: number;
  measuredChamberTempC: number;
  actualFurnacePressurePa: number;
  measuredFurnacePressurePa: number;
  pusherPositionPct: number;
  pusherPushCount: number;
  pusherSlotIndex: number;
  pusherTotalSlots: number;
  pusherPaceMin: number;
  nextPushProgressPct: number;
  minutesToNextPush: number;
  totalFuelFlowNm3h: number;
  totalFuelConsumptionNm3?: number;
  totalPusherPushCount?: number;
  totalAirFlowNm3h: number;
  subState: "HEATING" | "SOAKING" | "DONE" | "IDLE";
  soakingElapsedMin: number;
  soakingTargetMin: number;
}

export interface DescalingPhysicsState {
  actualPressureBar: number;
  measuredPressureBar: number;
  actualHeaderPressureBar: number;
  measuredHeaderPressureBar: number;
  actualFlowM3h: number;
  measuredFlowM3h: number;
  actualPumpSpeedRpm: number;
  measuredPumpSpeedRpm: number;
  actualPumpCurrentA: number;
  measuredPumpCurrentA: number;
  actualNozzleValveOpenPct: number;
  measuredNozzleValveOpenPct: number;
  actualWaterTempC: number;
  measuredWaterTempC: number;
  totalWaterConsumptionM3: number;
  actualHydraulicOilLevelPct: number;
  measuredHydraulicOilLevelPct: number;
  actualHydraulicOilTempC: number;
  measuredHydraulicOilTempC: number;
  subState: "PROCESSING" | "DONE" | "IDLE";
  elapsedTicks: number;
  totalTicks: number;
}

export interface RollingPhysicsState {
  currentPass: number;
  totalPasses: number;
  direction: "forward" | "reverse";
  targetSpeedMps: number;
  actualSpeedMps: number;
  measuredSpeedMps: number;
  speedAccelerationMps2: number;
  actualThicknessMm: number;
  measuredThicknessMm: number;
  targetThicknessMm: number;
  actualRollGapMm: number;
  measuredRollGapMm: number;
  actualRollForcekN: number;
  measuredRollForcekN: number;
  actualMotorPowerKw: number;
  measuredMotorPowerKw: number;
  actualMotorCurrentA: number;
  measuredMotorCurrentA: number;
  actualStandTorqueKnm: number;
  measuredStandTorqueKnm: number;
  actualHydraulicPressureBar: number;
  measuredHydraulicPressureBar: number;
  actualLubricationFlowLpm: number;
  measuredLubricationFlowLpm: number;
  actualBearingTempC: number;
  measuredBearingTempC: number;
  actualVibrationMmS: number;
  measuredVibrationMmS: number;
  subState: "ROLLING" | "PASS_COMPLETE" | "DONE" | "IDLE";
}

export interface WarehousePhysicsState {
  specId: string;
  finalThicknessMm: number;
  finalTempC: number;
  hardnessHB: number;
  surfaceGrade: string;
  passFail: boolean;
  thicknessDeviationMm: number;
  tempDeviationC: number;
  failReasons: string[];
}

export interface MaterialMeasuredState {
  furnaceExitTempC?: number;
  descalingExitTempC?: number;
  rollingEntryTempC?: number;
  rollingExitTempC?: number;
  finalThicknessMm?: number;
  averageRollingSpeedMps?: number;
  totalPasses?: number;
  lastPassDirection?: "forward" | "reverse";
  rollingSpeedSumMps: number;
  rollingSpeedSamples: number;
}

// ─── Batch Runtime ────────────────────────────────────────────────────────────

export interface HrmBatch {
  batchId: string;
  recipeId: string;
  materialId: string;
  quantity: number;
  stage: BatchStage;
  createdAt: string;
  stageEnteredAt: string;
  ticksInStage: number;
  recipe: Recipe;
  measured: MaterialMeasuredState;
  furnace?: FurnacePhysicsState;
  descaling?: DescalingPhysicsState;
  rolling?: RollingPhysicsState;
  warehouse?: WarehousePhysicsState;
  repeatStage?: HrmRepeatStage;
  repeatRemaining?: number;
  mergeGroupId?: string;
  mergeInputMaterialIds?: string[];
  mergeOutputMaterialId?: string;
  previousMaterialObjectIds?: string[];
  mergeConsumedAt?: string;
}

// ─── API Request / Response ───────────────────────────────────────────────────

export interface BatchSubmitRequest {
  recipeId: string;
  materialId: string;
  quantity: number;
  repeatStage?: HrmRepeatStage;
  mergeInputMaterialIds?: string[];
  mergeOutputMaterialId?: string;
}

export interface BatchSubmitResponse {
  batchId: string;
  recipeId: string;
  materialId: string;
  quantity: number;
  status: "accepted" | "rejected";
  reason?: string;
  submittedAt: string;
  repeatStage?: HrmRepeatStage;
  mergeInputMaterialIds?: string[];
  mergeOutputMaterialId?: string;
}

export interface StationStatus {
  occupied: boolean;
  batchId: string | undefined;
  recipeId?: string | undefined;
  materialId?: string | undefined;
  furnaceMaterials?: Array<{
    slot: number;
    batchId: string;
    recipeId: string;
    materialId: string;
    soakingElapsedMin: number;
    subState: FurnacePhysicsState["subState"];
    measuredMaterialTempC?: number;
  }> | undefined;
}

export interface ProductionLineStateResponse {
  timestamp: string;
  stations: {
    furnace: StationStatus & { state: FurnacePhysicsState | undefined };
    descaling: StationStatus & { state: DescalingPhysicsState | undefined };
    rolling: StationStatus & { state: RollingPhysicsState | undefined };
    warehouse: StationStatus & { state: WarehousePhysicsState | undefined };
  };
  queue: Array<{ batchId: string; recipeId: string; materialId: string }>;
  completed: Array<{ batchId: string; completedAt: string; passFail: boolean }>;
}

export interface HrmRuntimeConfigResponse {
  topicBase: string;
  tickIntervalMs: number;
  simulationStartTime: string;
  currentSimulationTime: string;
  simulationSpeed: number;
  simulationResolution: number;
  skipFactor: number;
  telemetryIntervalMs: number;
  effectiveTickMs: number;
}
