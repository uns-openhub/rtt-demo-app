import type { HrmConfig } from "../../src/hrm/hrm-types.js";
export const config: HrmConfig = {
  topicBase: "example/manufacturing/line/",
  tickIntervalMs: 1000,
  simulationStartTime: "2026-08-05T10:00:00.000Z",
  simulationSpeed: 30,
  simulationResolution: 100,
  productionLine: {
    furnace: {
      assetId: "furnace",
      description: "Test furnace",
      zones: 1,
      maxTempC: 1300,
      gasConsumptionNm3PerHour: 100,
    },
    descaling: {
      assetId: "descaling",
      description: "Test descaling",
      nominalPressureBar: 200,
      nominalFlowM3PerHour: 12,
      durationMin: 5,
    },
    rollingStand: {
      assetId: "rolling",
      description: "Test rolling stand",
      nominalSpeedMps: 2,
      maxMotorPowerKw: 3000,
      maxForceKn: 18000,
      durationMinPerPass: 3,
    },
    warehouse: {
      assetId: "warehouse",
      description: "Test warehouse",
    },
  },
  recipes: [
    {
      id: "recipe-1",
      name: "Test recipe",
      materialType: "test-material",
      targetThicknessMm: 20,
      targetWidthMm: 1500,
      initialThicknessMm: 200,
      furnace: {
        targetTempC: 1200,
        pusherPaceMin: 12,
        stoichiometricRatioTarget: 1.03,
        soakingTimeMin: 45,
        zones: [{ zoneId: 1, setpointC: 1200 }],
      },
      rollingPlan: {
        passes: [
          {
            passNumber: 1,
            direction: "forward",
            targetThicknessMm: 20,
            speedMps: 2,
          },
        ],
      },
    },
  ],
  qualitySpecs: [
    {
      id: "quality-1",
      name: "Test quality",
      applicableMaterialType: "test-material",
      idealThicknessMm: 20,
      thicknessToleranceMm: 1,
      idealExitTempC: 900,
      exitTempToleranceC: 50,
      minHardnessHB: 100,
      maxHardnessHB: 300,
      surfaceGrade: "A",
    },
  ],
};
