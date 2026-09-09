import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetIdentityPublicationProvider,
  resolveAssetIdentityMqttInstanceName,
} from "../src/hrm/asset-identity-publication.js";
import { MqttHrmTransport } from "../src/hrm/hrm-publisher.js";
import type { ProductionLineConfig } from "../src/hrm/hrm-types.js";

const productionLine = {
  furnace: {
    assetId: "hrm-furnace",
    description: "Furnace",
    zones: 4,
    maxTempC: 1_280,
    gasConsumptionNm3PerHour: 800,
    identity: {
      providerId: "demo.mes",
      externalSystem: "novasteel.mes",
      externalType: "equipment.code",
      externalId: "RESS-14",
    },
  },
  descaling: {
    assetId: "hrm-descaling",
    description: "Descaling",
    nominalPressureBar: 200,
    nominalFlowM3PerHour: 12,
    durationMin: 5,
  },
  rollingStand: {
    assetId: "hrm-stand-1",
    description: "Rolling stand",
    nominalSpeedMps: 2.5,
    maxMotorPowerKw: 3_500,
    maxForceKn: 18_000,
    durationMinPerPass: 3,
  },
  warehouse: {
    assetId: "hrm-warehouse",
    description: "Warehouse",
  },
} satisfies ProductionLineConfig;

test("binds identity-bearing MQTT evidence to the controller-managed RTT instance", () => {
  assert.equal(resolveAssetIdentityMqttInstanceName("templateUnsRttOutput", {
    RTT_INSTANCE_ID: " 9e65fa0d ",
  }), "9e65fa0d");
  assert.equal(resolveAssetIdentityMqttInstanceName("templateUnsRttOutput", {}), "templateUnsRttOutput");
});

test("resolves and caches publish-ready metadata for a configured Asset identity", async () => {
  let calls = 0;
  const client = {
    async issueAssetIdentityPublicationEvidenceByExternalIdentity(identity: unknown, candidateAssetPath: string) {
      calls += 1;
      assert.deepEqual(identity, productionLine.furnace.identity);
      assert.equal(candidateAssetPath, "forge-group/novasteel/hot-rolling/hrm-furnace");
      return {
        assetStableEntityId: "11111111-1111-4111-8111-111111111111",
        assetIdentityProof: "proof-1",
        candidateAssetPath,
        expiresAt: "2026-09-08T22:05:00.000Z",
      };
    },
  };
  const provider = new AssetIdentityPublicationProvider(
    client,
    productionLine,
    30_000,
    () => Date.parse("2026-09-08T22:00:00.000Z"),
  );

  const first = await provider.forAsset(
    "hrm-furnace",
    "/forge-group/novasteel/hot-rolling/",
  );
  const second = await provider.forAsset(
    "hrm-furnace",
    "forge-group/novasteel/hot-rolling",
  );

  assert.deepEqual(first, {
    assetStableEntityId: "11111111-1111-4111-8111-111111111111",
    assetIdentityProof: "proof-1",
    assetDisplayName: "Furnace",
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("keeps unconfigured Assets backward compatible without a controller request", async () => {
  const client = {
    async issueAssetIdentityPublicationEvidenceByExternalIdentity() {
      throw new Error("must not be called");
    },
  };
  const provider = new AssetIdentityPublicationProvider(client, productionLine);

  assert.equal(await provider.forAsset(
    "hrm-descaling",
    "forge-group/novasteel/hot-rolling",
  ), undefined);
});

test("fails closed when the controller returns a proof for another path", async () => {
  const client = {
    async issueAssetIdentityPublicationEvidenceByExternalIdentity() {
      return {
        assetStableEntityId: "11111111-1111-4111-8111-111111111111",
        assetIdentityProof: "proof-1",
        candidateAssetPath: "forge-group/novasteel/other/hrm-furnace",
        expiresAt: "2026-09-08T22:05:00.000Z",
      };
    },
  };
  const provider = new AssetIdentityPublicationProvider(
    client,
    productionLine,
    30_000,
    () => Date.parse("2026-09-08T22:00:00.000Z"),
  );

  await assert.rejects(
    provider.forAsset("hrm-furnace", "forge-group/novasteel/hot-rolling"),
    /different candidate path/,
  );
});

test("publishes reviewed provider candidate evidence when the external ID is not mapped yet", async () => {
  const client = {
    async issueAssetIdentityPublicationEvidenceByExternalIdentity(identity: unknown, candidateAssetPath: string) {
      assert.deepEqual(identity, productionLine.furnace.identity);
      return {
        assetProviderIdentity: productionLine.furnace.identity,
        assetProviderIdentityProof: "provider-proof-1",
        candidateAssetPath,
        expiresAt: "2026-09-08T22:05:00.000Z",
      };
    },
  };
  const provider = new AssetIdentityPublicationProvider(
    client,
    productionLine,
    30_000,
    () => Date.parse("2026-09-08T22:00:00.000Z"),
  );

  assert.deepEqual(await provider.forAsset(
    "hrm-furnace",
    "forge-group/novasteel/hot-rolling",
  ), {
    assetProviderIdentity: productionLine.furnace.identity,
    assetProviderIdentityProof: "provider-proof-1",
  });
});

test("fails closed when provider candidate evidence names another external identifier", async () => {
  const client = {
    async issueAssetIdentityPublicationEvidenceByExternalIdentity(_identity: unknown, candidateAssetPath: string) {
      return {
        assetProviderIdentity: { ...productionLine.furnace.identity, externalId: "RESS-15" },
        assetProviderIdentityProof: "provider-proof-1",
        candidateAssetPath,
        expiresAt: "2026-09-08T22:05:00.000Z",
      };
    },
  };
  const provider = new AssetIdentityPublicationProvider(
    client,
    productionLine,
    30_000,
    () => Date.parse("2026-09-08T22:00:00.000Z"),
  );

  await assert.rejects(
    provider.forAsset("hrm-furnace", "forge-group/novasteel/hot-rolling"),
    /different provider identifier/,
  );
});

test("adds resolved identity metadata to the Asset publication", async () => {
  const published: Array<Record<string, unknown>> = [];
  const mqttOutput = {
    async publishMqttMessage(message: Record<string, unknown>) {
      published.push(message);
    },
  };
  const identityProvider = {
    async forAsset(assetId: string, topicBase: string) {
      assert.equal(assetId, "hrm-furnace");
      assert.equal(topicBase, "forge-group/novasteel/hot-rolling/");
      return {
        assetStableEntityId: "11111111-1111-4111-8111-111111111111",
        assetIdentityProof: "proof-1",
        assetDisplayName: "Furnace",
      };
    },
  };
  const transport = new MqttHrmTransport(
    mqttOutput as never,
    2_000,
    identityProvider as never,
  );

  await transport.publishAssetMaterialOccupancy(
    "hrm-furnace",
    "Furnace",
    "forge-group/novasteel/hot-rolling/",
    undefined,
    "2026-09-08T22:00:00.000Z",
  );

  assert.equal(published.length, 1);
  assert.equal(published[0]?.assetStableEntityId, "11111111-1111-4111-8111-111111111111");
  assert.equal(published[0]?.assetIdentityProof, "proof-1");
  assert.equal(published[0]?.assetDisplayName, "Furnace");
});

test("adds provider candidate evidence to the Asset publication without a stable ID", async () => {
  const published: Array<Record<string, unknown>> = [];
  const mqttOutput = {
    async publishMqttMessage(message: Record<string, unknown>) {
      published.push(message);
    },
  };
  const identityProvider = {
    async forAsset() {
      return {
        assetProviderIdentity: productionLine.furnace.identity,
        assetProviderIdentityProof: "provider-proof-1",
      };
    },
  };
  const transport = new MqttHrmTransport(
    mqttOutput as never,
    2_000,
    identityProvider as never,
  );

  await transport.publishAssetMaterialOccupancy(
    "hrm-furnace",
    "Furnace",
    "forge-group/novasteel/hot-rolling/",
    undefined,
    "2026-09-08T22:00:00.000Z",
  );

  assert.deepEqual(published[0]?.assetProviderIdentity, productionLine.furnace.identity);
  assert.equal(published[0]?.assetProviderIdentityProof, "provider-proof-1");
  assert.equal(published[0]?.assetStableEntityId, undefined);
});
