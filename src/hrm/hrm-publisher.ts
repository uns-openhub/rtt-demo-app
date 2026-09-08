import type { BatchStage, DescalingPhysicsState, FurnacePhysicsState, HrmBatch, RollingPhysicsState } from "./hrm-types.js";
import type UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";
import type {
  IMqttPublishRequest,
  IUnsTableColumn,
  IUnsTableColumns,
} from "@uns-kit/core/uns/uns-interfaces.js";
import { UnsPacket } from "@uns-kit/core/uns/uns-packet.js";
import { GeneratedAttributes, GeneratedObjectTypes } from "../uns/uns-dictionary.generated.js";
import { GeneratedPhysicalMeasurements } from "../uns/uns-measurements.generated.js";
import type { AssetIdentityPublicationProvider } from "./asset-identity-publication.js";

type InternalTableColumn = IUnsTableColumn & { name: string };

const namedTableColumns = (
  columns: InternalTableColumn[],
): IUnsTableColumns =>
  Object.fromEntries(
    columns.map(({ name, ...column }) => [name, column]),
  );

/** Convert a runtime ISO string to the branded ISO8601 type using uns-kit's formatter. */
const iso = (time: string) => UnsPacket.formatToISO8601(new Date(time));

const HRM_DATA_GROUPS = {
  batch: "batch",
} as const;

const COUNTER_SIGNAL_METADATA = {
  valueType: "number",
  presentationKind: "counter",
  defaultAggregation: "last",
  counterResetPolicy: "new-value",
} as const;

const PUSHER_FURNACE_ASSET_DESCRIPTION = "Potisna peč (reheating furnace)";
const DESCALING_PUMP_SKID_ASSET_ID = "pump-skid-1";
const DESCALING_PUMP_SKID_DESCRIPTION = "Črpalni skid descaling sistema";

const physicalMeasurements = GeneratedPhysicalMeasurements as Record<string, string | undefined>;
const physicalMeasurement = (key: string, fallback: string): string =>
  physicalMeasurements[key] ?? physicalMeasurements[key.toLowerCase()] ?? fallback;

const MEASUREMENT_UOM = {
  ampere: physicalMeasurement("Ampere", "A"),
  bar: physicalMeasurement("Bar", "bar"),
  celsius: physicalMeasurement("Celsius", "°C"),
  cubicMeter: physicalMeasurement("CubicMeter", "m^3"),
  cubicMeterPerHour: physicalMeasurement("CubicMeterPerHour", "m^3/h"),
  kilowatt: physicalMeasurement("KiloWatt", "kW"),
  liter: physicalMeasurement("Liter", "l"),
  meterPerSecond: physicalMeasurement("MeterPerSecond", "m/s"),
  milimeter: physicalMeasurement("MiliMeter", "mm"),
  milimeterPerSecond: physicalMeasurement("MilimeterPerSecond", "mm/s"),
  none: physicalMeasurement("None", ""),
  pascal: physicalMeasurement("Pascal", "Pa"),
  percent: physicalMeasurement("Percent", "%"),
  revolutionsPerMinute: physicalMeasurement("RevolutionsPerMinute", "rpm"),
} as const;

const MATERIAL_STAGE_INDEX: Record<BatchStage, number> = {
  QUEUED: 0,
  FURNACE: 0,
  DESCALING: 1,
  ROLLING: 2,
  WAREHOUSE: 3,
  DONE: 3,
  FAILED: 3,
};

type GroupMode = "none" | "asset";
type DataGroupOptions = { dataGroup?: GroupMode };
type VirtualGroupOptions = { virtualGroup?: GroupMode };

// ─── Transport Interface (ModBus-ready) ───────────────────────────────────────

export interface PassEvent {
  passNumber: number;
  direction: "forward" | "reverse";
  startThicknessMm: number;
  endThicknessMm: number;
  /** Effective process duration in seconds (from recipe config, not wall clock). */
  durationSec: number;
}

export interface AlarmEvent {
  code: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  state: "ACTIVE" | "CLEARED";
  message: string;
  measuredValue: number;
  threshold: number;
}

export interface IHrmTransport {
  /** Continuous station telemetry — published on the configured telemetry cadence while a station is active. */
  publishMaterialStatus(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch,
    time: string): Promise<void>;
  publishAssetMaterialOccupancy(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch | undefined,
    time: string): Promise<void>;
  publishFurnaceState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void>;
  publishIdleFurnaceState(assetId: string, topicBase: string, state: FurnacePhysicsState, time: string): Promise<void>;
  publishDescalingState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void>;
  publishIdleDescalingState(assetId: string, topicBase: string, state: DescalingPhysicsState, time: string): Promise<void>;
  publishRollingState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void>;
  publishIdleRollingState(assetId: string, topicBase: string, state: RollingPhysicsState, time: string): Promise<void>;
  /** Final quality facts — published once when the warehouse inspection is created. */
  publishWarehouseState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void>;

  /**
   * Sparse transition event — published only when a batch enters or exits a station.
   * Publishes under the stage-specific material objectId, e.g. slab-001,
   * slab-001-1, slab-001-2, while the business materialId stays slab-001.
   * durationMin is null for ENTERED events, filled for EXITED.
   */
  publishMaterialTransition(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch,
    event: "ENTERED" | "EXITED",
    time: string,
    durationMin: number | null): Promise<void>;

  /**
   * Rolling pass completion event — published once per completed pass.
   * Publishes under the same stand equipment object as live rolling telemetry.
   */
  publishPassComplete(
    assetId: string,
    topicBase: string,
    batch: HrmBatch,
    pass: PassEvent,
    time: string): Promise<void>;
  publishAlarm(
    assetId: string,
    assetDescription: string,
    objectId: string,
    topicBase: string,
    alarm: AlarmEvent,
    time: string): Promise<void>;
}

// ─── MQTT Transport Implementation ───────────────────────────────────────────

export class MqttHrmTransport implements IHrmTransport {
  constructor(
    private readonly mqttOutput: UnsMqttProxy,
    private readonly telemetryIntervalMs: number,
    private readonly identityProvider?: AssetIdentityPublicationProvider,
  ) {}

  private async publishMqttMessage(message: IMqttPublishRequest): Promise<void> {
    const identity = await this.identityProvider?.forAsset(
      message.asset,
      message.topic,
    );
    await this.mqttOutput.publishMqttMessage({
      ...message,
      ...(identity ?? {}),
    });
  }

  private materialObjectId(batch: HrmBatch, stage: BatchStage = batch.stage): string {
    const index = MATERIAL_STAGE_INDEX[stage] ?? 0;
    return index > 0 ? `${batch.materialId}-${index}` : batch.materialId;
  }

  private previousMaterialObjectId(batch: HrmBatch, stage: BatchStage = batch.stage): string | undefined {
    const index = MATERIAL_STAGE_INDEX[stage] ?? 0;
    if (index <= 0) return undefined;
    return index === 1 ? batch.materialId : `${batch.materialId}-${index - 1}`;
  }

  private materialRelationshipEvidenceAttribute(
    batch: HrmBatch,
    time: string,
    dataGroup: string,
    previousMaterialObjectId?: string,
  ) {
    const previousMaterialIds = batch.previousMaterialObjectIds?.length
      ? batch.previousMaterialObjectIds
      : this.previousMaterialObjectId(batch)
        ? [this.previousMaterialObjectId(batch)!]
        : [];
    const value = previousMaterialObjectId ?? previousMaterialIds[0];
    if (!value) return undefined;

    return {
      attribute: GeneratedAttributes["previous-material"],
      description: previousMaterialIds.length <= 1
        ? "Prejšnja oznaka materiala pred prehodom na trenutno lokacijo"
        : "Prejšnje oznake materiala pred združitvijo v trenutno oznako",
      systemRole: "relationship-evidence" as const,
      relationshipEvidence: {
        relationshipKey: "material-renumbering",
        ownerEndpoint: "target" as const,
        valueEndpoint: "source" as const,
        sourceObjectType: GeneratedObjectTypes["material"],
        targetObjectType: GeneratedObjectTypes["material"],
        sourceObjectIdFrom: "value",
        targetObjectIdFrom: "ownerObjectId",
        observedAtFrom: "packetTimestamp",
        defaultStatus: "suggested" as const,
      },
      data: this.dataPayload(time, dataGroup, {
        batchDataGroup: HRM_DATA_GROUPS.batch,
        materialId: batch.materialId,
        currentMaterialObjectId: this.materialObjectId(batch),
        value,
        ...(batch.mergeInputMaterialIds?.length ? { mergeInputMaterialIds: batch.mergeInputMaterialIds } : {}),
        ...(batch.mergeOutputMaterialId ? { mergeOutputMaterialId: batch.mergeOutputMaterialId } : {}),
      }),
    };
  }

  private previousMaterialObjectIds(batch: HrmBatch): string[] {
    if (batch.previousMaterialObjectIds?.length) return batch.previousMaterialObjectIds;
    const previous = this.previousMaterialObjectId(batch);
    return previous ? [previous] : [];
  }

  private async publishMaterialRelationshipEvidence(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch,
    time: string,
  ): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    const virtualGroup = this.resolveVirtualGroup(assetId, { virtualGroup: "asset" });
    const previousMaterialObjectIds = this.previousMaterialObjectIds(batch);
    if (previousMaterialObjectIds.length <= 1) return;
    for (const previousMaterialObjectId of previousMaterialObjectIds) {
      const attribute = this.materialRelationshipEvidenceAttribute(batch, time, dataGroup, previousMaterialObjectId);
      if (!attribute) continue;
      await this.publishMqttMessage({
        topic: topicBase,
        asset: assetId,
        assetDescription,
        objectType: GeneratedObjectTypes["material"],
        objectId: this.materialObjectId(batch),
        virtualGroup,
        attributes: [attribute],
      });
    }
  }

  private intervalValidity(): { validityMode: "interval"; expectedIntervalMs: number } {
    return {
      validityMode: "interval",
      expectedIntervalMs: this.telemetryIntervalMs,
    };
  }

  private lifecycleValidity(lifecycleEndValue: string): { validityMode: "lifecycle"; lifecycleEndValue: string } {
    return {
      validityMode: "lifecycle",
      lifecycleEndValue,
    };
  }

  private assetDataGroup(assetId: string): string {
    return assetId.replace(/[^A-Za-z0-9]+/g, "_");
  }

  private childAssetTopic(topicBase: string, parentAssetId: string): string {
    const normalizedBase = topicBase.endsWith("/") ? topicBase : `${topicBase}/`;
    return `${normalizedBase}${parentAssetId}/`;
  }

  private resolveDataGroup(assetId: string, options: { dataGroup: "asset" }): string;
  private resolveDataGroup(assetId: string, options?: DataGroupOptions): string | undefined;
  private resolveDataGroup(assetId: string, options: DataGroupOptions = {}): string | undefined {
    return options.dataGroup === "asset" ? this.assetDataGroup(assetId) : undefined;
  }

  private resolveVirtualGroup(assetId: string, options: { virtualGroup: "asset" }): string;
  private resolveVirtualGroup(assetId: string, options?: VirtualGroupOptions): string | undefined;
  private resolveVirtualGroup(assetId: string, options: VirtualGroupOptions = {}): string | undefined {
    return options.virtualGroup === "asset" ? this.assetDataGroup(assetId) : undefined;
  }

  private dataPayload(time: string, dataGroup: string | undefined, fields: Record<string, unknown>): any {
    return dataGroup ? { time: iso(time), dataGroup, ...fields } : { time: iso(time), ...fields };
  }

  private ungroupedDataPayload(time: string, fields: Record<string, unknown>): any {
    return { time: iso(time), ...fields };
  }

  private tablePayload(time: string, dataGroup: string | undefined, fields: Record<string, unknown>): any {
    return dataGroup ? { time: iso(time), dataGroup, ...fields } : { time: iso(time), ...fields };
  }

  private materialTransitionEventId(
    assetId: string,
    batch: HrmBatch,
    event: "ENTERED" | "EXITED",
    time: string,
  ): string {
    return `${assetId}:${this.materialObjectId(batch)}:${event}:${iso(time)}`;
  }

  private passCompletionEventId(batch: HrmBatch, passNumber: number, time: string): string {
    return `${this.materialObjectId(batch)}:stand-1:pass-${passNumber}:COMPLETE:${iso(time)}`;
  }

  private qualityInspectionEventId(batch: HrmBatch, time: string): string {
    return `${this.materialObjectId(batch)}:INSPECTION:${iso(time)}`;
  }

  private alarmEventId(assetId: string, objectId: string, code: string, state: "ACTIVE" | "CLEARED", time: string): string {
    return `${assetId}:${objectId}:${code}:${state}:${iso(time)}`;
  }

  async publishMaterialStatus(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch,
    time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    const virtualGroup = this.resolveVirtualGroup(assetId, { virtualGroup: "asset" });
    const validity =
      batch.stage === "DONE" || batch.stage === "FAILED"
        ? {}
        : this.intervalValidity();
    const previousMaterialAttribute = this.previousMaterialObjectIds(batch).length <= 1
      ? this.materialRelationshipEvidenceAttribute(batch, time, dataGroup)
      : undefined;

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription,
      objectType: GeneratedObjectTypes["material"],
      objectId: this.materialObjectId(batch),
      virtualGroup,
      attributes: [
        {
          attribute: GeneratedAttributes["status"],
          description: "Trenutna stopnja življenjskega cikla materiala",
          ...validity,
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: batch.stage }),
        },
        ...(previousMaterialAttribute ? [previousMaterialAttribute] : []),
      ],
    });
  }

  async publishAssetMaterialOccupancy(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch | undefined,
    time: string): Promise<void> {
    const occupied = Boolean(batch);
    const materialId = batch?.materialId ?? "NONE";
    const batchId = batch?.batchId ?? "NONE";
    const commonFields = {
      batchDataGroup: HRM_DATA_GROUPS.batch,
      materialId,
      batchId,
      recipeId: batch?.recipeId ?? "NONE",
      stage: batch?.stage ?? "EMPTY",
    };

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription,
      objectType: GeneratedObjectTypes["material"],
      objectId: "main",
      attributes: [
        {
          attribute: GeneratedAttributes["lot-id"],
          description: "Trenutno založen lot materiala na agregatu",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { ...commonFields, value: materialId }),
        },
        {
          attribute: GeneratedAttributes["batch-number"],
          description: "Trenutno založena serija materiala na agregatu",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { ...commonFields, value: batchId }),
        },
        {
          attribute: GeneratedAttributes["status"],
          description: "Zasedenost agregata z materialom",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { ...commonFields, value: occupied ? "OCCUPIED" : "EMPTY" }),
        },
      ],
    });
  }

  async publishFurnaceState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void> {
    const state = batch.furnace!;
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    const virtualGroup = this.resolveVirtualGroup(assetId, { virtualGroup: "asset" });
    await this.publishFurnaceSnapshot(assetId, topicBase, state, time);

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["material"],
      objectId: this.materialObjectId(batch),
      virtualGroup,
      attributes: [
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura materiala v peči",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.measuredMaterialTempC, uom: MEASUREMENT_UOM.celsius }),
        },
      ],
    });
  }

  async publishIdleFurnaceState(assetId: string, topicBase: string, state: FurnacePhysicsState, time: string): Promise<void> {
    await this.publishFurnaceSnapshot(assetId, topicBase, state, time);
  }

  private async publishFurnaceSnapshot(assetId: string, topicBase: string, state: FurnacePhysicsState, time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    for (const zone of state.zones) {
      await this.publishMqttMessage({
        topic: topicBase,
        asset: assetId,
        assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
        objectType: GeneratedObjectTypes["equipment"],
        objectId: `zone-${zone.zoneId}`,
        attributes: [
          {
            attribute: GeneratedAttributes["temperature"],
            description: `Temperatura cone ${zone.zoneId}`,
            ...this.intervalValidity(),
            data: this.dataPayload(time, dataGroup, { value: zone.measuredTempC, uom: MEASUREMENT_UOM.celsius }),
          },
          {
            attribute: GeneratedAttributes["energy-consumption"],
            description: `Poraba plina v coni ${zone.zoneId}`,
            ...this.intervalValidity(),
            data: this.dataPayload(time, dataGroup, { value: zone.gasConsumptionNm3h, uom: "Nm³/h" }),
          },
          {
            attribute: GeneratedAttributes["power"],
            description: `Obremenitev gorilnika cone ${zone.zoneId}`,
            ...this.intervalValidity(),
            data: this.dataPayload(time, dataGroup, { value: zone.burnerLoadPct, uom: MEASUREMENT_UOM.percent }),
          },
          {
            attribute: GeneratedAttributes["oxygen-concentration"],
            description: `Kisik v dimnih plinih cone ${zone.zoneId}`,
            ...this.intervalValidity(),
            data: this.dataPayload(time, dataGroup, { value: zone.measuredExhaustO2Pct, uom: MEASUREMENT_UOM.percent }),
          },
        ],
      });
    }

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "chamber",
      attributes: [
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura pečne atmosfere",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredChamberTempC, uom: MEASUREMENT_UOM.celsius }),
        },
        {
          attribute: GeneratedAttributes["pressure"],
          description: "Tlak v peči",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredFurnacePressurePa, uom: MEASUREMENT_UOM.pascal }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "pusher",
      attributes: [
        {
          attribute: GeneratedAttributes["position"],
          description: "Položaj pusher aktuatorja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.pusherPositionPct, uom: MEASUREMENT_UOM.percent }),
        },
        {
          attribute: GeneratedAttributes["slot-index"],
          description: "Trenutni slot materiala v pusher peči",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.pusherSlotIndex, uom: MEASUREMENT_UOM.none }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "pusher-counter",
      attributes: [
        {
          attribute: GeneratedAttributes["output-quantity"],
          description: "Skupno število pusher pomikov",
          ...this.intervalValidity(),
          ...COUNTER_SIGNAL_METADATA,
          data: this.dataPayload(time, dataGroup, { value: state.totalPusherPushCount ?? 0, uom: MEASUREMENT_UOM.none }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["gas-meter"],
      objectId: "natural-gas",
      attributes: [
        {
          attribute: GeneratedAttributes["consumption-rate"],
          description: "Trenutni pretok zemeljskega plina v potisno peč",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.totalFuelFlowNm3h, uom: "Nm³/h" }),
        },
        {
          attribute: GeneratedAttributes["consumption"],
          description: "Števčno stanje porabe zemeljskega plina",
          ...this.intervalValidity(),
          ...COUNTER_SIGNAL_METADATA,
          data: this.dataPayload(time, dataGroup, { value: state.totalFuelConsumptionNm3 ?? 0, uom: "Nm³" }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: PUSHER_FURNACE_ASSET_DESCRIPTION,
      objectType: GeneratedObjectTypes["fluid-resource"],
      objectId: "combustion-air",
      attributes: [
        {
          attribute: GeneratedAttributes["flow"],
          description: "Skupni pretok zgorevalnega zraka",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.totalAirFlowNm3h, uom: "Nm³/h" }),
        },
      ],
    });
  }

  async publishDescalingState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void> {
    await this.publishDescalingSnapshot(assetId, topicBase, batch.descaling!, time);
  }

  async publishIdleDescalingState(assetId: string, topicBase: string, state: DescalingPhysicsState, time: string): Promise<void> {
    await this.publishDescalingSnapshot(assetId, topicBase, state, time);
  }

  private async publishDescalingSnapshot(assetId: string, topicBase: string, state: DescalingPhysicsState, time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Hidravlično odstranjevanje okajne plasti",
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "pump-1",
      attributes: [
        {
          attribute: GeneratedAttributes["pressure"],
          description: "Izstopni tlak črpalke za descaling",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredPressureBar, uom: MEASUREMENT_UOM.bar }),
        },
        {
          attribute: GeneratedAttributes["flow"],
          description: "Pretok skozi črpalko za descaling",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredFlowM3h, uom: MEASUREMENT_UOM.cubicMeterPerHour }),
        },
        {
          attribute: GeneratedAttributes["speed"],
          description: "Hitrost vrtenja črpalke",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredPumpSpeedRpm, uom: MEASUREMENT_UOM.revolutionsPerMinute }),
        },
        {
          attribute: GeneratedAttributes["current"],
          description: "Tok motorja črpalke",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredPumpCurrentA, uom: MEASUREMENT_UOM.ampere }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Hidravlično odstranjevanje okajne plasti",
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "spray-header",
      attributes: [
        {
          attribute: GeneratedAttributes["pressure"],
          description: "Tlak na razpršilnem kolektorju",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredHeaderPressureBar, uom: MEASUREMENT_UOM.bar }),
        },
        {
          attribute: GeneratedAttributes["position"],
          description: "Odpiranje razpršilnega ventila",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredNozzleValveOpenPct, uom: MEASUREMENT_UOM.percent }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura vode na kolektorju",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredWaterTempC, uom: MEASUREMENT_UOM.celsius }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Hidravlično odstranjevanje okajne plasti",
      objectType: GeneratedObjectTypes["fluid-resource"],
      objectId: "water",
      attributes: [
        {
          attribute: GeneratedAttributes["consumption"],
          description: "Poraba vode na tick",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, {
            value: Number(((state.measuredFlowM3h * this.telemetryIntervalMs) / 3_600_000).toFixed(4)),
            uom: MEASUREMENT_UOM.cubicMeter,
          }),
        },
        {
          attribute: GeneratedAttributes["total-flow"],
          description: "Skupna poraba vode v aktivnem ciklu",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.totalWaterConsumptionM3, uom: MEASUREMENT_UOM.cubicMeter }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura vode",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredWaterTempC, uom: MEASUREMENT_UOM.celsius }),
        },
      ],
    });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Hidravlično odstranjevanje okajne plasti",
      objectType: GeneratedObjectTypes["fluid-resource"],
      objectId: "hydraulic-oil",
      attributes: [
        {
          attribute: GeneratedAttributes["level"],
          description: "Nivo hidravličnega olja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredHydraulicOilLevelPct, uom: MEASUREMENT_UOM.percent }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura hidravličnega olja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredHydraulicOilTempC, uom: MEASUREMENT_UOM.celsius }),
        },
        {
          attribute: GeneratedAttributes["consumption"],
          description: "Ocenjena poraba hidravličnega olja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: Number((Math.max(0, 90 - state.measuredHydraulicOilLevelPct) * 0.01).toFixed(3)), uom: MEASUREMENT_UOM.liter }),
        },
      ],
    });

    await this.publishDescalingPumpSkidSubAsset(assetId, topicBase, state, time);
  }

  private async publishDescalingPumpSkidSubAsset(
    parentAssetId: string,
    topicBase: string,
    state: DescalingPhysicsState,
    time: string,
  ): Promise<void> {
    await this.publishMqttMessage({
      topic: this.childAssetTopic(topicBase, parentAssetId),
      asset: DESCALING_PUMP_SKID_ASSET_ID,
      assetDescription: DESCALING_PUMP_SKID_DESCRIPTION,
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "main",
      attributes: [
        {
          attribute: GeneratedAttributes["pressure"],
          description: "Izstopni tlak črpalnega skida za descaling",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { value: state.measuredPressureBar, uom: "bar" }),
        },
        {
          attribute: GeneratedAttributes["flow"],
          description: "Pretok skozi črpalni skid za descaling",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { value: state.measuredFlowM3h, uom: "m^3/h" }),
        },
        {
          attribute: GeneratedAttributes["speed"],
          description: "Hitrost vrtenja črpalke v črpalnem skidu",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { value: state.measuredPumpSpeedRpm, uom: "rpm" }),
        },
        {
          attribute: GeneratedAttributes["current"],
          description: "Tok motorja črpalnega skida",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { value: state.measuredPumpCurrentA, uom: "A" }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura hidravličnega olja na črpalnem skidu",
          ...this.intervalValidity(),
          data: this.ungroupedDataPayload(time, { value: state.measuredHydraulicOilTempC, uom: "degC" }),
        },
      ],
    });
  }

  async publishRollingState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void> {
    await this.publishRollingSnapshot(assetId, topicBase, batch.rolling!, time);
  }

  async publishIdleRollingState(assetId: string, topicBase: string, state: RollingPhysicsState, time: string): Promise<void> {
    await this.publishRollingSnapshot(assetId, topicBase, state, time);
  }

  private async publishRollingSnapshot(assetId: string, topicBase: string, state: RollingPhysicsState, time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Reverzirno valjarsko ogrodje",
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "stand-1",
      attributes: [
        {
          attribute: GeneratedAttributes["speed"],
          description: "Dejanska hitrost valjanja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredSpeedMps, uom: MEASUREMENT_UOM.meterPerSecond }),
        },
        {
          attribute: GeneratedAttributes["force"],
          description: "Valjalna sila",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredRollForcekN, uom: "kN" }),
        },
        {
          attribute: GeneratedAttributes["torque"],
          description: "Navor glavnega pogona",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredStandTorqueKnm, uom: "kNm" }),
        },
        {
          attribute: GeneratedAttributes["power"],
          description: "Moč glavnega pogona",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredMotorPowerKw, uom: MEASUREMENT_UOM.kilowatt }),
        },
        {
          attribute: GeneratedAttributes["current"],
          description: "Tok glavnega motorja",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredMotorCurrentA, uom: MEASUREMENT_UOM.ampere }),
        },
        {
          attribute: GeneratedAttributes["position"],
          description: "Nastavljena valjalna reža",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredRollGapMm, uom: MEASUREMENT_UOM.milimeter }),
        },
        {
          attribute: GeneratedAttributes["pressure"],
          description: "Tlak hidravlike stojala",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredHydraulicPressureBar, uom: MEASUREMENT_UOM.bar }),
        },
        {
          attribute: GeneratedAttributes["flow"],
          description: "Pretok mazanja ležajev",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredLubricationFlowLpm, uom: "l/min" }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Temperatura ležaja stojala",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredBearingTempC, uom: MEASUREMENT_UOM.celsius }),
        },
        {
          attribute: GeneratedAttributes["vibration"],
          description: "Vibracije stojala",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredVibrationMmS, uom: MEASUREMENT_UOM.milimeterPerSecond }),
        },
        {
          attribute: GeneratedAttributes["output-quantity"],
          description: "Merjena debelina po trenutnem prehodu",
          ...this.intervalValidity(),
          data: this.dataPayload(time, dataGroup, { value: state.measuredThicknessMm, uom: MEASUREMENT_UOM.milimeter }),
        },
      ],
    });
  }

  async publishWarehouseState(assetId: string, topicBase: string, batch: HrmBatch, time: string): Promise<void> {
    const state = batch.warehouse!;
    const failReasons = state.failReasons.join(" | ");
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    const virtualGroup = this.resolveVirtualGroup(assetId, { virtualGroup: "asset" });
    const previousMaterialAttribute = this.previousMaterialObjectIds(batch).length <= 1
      ? this.materialRelationshipEvidenceAttribute(batch, time, dataGroup)
      : undefined;

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Skladišče in laboratorij kakovosti",
      objectType: GeneratedObjectTypes["material"],
      objectId: this.materialObjectId(batch),
      virtualGroup,
      attributes: [
        {
          attribute: GeneratedAttributes["inspection-result"],
          description: "Končna izmerjena debelina",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.finalThicknessMm, uom: MEASUREMENT_UOM.milimeter }),
        },
        {
          attribute: GeneratedAttributes["deviation"],
          description: "Odstopanje debeline od specifikacije kakovosti",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.thicknessDeviationMm, uom: MEASUREMENT_UOM.milimeter }),
        },
        {
          attribute: GeneratedAttributes["pass-fail"],
          description: "Rezultat preverjanja kakovosti",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.passFail ? 1 : 0 }),
        },
        {
          attribute: GeneratedAttributes["hardness"],
          description: "Izmerjena trdota HB",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.hardnessHB, uom: "HB" }),
        },
        {
          attribute: GeneratedAttributes["surface-defect"],
          description: "Površinski razred",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.surfaceGrade }),
        },
        {
          attribute: GeneratedAttributes["temperature"],
          description: "Izstopna temperatura",
          data: this.dataPayload(time, dataGroup, { batchDataGroup: HRM_DATA_GROUPS.batch, value: state.finalTempC, uom: MEASUREMENT_UOM.celsius }),
        },
        ...(previousMaterialAttribute ? [previousMaterialAttribute] : []),
        {
          attribute: GeneratedAttributes["inspection-result"],
          description: "Povzetek laboratorijskega pregleda",
          ...this.lifecycleValidity("DONE"),
          table: this.tablePayload(time, dataGroup, {
            eventId: this.qualityInspectionEventId(batch, time),
            batchDataGroup: HRM_DATA_GROUPS.batch,
            columns: namedTableColumns([
              { name: "status",               type: "symbol", value: "DONE" },
              { name: "batchId",              type: "symbol", value: batch.batchId },
              { name: "materialId",           type: "symbol", value: batch.materialId },
              { name: "recipeId",             type: "symbol", value: batch.recipeId },
              { name: "specId",               type: "symbol", value: state.specId },
              { name: "inspectionStatus",     type: "symbol", value: state.passFail ? "PASSED" : "FAILED" },
              { name: "finalThicknessMm",     type: "double", value: state.finalThicknessMm, uom: MEASUREMENT_UOM.milimeter },
              { name: "finalTempC",           type: "double", value: state.finalTempC, uom: MEASUREMENT_UOM.celsius },
              { name: "hardnessHB",           type: "double", value: state.hardnessHB, uom: "HB" },
              { name: "surfaceGrade",         type: "symbol", value: state.surfaceGrade },
              { name: "thicknessDeviationMm", type: "double", value: state.thicknessDeviationMm, uom: MEASUREMENT_UOM.milimeter },
              { name: "tempDeviationC",       type: "double", value: state.tempDeviationC, uom: MEASUREMENT_UOM.celsius },
              { name: "failReasonCount",      type: "long",   value: state.failReasons.length },
              { name: "failReasons",          type: "string", value: failReasons || null },
            ]),
          }),
        },
      ],
    });
    await this.publishMaterialRelationshipEvidence(assetId, "Skladišče in laboratorij kakovosti", topicBase, batch, time);
  }

  // ─── Transition Events ────────────────────────────────────────────────────

  async publishMaterialTransition(
    assetId: string,
    assetDescription: string,
    topicBase: string,
    batch: HrmBatch,
    event: "ENTERED" | "EXITED",
    time: string,
    durationMin: number | null): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    const virtualGroup = this.resolveVirtualGroup(assetId, { virtualGroup: "asset" });
    const startTime = iso(batch.stageEnteredAt);
    const eventTime = iso(time);
    const columns: InternalTableColumn[] = [
      { name: "assetId",    type: "symbol",    value: assetId },
      { name: "assetName",  type: "symbol",    value: assetDescription },
      { name: "batchId",    type: "symbol",    value: batch.batchId },
      { name: "materialId", type: "symbol",    value: batch.materialId },
      { name: "recipeId",   type: "symbol",    value: batch.recipeId },
      { name: "stage",      type: "symbol",    value: batch.stage },
      { name: "event",      type: "symbol",    value: event },
      { name: "value",      type: "symbol",    value: event },
      { name: "startTime",  type: "timestamp", value: startTime },
    ];
    if (batch.repeatStage) {
      columns.push({ name: "repeatStage", type: "symbol", value: batch.repeatStage });
    }
    if (batch.mergeInputMaterialIds?.length) {
      columns.push({ name: "mergeInputMaterialIds", type: "string", value: batch.mergeInputMaterialIds.join(",") });
    }
    if (batch.mergeOutputMaterialId) {
      columns.push({ name: "mergeOutputMaterialId", type: "symbol", value: batch.mergeOutputMaterialId });
    }

    if (event === "EXITED") {
      columns.push(
        { name: "endTime",     type: "timestamp", value: eventTime },
        { name: "durationMin", type: "double",    value: durationMin ?? 0 },
      );
    }

    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription,
      objectType: GeneratedObjectTypes["material"],
      objectId: this.materialObjectId(batch),
      virtualGroup,
      attributes: [
        {
          attribute: GeneratedAttributes["location"],
          description: "Dogodek prehoda materiala med postajami",
          ...this.lifecycleValidity("EXITED"),
          table: this.tablePayload(time, dataGroup, {
            eventId: this.materialTransitionEventId(assetId, batch, event, time),
            batchDataGroup: HRM_DATA_GROUPS.batch,
            columns: namedTableColumns(columns),
          }),
        },
      ],
    });
  }

  async publishPassComplete(
    assetId: string,
    topicBase: string,
    batch: HrmBatch,
    pass: PassEvent,
    time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription: "Reverzirno valjarsko ogrodje",
      objectType: GeneratedObjectTypes["equipment"],
      objectId: "stand-1",
      attributes: [
        {
          attribute: GeneratedAttributes["output-quantity"],
          description: "Dogodek zaključka valjarskega prehoda",
          ...this.lifecycleValidity("DONE"),
          table: this.tablePayload(time, dataGroup, {
            eventId: this.passCompletionEventId(batch, pass.passNumber, time),
            columns: namedTableColumns([
              { name: "status",           type: "symbol", value: "DONE" },
              { name: "batchId",          type: "symbol", value: batch.batchId },
              { name: "materialId",       type: "symbol", value: batch.materialId },
              { name: "direction",        type: "symbol", value: pass.direction },
              { name: "passNumber",       type: "long",   value: pass.passNumber },
              { name: "startThicknessMm", type: "double", value: pass.startThicknessMm, uom: MEASUREMENT_UOM.milimeter },
              { name: "endThicknessMm",   type: "double", value: pass.endThicknessMm,   uom: MEASUREMENT_UOM.milimeter },
              { name: "reductionMm",      type: "double", value: Number((pass.startThicknessMm - pass.endThicknessMm).toFixed(2)), uom: MEASUREMENT_UOM.milimeter },
              { name: "durationSec",      type: "double", value: pass.durationSec },
            ]),
          }),
        },
      ],
    });
  }

  async publishAlarm(
    assetId: string,
    assetDescription: string,
    objectId: string,
    topicBase: string,
    alarm: AlarmEvent,
    time: string): Promise<void> {
    const dataGroup = this.resolveDataGroup(assetId, { dataGroup: "asset" });
    await this.publishMqttMessage({
      topic: topicBase,
      asset: assetId,
      assetDescription,
      objectType: GeneratedObjectTypes["equipment"],
      objectId,
      attributes: [
        {
          attribute: GeneratedAttributes["alarm"],
          description: `${alarm.code} alarmni dogodek`,
          ...this.lifecycleValidity("CLEARED"),
          table: this.tablePayload(time, dataGroup, {
            eventId: this.alarmEventId(assetId, objectId, alarm.code, alarm.state, time),
            columns: namedTableColumns([
              { name: "alarmCode",     type: "symbol", value: alarm.code },
              { name: "severity",      type: "symbol", value: alarm.severity },
              { name: "state",         type: "symbol", value: alarm.state },
              { name: "message",       type: "string", value: alarm.message },
              { name: "measuredValue", type: "double", value: alarm.measuredValue, uom: MEASUREMENT_UOM.celsius },
              { name: "threshold",     type: "double", value: alarm.threshold, uom: MEASUREMENT_UOM.celsius },
            ]),
          }),
        },
      ],
    });
  }
}
