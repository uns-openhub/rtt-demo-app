import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerFurnaceAssetDataOffer, registerMobileEquipmentDataOffers } from "../src/hrm/asset-data-catalog.js";
import type { HrmConfig } from "../src/hrm/hrm-types.js";
const config = () => JSON.parse(readFileSync("config-development-host.json", "utf8")).hrm as HrmConfig;
const id = "11111111-1111-4111-8111-111111111111";
test("offer retains stable selector and id when the configured path moves", async () => {
  const offers: any[] = [];
  for (const topicBase of ["local/line-a", "local/line-b"]) {
    const c = config(); c.topicBase = topicBase;
    assert.equal(await registerFurnaceAssetDataOffer({ config:c, identities:{forAsset:async()=>({assetStableEntityId:id,assetIdentityProof:"private-proof"})}, register:offer=>offers.push(offer),processName:"simulator",apiBasePath:"/custom" }),true);
  }
  assert.deepEqual(offers[0],offers[1]);
  assert.equal(offers[0].operations[0].path,"/custom/system/hrm/service/simulator/status");
  assert.deepEqual(offers[0].metadata.assetIdentity,{version:1,stableEntityId:id,attributePath:"equipment/zone-1/temperature"});
  assert(!JSON.stringify(offers).includes("private-proof"));
});
test("unconfigured, unresolved and provider-only identity never create a misleading offer", async () => {
  const c = config();delete c.productionLine.furnace.identity;
  let calls=0;let offers=0;
  assert.equal(await registerFurnaceAssetDataOffer({config:c,identities:{forAsset:async()=>{calls++;return undefined;}},register:()=>{offers++;},processName:"simulator"}),false);
  assert.equal(calls,0);
  const provider={providerId:"demo.mes",externalSystem:"mes",externalType:"equipment.code",externalId:"1"};
  for(const evidence of [undefined,{assetProviderIdentity:provider,assetProviderIdentityProof:"private-proof"}]) {
    assert.equal(await registerFurnaceAssetDataOffer({config:config(),identities:{forAsset:async()=>evidence},register:()=>{offers++;},processName:"simulator"}),false);
  }
  assert.equal(offers,0);
});

test("mobile offers use independent stable IDs and nested proof paths without path-pinned selectors", async () => {
  const offers: any[] = [];const calls:any[]=[];const c=config();c.topicBase="local/mobile";
  const identities=[id,"22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
  const count=await registerMobileEquipmentDataOffers({config:c,identities:{forAsset:async(assetId,base)=>{calls.push([assetId,base]);return {assetStableEntityId:identities[calls.length-1]!,assetIdentityProof:"private-proof"};}},register:offer=>offers.push(offer),processName:"simulator"});
  assert.equal(count,3);assert.deepEqual(calls.map(c=>c[1]),["local/mobile/hrm-stand-1","local/mobile/hrm-stand-1/roll-cassette-001","local/mobile/hrm-stand-1/roll-cassette-001"]);
  assert.deepEqual(offers.map(o=>o.metadata.assetIdentity.stableEntityId),identities);
  for(const o of offers){assert.equal(o.metadata.assetIdentity.attributePath,"equipment/main/temperature");assert(!JSON.stringify(o).includes("private-proof"));assert(!JSON.stringify(o.metadata).includes("local/mobile"));}
});
test("mobile offers remain optional and never imply an unverified identity", async () => {
  const c=config();delete c.productionLine.rollingStand.mobileCassette;
  const input={config:c,identities:{forAsset:async()=>undefined},register:()=>{throw Error("No offer expected");},processName:"simulator"};
  assert.equal(await registerMobileEquipmentDataOffers(input),0);
  input.config=config();assert.equal(await registerMobileEquipmentDataOffers(input),0);
});
