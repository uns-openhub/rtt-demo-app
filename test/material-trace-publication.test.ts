import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {MqttHrmTransport, type IHrmTransport} from "../src/hrm/hrm-publisher.js";
import {HrmProductionLine} from "../src/hrm/hrm-production-line.js";
import type {HrmBatch,HrmConfig} from "../src/hrm/hrm-types.js";
import {UnsPacket} from "@uns-kit/core/uns/uns-packet.js";
const config = JSON.parse(fs.readFileSync(new URL('../config-development-podman.json',import.meta.url),'utf8')).hrm as HrmConfig;
const time='2026-10-04T12:00:00.000Z';
function batch(): HrmBatch {
  return {batchId:'merge-batch',materialId:'output',quantity:1,recipeId:config.recipes[0]!.id,recipe:config.recipes[0]!,stage:'WAREHOUSE',stageEnteredAt:time,createdAt:time,ticksInStage:0,
    previousMaterialObjectIds:['input-a-2','input-b-2','input-a-2'],mergeInputMaterialIds:['input-a','input-b'],mergeOutputMaterialId:'output',
    measured:{rollingSpeedSumMps:0,rollingSpeedSamples:0},warehouse:{specId:'spec',finalThicknessMm:20,finalTempC:800,hardnessHB:130,surfaceGrade:'A',passFail:true,thicknessDeviationMm:0,tempDeviationC:0,failReasons:[]}};
}
function capture() {
  const packets:any[]=[];
  const transport=new MqttHrmTransport({publishMqttMessage:async(message:unknown)=>{packets.push(message);}} as never,1000);
  return {transport,packets,attributes:()=>packets.flatMap(p=>p.attributes)};
}
test('publishes the complete merge predecessor list as one valid scalar wire packet',async()=>{
  const {transport,attributes}=capture();await transport.publishWarehouseState('hrm-warehouse',config.topicBase,batch(),time);
  const evidence=attributes().filter(a=>a.attribute==='merge-from-materials');assert.equal(evidence.length,1);
  assert.deepEqual(JSON.parse(evidence[0].data.value),['input-a-2','input-b-2']);
  assert.equal(evidence[0].relationshipEvidence.relationshipKey,'material-merge');assert.equal(evidence[0].relationshipEvidence.sourceObjectIdFrom,'value[]');assert.equal(evidence[0].relationshipEvidence.defaultStatus,'suggested');
  UnsPacket.validateMessageComponents(evidence[0].data,undefined);
});
test('keeps a single predecessor scalar and backwards compatible',async()=>{
  const {transport,attributes}=capture();const input=batch();input.previousMaterialObjectIds=['input-a-2'];await transport.publishWarehouseState('hrm-warehouse',config.topicBase,input,time);
  assert.equal(attributes().find(a=>a.attribute==='previous-material').data.value,'input-a-2');
});
test('separates final thickness Data from the inspection Table',async()=>{
  const {transport,attributes}=capture();await transport.publishWarehouseState('hrm-warehouse',config.topicBase,batch(),time);
  const inspection=attributes().filter(a=>a.attribute==='inspection-result');assert.equal(inspection.length,1);assert.ok(inspection[0].table);assert.equal(inspection[0].data,undefined);
  const thickness=attributes().find(a=>a.attribute==='thickness');assert.equal(thickness.data.value,20);assert.equal(thickness.presentationKind,'gauge');
});
test('separates stand thickness readings from completed-pass events',async()=>{
  const {transport,attributes}=capture();const b=batch();b.stage='ROLLING';b.rolling={measuredThicknessMm:20} as never;
  await transport.publishRollingState('hrm-stand-1',config.topicBase,b,time);
  await transport.publishPassComplete('hrm-stand-1',config.topicBase,b,{passNumber:1,direction:'forward',startThicknessMm:200,endThicknessMm:150,durationSec:60},time);
  assert.equal(attributes().find(a=>a.attribute==='thickness').data.value,20);
  assert.ok(attributes().find(a=>a.attribute==='rolling-pass').table);assert.equal(attributes().some(a=>a.attribute==='output-quantity'),false);
});
test('retains warehouse entry time and stage in EXITED before final status',()=>{
  const transitions:any[][]=[];
  const transport=new Proxy({}, {get:(_target,method)=>async(...args:unknown[])=>{if(method==='publishMaterialTransition') transitions.push(args);}}) as IHrmTransport;
  const line=new HrmProductionLine({...config,simulationStartTime:time},[transport]);
  const inputs=['trace-a','trace-b'];for(const materialId of inputs) line.submitBatch({recipeId:config.recipes[0]!.id,materialId,quantity:1,repeatStage:'descaling',mergeInputMaterialIds:inputs,mergeOutputMaterialId:'trace-output'});
  for(let tick=0;tick<3000 && line.getState().completed.length===0;tick++) line.tick(tick);
  const completed=line.getState().completed;assert.equal(completed.length,1);
  const events=transitions.filter(args=>(args[3] as HrmBatch).materialId==='trace-output');
  const entry=events.find(args=>args[4]==='ENTERED')!;const exit=events.find(args=>args[4]==='EXITED')!;
  assert.equal((exit[3] as HrmBatch).stage,'WAREHOUSE');assert.equal((exit[3] as HrmBatch).stageEnteredAt,(entry[3] as HrmBatch).stageEnteredAt);
  assert.ok(Date.parse(exit[5] as string)>Date.parse((exit[3] as HrmBatch).stageEnteredAt));
  assert.ok(['DONE','FAILED'].includes(line.getBatch(completed[0]!.batchId)!.stage));
});

test('samples every occupied furnace material and publishes shared equipment only once per tick',()=>{
  const samples:Array<{method:PropertyKey;batch:HrmBatch;time:string}>=[];
  const transport=new Proxy({}, {get:(_target,method)=>async(...args:unknown[])=>{
    if(method==='publishFurnaceState'||method==='publishFurnaceMaterialState') {
      samples.push({method,batch:args[2] as HrmBatch,time:args[3] as string});
    }
  }}) as IHrmTransport;
  const line=new HrmProductionLine({...config,simulationStartTime:time},[transport]);
  for(const materialId of ['overlap-a','overlap-b','overlap-c']) {
    line.submitBatch({recipeId:config.recipes[0]!.id,materialId,quantity:1});
  }
  let overlappingTicks=0;
  for(let tick=0;tick<300;tick++) {
    const start=samples.length;
    line.tick(tick);
    const occupied=line.getState().stations.furnace.furnaceMaterials??[];
    const current=samples.slice(start);
    assert.deepEqual(current.map(s=>s.batch.materialId).sort(),occupied.map(m=>m.materialId).sort());
    assert.equal(current.filter(s=>s.method==='publishFurnaceState').length,occupied.length?1:0);
    for(const sample of current) {
      assert.equal(sample.time,line.getState().timestamp);
      assert.equal(sample.batch.furnace!.measuredMaterialTempC,
        occupied.find(m=>m.materialId===sample.batch.materialId)!.measuredMaterialTempC);
    }
    if(occupied.length>1) overlappingTicks++;
  }
  assert.ok(overlappingTicks>5,'exercise concurrent furnace occupancy');
  const first=samples[0]!;
  assert.equal(first.batch.stage,'FURNACE','a later tick must not mutate a queued sample');
  assert.notEqual(first.batch,line.getBatch(first.batch.batchId));
});

test('additional material telemetry retains the material path and does not repeat equipment',async()=>{
  const {transport,packets}=capture();
  const b=batch();b.stage='FURNACE';b.materialId='overlap-b';
  b.furnace={measuredMaterialTempC:725.5} as NonNullable<HrmBatch['furnace']>;
  await transport.publishFurnaceMaterialState('hrm-furnace',config.topicBase,b,time);
  assert.equal(packets.length,1);
  const packet=packets[0];
  assert.equal(packet.objectType,'material');assert.equal(packet.objectId,'overlap-b');
  assert.equal(packet.attributes.length,1);assert.equal(packet.attributes[0].attribute,'temperature');
  assert.equal(packet.attributes[0].data.value,725.5);
  assert.equal(packet.attributes[0].data.time,time);
  assert.equal(packet.attributes[0].data.batchDataGroup,'batch');
});

test('split packets declare the source batch and label inherited inspection',async()=>{
  const {transport,attributes}=capture();const child=batch();
  child.splitSourceBatchId='parent-batch';child.splitSourceMaterialId='parent';child.previousMaterialObjectIds=['parent-3'];
  await transport.publishWarehouseState('hrm-warehouse',config.topicBase,child,time);
  await transport.publishMaterialTransition('hrm-warehouse','Warehouse',config.topicBase,child,'ENTERED',time,null);
  assert.equal(attributes().find(a=>a.attribute==='split-from-material').data.value,'parent-3');
  assert.equal(attributes().find(a=>a.attribute==='split-from-material').relationshipEvidence.relationshipKey,'material-split');
  const tables=attributes().filter(a=>a.table);
  for(const table of tables){
    assert.equal(table.table.columns.splitSourceBatchId.value,'parent-batch');
    assert.equal(table.table.columns.splitSourceMaterialId.value,'parent');
    assert.equal(table.table.columns.measurementOrigin.value,'inherited');
    UnsPacket.validateMessageComponents(undefined,table.table);
  }
});

test('actual split and merge declare every concrete input/output once, retained on replay',async()=>{
  const {transport,packets}=capture();
  const line=new HrmProductionLine({...config,simulationStartTime:time},[]);
  const source=line.submitBatch({recipeId:config.recipes[0]!.id,materialId:'manifest-source',quantity:1});
  for(let tick=0;tick<3000 && !['DONE','FAILED'].includes(line.getBatch(source.batchId)!.stage);tick++)line.tick(tick);
  const split=line.splitMaterial({requestId:'manifest-split',sourceBatchId:source.batchId,outputMaterialIds:['manifest-b','manifest-c']});
  assert.equal(split.ok,true);if(!split.ok)return;
  const manifests:any[]=[];
  for(const output of split.value.outputs){
    const child=line.getBatch(output.batchId)!;
    await transport.publishWarehouseState(config.productionLine.warehouse.assetId,config.topicBase,child,time);
    await transport.publishWarehouseState(config.productionLine.warehouse.assetId,config.topicBase,child,'2026-10-04T12:00:01Z');
    const evidence=packets.flatMap(p=>p.attributes).filter(a=>a.attribute==='split-from-material').at(-1);
    UnsPacket.validateMessageComponents(evidence.data,undefined);
    const envelope=JSON.parse(evidence.data.value);assert.equal(envelope.format,'uns.relationship-operation.v1');
    assert.equal(envelope.value,'manifest-source-3');assert.equal(envelope.manifest.outputs.length,2);assert.equal(envelope.manifest.inputs.length,1);
    assert.ok(envelope.manifest.outputs.some((e:any)=>e.objectId===`${output.materialId}-3`));
    assert.ok(envelope.manifest.inputs[0].fullTopic.endsWith(`/${config.productionLine.warehouse.assetId}/material/manifest-source-3/`));
    manifests.push(envelope.manifest);
  }
  assert.deepEqual(manifests[0],manifests[1]);assert.equal(manifests[0].operationId,split.value.operationId);
  assert.deepEqual(line.splitMaterial({requestId:'manifest-split',sourceBatchId:source.batchId,outputMaterialIds:['manifest-b','manifest-c']}),split);
  const mergeLine=new HrmProductionLine({...config,simulationStartTime:time},[]);
  for(const materialId of ['manifest-i','manifest-j'])mergeLine.submitBatch({recipeId:config.recipes[0]!.id,materialId,quantity:1,mergeInputMaterialIds:['manifest-i','manifest-j'],mergeOutputMaterialId:'manifest-out'});
  for(let tick=0;tick<3000 && !mergeLine.getState().completed.length;tick++)mergeLine.tick(tick);
  const output=mergeLine.getBatch(mergeLine.getState().completed[0]!.batchId)!;
  const manifest=output.operationManifest!;assert.equal(manifest.kind,'merge');assert.equal(manifest.inputs.length,2);assert.equal(manifest.outputs.length,1);
  assert.ok(manifest.inputs.every(e=>e.fullTopic.includes(`/${config.productionLine.rollingStand.assetId}/material/`)));
  await transport.publishWarehouseState(config.productionLine.warehouse.assetId,config.topicBase,output,time);
  const evidence=packets.flatMap(p=>p.attributes).findLast(a=>a.attribute==='merge-from-materials');
  const envelope=JSON.parse(evidence.data.value);assert.deepEqual(envelope.manifest,manifest);assert.deepEqual(JSON.parse(envelope.value),['manifest-i-2','manifest-j-2']);
});


test('published manifest producer declares its minimum Controller reader',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.unsDatahub.controllerCompatibility,'>=2.2.13 <3');
});
