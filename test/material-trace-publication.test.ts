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
  const evidence=attributes().filter(a=>a.attribute==='previous-materials');assert.equal(evidence.length,1);
  assert.deepEqual(JSON.parse(evidence[0].data.value),['input-a-2','input-b-2']);
  assert.equal(evidence[0].relationshipEvidence.sourceObjectIdFrom,'value[]');assert.equal(evidence[0].relationshipEvidence.defaultStatus,'suggested');
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
