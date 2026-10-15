import { z } from "zod";

// ─── HRM Schemas ──────────────────────────────────────────────────────────────

const furnaceZoneSetpointSchema = z.object({
  zoneId: z.number().int().positive(),
  setpointC: z.number().positive(),
});

const furnaceRecipeSchema = z.object({
  targetTempC: z.number().positive(),
  pusherPaceMin: z.number().positive(),
  stoichiometricRatioTarget: z.number().positive(),
  soakingTimeMin: z.number().positive(),
  zones: z.array(furnaceZoneSetpointSchema).min(1),
});

const rollingPassSchema = z.object({
  passNumber: z.number().int().positive(),
  direction: z.enum(["forward", "reverse"]),
  targetThicknessMm: z.number().positive(),
  speedMps: z.number().positive(),
});

const recipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  materialType: z.string().min(1),
  targetThicknessMm: z.number().positive(),
  targetWidthMm: z.number().positive(),
  initialThicknessMm: z.number().positive(),
  furnace: furnaceRecipeSchema,
  rollingPlan: z.object({
    passes: z.array(rollingPassSchema).min(1),
  }),
});

const qualitySpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  applicableMaterialType: z.string().min(1),
  idealThicknessMm: z.number().positive(),
  thicknessToleranceMm: z.number().positive(),
  idealExitTempC: z.number().positive(),
  exitTempToleranceC: z.number().positive(),
  minHardnessHB: z.number().positive(),
  maxHardnessHB: z.number().positive(),
  surfaceGrade: z.string().min(1),
});

const assetIdentitySchema = z.object({
  providerId: z.string().min(1),
  externalSystem: z.string().min(1),
  externalType: z.string().min(1),
  externalId: z.string().min(1),
});

const assetConfigSchema = z.object({
  assetId: z.string().min(1),
  description: z.string().min(1),
  identity: assetIdentitySchema.optional(),
});

const furnaceConfigSchema = assetConfigSchema.extend({
  zones: z.number().int().positive(),
  maxTempC: z.number().positive(),
  gasConsumptionNm3PerHour: z.number().positive(),
});

const descalingConfigSchema = assetConfigSchema.extend({
  nominalPressureBar: z.number().positive(),
  nominalFlowM3PerHour: z.number().positive(),
  durationMin: z.number().positive(),
});

const rollingStandConfigSchema = assetConfigSchema.extend({
  nominalSpeedMps: z.number().positive(),
  maxMotorPowerKw: z.number().positive(),
  maxForceKn: z.number().positive(),
  durationMinPerPass: z.number().positive(),
  mobileCassette: assetConfigSchema.extend({
    assetId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    identity: assetIdentitySchema,
    initialLocation: z.enum(["stand", "store", "workshop"]).default("stand"),
    storeAssetId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    workshopAssetId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    upperRoll: assetConfigSchema.extend({
      assetId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
      identity: assetIdentitySchema,
      nominalDiameterMm: z.number().positive(),
    }),
    lowerRoll: assetConfigSchema.extend({
      assetId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
      identity: assetIdentitySchema,
      nominalDiameterMm: z.number().positive(),
    }),
  }).optional(),
});

const warehouseConfigSchema = assetConfigSchema;

const queueConfigSchema = assetConfigSchema;

const hrmSchema = z.object({
  reviewedLifecycle:z.object({contractFile:z.string().min(1),contractDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),stateFile:z.string().min(1),maintenanceState:z.string().min(1).default('maintenance')}).strict().optional(),
  topicBase: z.string().min(1),
  tickIntervalMs: z.number().int().positive().default(2000),
  simulationStartTime: z.string().datetime().optional(),
  simulationSpeed: z.number().positive().default(1),
  simulationResolution: z.number().min(1).max(100).default(100),
  productionLine: z.object({
    queue: queueConfigSchema.optional(),
    furnace: furnaceConfigSchema,
    descaling: descalingConfigSchema,
    rollingStand: rollingStandConfigSchema,
    warehouse: warehouseConfigSchema,
  }),
  recipes: z.array(recipeSchema).min(1),
  qualitySpecs: z.array(qualitySpecSchema).min(1),
}).superRefine((config, context) => {
  const cassette = config.productionLine.rollingStand.mobileCassette;
  if (!cassette) return;
  const assets = [...Object.values(config.productionLine), cassette, cassette.upperRoll, cassette.lowerRoll].filter(Boolean);
  const ids = assets.map(asset => asset!.assetId);
  const identities = assets.flatMap(asset => asset?.identity ? [JSON.stringify({
    providerId: asset.identity.providerId.trim().toLowerCase(),
    externalSystem: asset.identity.externalSystem.trim().toLowerCase(),
    externalType: asset.identity.externalType.trim().toLowerCase(),
    externalId: asset.identity.externalId.trim(),
  })] : []);
  if (new Set(ids).size !== ids.length || new Set(identities).size !== identities.length ||
      cassette.storeAssetId === cassette.workshopAssetId || ids.includes(cassette.storeAssetId) || ids.includes(cassette.workshopAssetId)) {
    context.addIssue({code: "custom", path: ["productionLine", "rollingStand", "mobileCassette"],
      message: "Equipment identifiers, external identities and store/workshop locations must be distinct."});
  }
});

// ─── Project Extras Schema ────────────────────────────────────────────────────

export const projectExtrasSchema = z.object({
  hrm: hrmSchema.optional(),
});

export type ProjectExtras = z.infer<typeof projectExtrasSchema>;
