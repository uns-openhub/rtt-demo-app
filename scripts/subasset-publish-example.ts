#!/usr/bin/env tsx
/**
 * One-shot sub-asset publish example.
 *
 * Usage:
 *   pnpm run subasset:example -- --dry-run
 *   pnpm run subasset:example
 */
import { ConfigFile, UnsProxyProcess } from "@uns-kit/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ensureTrailingSlash = (value: string) => value.endsWith("/") ? value : `${value}/`;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const config = await ConfigFile.loadConfig();
const hrm = (config as any).hrm;
const uns = (config as any).uns;
const output = (config as any).output;
const infra = (config as any).infra;

const topicBase = ensureTrailingSlash(hrm?.topicBase ?? "forge-group/novasteel/hot-rolling/");
const parentAsset = hrm?.productionLine?.descaling?.assetId ?? "hrm-descaling";
const parentTopic = `${topicBase}${parentAsset}/`;
const subAsset = "pump-skid-1";
const time = new Date().toISOString();
const value = 42;

const publishRequest = {
  topic: parentTopic,
  asset: subAsset,
  assetDescription: "Example pump skid owned by a separate microservice",
  objectType: "equipment",
  objectId: "main",
  attributes: {
    attribute: "temperature",
    description: "Example sub-asset temperature",
    valueType: "number",
    data: {
      time,
      value,
      uom: "degC",
    },
  },
};

const fullTopic = `${parentTopic}${subAsset}/equipment/main/temperature`;

console.log("Sub-asset publish example");
console.log(`  Parent topic: ${parentTopic}`);
console.log(`  Leaf asset:   ${subAsset}`);
console.log(`  Full topic:   ${fullTopic}`);
console.log("  QuestDB row:  topic = " + parentTopic.replace(/\/+$/, "") + `, asset = ${subAsset}`);

if (dryRun) {
  console.log("\nDry run only. Publish request:");
  console.log(JSON.stringify(publishRequest, null, 2));
  process.exit(0);
}

const processName = `${uns?.processName ?? "rtt-demo-app"}-subasset-example`;
const unsProxyProcess = new UnsProxyProcess(infra?.host ?? "localhost", {
  processName,
});
const mqttOutput = await unsProxyProcess.createUnsMqttProxy(
  output?.host ?? "localhost",
  "subassetExampleOutput",
  "force",
  false,
  { publishThrottlingDelay: 0 },
);

mqttOutput.setPublisherActive();
await sleep(1_000);
await mqttOutput.publishMqttMessage(publishRequest as any);
await sleep(2_000);

console.log("\nPublished one sub-asset sample.");
process.exit(0);
