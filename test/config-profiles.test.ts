import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeConfigSchema } from "@uns-kit/core/uns-config/schema-tools.js";
import { unsCoreSchema } from "@uns-kit/core/uns-config/uns-core-schema.js";
import { projectExtrasSchema } from "../src/config/project.config.extension.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = composeConfigSchema(unsCoreSchema, projectExtrasSchema).strict();

const profiles = [
  { file: "config-development-host.json", env: "dev", mqttHost: "localhost" },
  { file: "config-development-podman.json", env: "dev", mqttHost: "mosquitto" },
  { file: "config-production.json", env: "prod", mqttHost: "mosquitto" },
] as const;

const expectedProductionLineDescriptions = {
  furnace: "Pusher reheating furnace",
  descaling: "Hydraulic descaling",
  rollingStand: "Reversing rolling stand",
  warehouse: "Warehouse and quality laboratory",
} as const;

test("configuration profiles are schema-valid, topology-specific, and credential-free", () => {
  for (const profile of profiles) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, profile.file), "utf8"));
    const result = schema.safeParse(config);
    assert.equal(result.success, true, result.success ? "" : `${profile.file}: ${result.error.message}`);
    assert.equal(config.uns.env, profile.env);
    assert.equal(config.infra.host, profile.mqttHost);
    assert.equal("email" in config.uns, false);
    assert.equal("password" in config.uns, false);
    assert.equal("input" in config, false);
    assert.equal("output" in config, false);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(config.hrm.productionLine).map(([station, definition]) => [station, definition.description]),
      ),
      expectedProductionLineDescriptions,
    );
  }
});
