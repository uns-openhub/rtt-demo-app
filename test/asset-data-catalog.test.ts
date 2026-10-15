import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerFurnaceAssetDataOffer } from "../src/hrm/asset-data-catalog.js";
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
