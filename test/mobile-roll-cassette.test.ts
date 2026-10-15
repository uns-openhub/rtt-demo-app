import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobileRollCassette } from "../src/hrm/mobile-roll-cassette.js";
import { HrmProductionLine } from "../src/hrm/hrm-production-line.js";
import { AssetIdentityPublicationProvider } from "../src/hrm/asset-identity-publication.js";
import { MqttHrmTransport } from "../src/hrm/hrm-publisher.js";
import { projectExtrasSchema } from "../src/config/project.config.extension.js";
import type { HrmConfig } from "../src/hrm/hrm-types.js";
import { serviceApis } from "../src/api-routes.js";

const config = (): HrmConfig => JSON.parse(readFileSync(new URL("../config-development-host.json", import.meta.url), "utf8")).hrm;
function fixture() {
  const c = config();
  const equipment = new MobileRollCassette(c.productionLine.rollingStand.mobileCassette!, c.topicBase, c.productionLine.rollingStand.assetId);
  const rolling = {...new HrmProductionLine(c, []).getState().stations.rolling.state!,
    subState: "ROLLING" as const, measuredSpeedMps: 2.5, measuredBearingTempC: 65, measuredVibrationMmS: 1.2};
  return {c, equipment, rolling};
}

test("cassette carries independent rolls, working measurements, and counters across moves", () => {
  const {equipment, rolling} = fixture();
  equipment.advance(60000, true, rolling);
  const before = equipment.snapshot(false);
  assert.equal(before.cassette.operatingSeconds, 60);
  assert.ok(before.cassette.temperatureC > 22);
  assert.equal(before.cassette.vibrationMmS, 1.2);
  assert.ok(before.rolls.every(r => r.speedRpm > 0 && r.wearMm! > 0 && r.diameterMm! < 600));
  equipment.move("workshop", before.revision, before.runId, false);
  equipment.advance(60000, false, rolling);
  const after = equipment.snapshot(false);
  assert.ok(after.cassette.assetPath.includes("/hrm-roll-workshop/"));
  assert.equal(after.cassette.externalId, before.cassette.externalId);
  assert.equal(after.cassette.operatingSeconds, before.cassette.operatingSeconds);
  assert.ok(after.cassette.temperatureC < before.cassette.temperatureC);
  for (let i = 0; i < 2; i++) {
    assert.equal(after.rolls[i]!.externalId, before.rolls[i]!.externalId);
    assert.equal(after.rolls[i]!.wearMm, before.rolls[i]!.wearMm);
    assert.equal(after.rolls[i]!.speedRpm, 0);
    assert.ok(after.rolls[i]!.assetPath.startsWith(after.cassette.assetPath + "/"));
  }
});

test("moves reject occupied stand, stale revisions and previous simulator runs", () => {
  const {equipment} = fixture(); const a = equipment.snapshot(false);
  assert.throws(() => equipment.move("store", a.revision, a.runId, true), /empty/);
  assert.throws(() => equipment.move("store", a.revision, "old-run", false), /restarted/);
  equipment.move("store", a.revision, a.runId, false);
  assert.throws(() => equipment.move("workshop", a.revision, a.runId, false), /changed/);
  assert.equal(equipment.snapshot(false).location, "store");
});

test("moves wait for pending publication and can return to a previous location", () => {
  const {equipment} = fixture(); const a = equipment.snapshot(false);
  equipment.publicationState = "sending";
  assert.throws(() => equipment.move("store", a.revision, a.runId, false), /publication/);
  equipment.publicationState = "sent";
  equipment.move("store", a.revision, a.runId, false);
  const b = equipment.snapshot(false);
  equipment.move("stand", b.revision, b.runId, false);
  assert.equal(equipment.snapshot(false).cassette.assetPath, a.cassette.assetPath);
  assert.equal(equipment.snapshot(false).revision, 3);
});

test("missing cassette preserves older simulator configurations; invalid duplicate identities are rejected", () => {
  const c = config(); assert.ok(projectExtrasSchema.safeParse({hrm: c}).success);
  c.productionLine.rollingStand.mobileCassette!.lowerRoll.identity.externalId = c.productionLine.rollingStand.mobileCassette!.upperRoll.identity.externalId;
  assert.equal(projectExtrasSchema.safeParse({hrm: c}).success, false);
  delete c.productionLine.rollingStand.mobileCassette;
  assert.ok(projectExtrasSchema.safeParse({hrm: c}).success);
  assert.equal(new HrmProductionLine(c, []).getState().mobileCassette, undefined);
});

test("production waits before rolling while the cassette is away", () => {
  const c = config(); c.simulationSpeed = 100;
  for (const recipe of c.recipes) {
    recipe.furnace.targetTempC = 30; recipe.furnace.pusherPaceMin = .001; recipe.furnace.soakingTimeMin = .001;
    recipe.furnace.zones.forEach(z => z.setpointC = 30);
  }
  c.productionLine.descaling.durationMin = .001;
  const line = new HrmProductionLine(c, []); const a = line.getState().mobileCassette!;
  line.moveRollCassette("store", a.revision, a.runId);
  line.submitBatch({recipeId: c.recipes[0]!.id, materialId: "cassette-check", quantity: 1});
  for (let i = 0; i < 300; i++) line.tick(i);
  assert.equal(line.getState().stations.rolling.occupied, false);
  assert.equal(line.getState().stations.descaling.occupied, true);
  const b = line.getState().mobileCassette!;
  line.moveRollCassette("stand", b.revision, b.runId);
  line.tick(301);
  assert.equal(line.getState().stations.rolling.occupied, true);
});

test("publisher withdraws only old cassette subtree and issues a separate proof for every leaf", async () => {
  const {c, equipment} = fixture();
  const published: any[] = [], inventories: string[][] = [], calls: string[] = [];
  const output = {publishMqttMessage: async (m: unknown) => {published.push(m);}, flush: async () => {calls.push("flush");},
    retainProducedTopics: (topics: Iterable<string>) => {calls.push("retain");inventories.push([...topics]);}};
  const provider = {forAsset: async (asset: string, topic: string) => ["roll-cassette-001", "upper-work-roll-001", "lower-work-roll-001"].includes(asset) ? ({assetStableEntityId: `identity-${asset}`, assetIdentityProof: `proof-${topic}/${asset}`}) : undefined};
  const transport = new MqttHrmTransport(output as never, 1000, provider as never);
  await transport.publishIdleRollingState(c.productionLine.rollingStand.assetId, c.topicBase, new HrmProductionLine(c, []).getState().stations.rolling.state!, new Date().toISOString());
  const a = equipment.snapshot(false);
  await transport.publishMobileCassette(a, new Date().toISOString());
  equipment.move("store", a.revision, a.runId, false);
  const b = equipment.snapshot(false);
  await transport.publishMobileCassette(b, new Date().toISOString());
  assert.deepEqual(calls, ["flush", "retain"]);
  assert.ok(inventories[0]!.some(path => path.includes("/hrm-stand-1/equipment/")));
  assert.ok(inventories[0]!.every(path => !path.startsWith(a.cassette.assetPath + "/")));
  const location = published.at(-4);
  assert.equal(location.asset, "hrm-roll-store");
  assert.equal(location.topic.replace(/\/+$/, ""), c.topicBase.replace(/\/+$/, ""));
  assert.equal(location.attributes[0].validityMode, "static");
  assert.equal(location.assetStableEntityId, undefined, "Location must not borrow the cassette identity");
  for (const message of published.slice(-3)) {
    assert.equal(message.assetStableEntityId, `identity-${message.asset}`);
    assert.equal(message.assetIdentityProof, `proof-${message.topic}/${message.asset}`);
    assert.ok(message.topic.startsWith(b.parentTopic));
  }
});

test("configured parent and both roll identities use their own external identifiers", async () => {
  const {c, equipment} = fixture(); const requests: any[] = [];
  const provider = new AssetIdentityPublicationProvider({issueAssetIdentityPublicationEvidenceByExternalIdentity: async (identity: unknown, candidateAssetPath: string) => {
    requests.push({identity, candidateAssetPath});
    return {assetStableEntityId: "11111111-1111-4111-8111-111111111111", assetIdentityProof: "proof", candidateAssetPath, expiresAt: new Date(Date.now() + 60000).toISOString()};
  }} as never, c.productionLine);
  for (const row of [equipment.snapshot(false).cassette, ...equipment.snapshot(false).rolls]) {
    await provider.forAsset(row.assetId, row.assetPath.slice(0, -(row.assetId.length + 1)));
  }
  assert.equal(new Set(requests.map(r => r.identity.externalId)).size, 3);
  assert.equal(new Set(requests.map(r => r.candidateAssetPath)).size, 3);
});

test("move endpoint validates destinations/run/revision and rejects arbitrary path injection", async () => {
  const line = new HrmProductionLine(config(), []); const current = line.getState().mobileCassette!;
  const handler = serviceApis.moveRollCassette.handler as Function;
  for (const body of [{location:"other",expectedRevision:1,expectedRunId:current.runId},
    {location:"store",expectedRevision:1,expectedRunId:current.runId,topic:"unrelated/private"},
    {location:"store",expectedRevision:-1,expectedRunId:current.runId}]) {
    let status = 200; const res = {status: (v: number) => {status=v;return res;},json: () => undefined};
    await handler({req:{body},res},{line,processName:"demo"}); assert.equal(status,400);
  }
  let output: any; const res = {status: () => res,json: (value: unknown) => {output=value;}};
  await handler({req:{body:{location:"store",expectedRevision:1,expectedRunId:current.runId}},res},{line,processName:"demo"});
  assert.equal(output.location,"store"); assert.equal(output.revision,2);
});
