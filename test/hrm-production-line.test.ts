import assert from "node:assert/strict";
import test from "node:test";
import { HrmProductionLine } from "../src/hrm/hrm-production-line.js";
import type { HrmConfig } from "../src/hrm/hrm-types.js";

const config: HrmConfig = {
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
  recipes: [{
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
      passes: [{
        passNumber: 1,
        direction: "forward",
        targetThicknessMm: 20,
        speedMps: 2,
      }],
    },
  }],
  qualitySpecs: [{
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
  }],
};

test("rejects a materialId that already belongs to a batch in this simulation run", () => {
  const line = new HrmProductionLine(config, []);
  const first = line.submitBatch({
    recipeId: "recipe-1",
    materialId: "slab-001",
    quantity: 1,
  });
  const duplicate = line.submitBatch({
    recipeId: "recipe-1",
    materialId: "slab-001",
    quantity: 1,
  });

  assert.equal(first.status, "accepted");
  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.batchId, "");
  assert.match(duplicate.reason ?? "", /already belongs to batch/);
  assert.deepEqual(line.getState().queue.map((entry) => entry.materialId), ["slab-001"]);
});

test('splits an actual completed source once into two distinct warehouse batches', () => {
  const line = new HrmProductionLine(config, []);
  const parent = line.submitBatch({recipeId: config.recipes[0]!.id, materialId: 'split-source', quantity: 3});
  for (let tick=0; tick<3000 && !line.getState().completed.length; tick++) line.tick(tick);
  const source = line.getBatch(parent.batchId)!;
  assert.ok(['DONE','FAILED'].includes(source.stage));
  const before = structuredClone(source);
  const request = {sourceBatchId: parent.batchId, requestId: 'split-001', outputMaterialIds: ['split-a','split-b'] as [string,string]};
  const result = line.splitMaterial(request); assert.equal(result.ok,true); if (!result.ok) return;
  assert.equal(result.value.outputs.length,2);
  assert.equal(new Set(result.value.outputs.map(o=>o.batchId)).size,2);
  assert.equal(result.value.outputs.reduce((sum,o)=>sum+o.quantity,0),source.quantity);
  assert.deepEqual(line.splitMaterial(request),result);
  result.value.outputs[0]!.materialId='mutated';
  assert.equal(source.splitReceipt!.outputs[0]!.materialId,'split-a');
  assert.equal(line.splitMaterial({...request,requestId:'another'}).ok,false);
  assert.equal(line.splitMaterial({...request,outputMaterialIds:['different','split-b']}).ok,false);
  assert.deepEqual(source.measured,before.measured);
  for(let tick=0;tick<15;tick++)line.tick(tick);
  for(const output of source.splitReceipt!.outputs){
    const child=line.getBatch(output.batchId)!;
    assert.ok(['DONE','FAILED'].includes(child.stage));
    assert.equal(child.splitSourceBatchId,source.batchId);
    assert.deepEqual(child.previousMaterialObjectIds,['split-source-3']);
    assert.equal(child.traceStartedAt,source.createdAt);
    assert.deepEqual(child.warehouse,source.warehouse);
    assert.deepEqual(child.measured,source.measured);
    assert.equal(child.furnace,undefined);
    assert.equal(child.rolling,undefined);
  }
  assert.equal(line.getState().completed.length,3);
});

test('invalid, active and conflicting split requests have no partial side effects',()=>{
  const line=new HrmProductionLine(config,[]);
  const source=line.submitBatch({recipeId:config.recipes[0]!.id,materialId:'guard-source',quantity:1});
  const request={sourceBatchId:source.batchId,requestId:'guard',outputMaterialIds:['child-a','child-b'] as [string,string]};
  assert.equal(line.splitMaterial(request).ok,false);
  for(let tick=0;tick<3000&&!line.getState().completed.length;tick++)line.tick(tick);
  for(const body of [null,{}, {...request,outputMaterialIds:['a','a']},{...request,outputMaterialIds:['bad/path','b']},{...request,outputMaterialIds:['a',2]},{...request,sourceBatchId:'missing'},{...request,outputMaterialIds:['guard-source','b']}]){
    assert.equal(line.splitMaterial(body as any).ok,false);
    assert.equal(line.getBatch(source.batchId)!.splitReceipt,undefined);
    assert.equal(line.getState().completed.length,1);
  }
});
