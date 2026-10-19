import {DurableMaterialRuntime} from './durable-material-runtime.js';
import {ReviewedLifecycleRuntime} from './reviewed-lifecycle-runtime.js';
import { logger } from "@uns-kit/core";
import type UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";
import type { HrmConfig } from "./hrm-types.js";
import { HrmProductionLine } from "./hrm-production-line.js";
import { MqttHrmTransport } from "./hrm-publisher.js";
import type { AssetIdentityPublicationProvider } from "./asset-identity-publication.js";

export async function initHrm(
  config: HrmConfig,
  mqttOutput: UnsMqttProxy,
  processName: string,
  identityProvider?: AssetIdentityPublicationProvider,
): Promise<HrmProductionLine> {
  const tickIntervalMs = config.tickIntervalMs ?? 2000;
  const resolution = config.simulationResolution ?? 100;
  const skipFactor = Math.max(1, Math.round(100 / resolution));
  const telemetryIntervalMs = tickIntervalMs * skipFactor;

  const transport = new MqttHrmTransport(mqttOutput, telemetryIntervalMs, identityProvider);

  const lifecycle=config.reviewedLifecycle?await ReviewedLifecycleRuntime.open(config.reviewedLifecycle):undefined;
  const runtime = await DurableMaterialRuntime.open(config, [transport], lifecycle);
  const line = runtime.line;
  void runtime.flushPublications();

  let step = 0;
  let reportedBlocked = false;
  setInterval(() => {
    try { line.tick(step++); }
    catch { if (!reportedBlocked) logger.error('HRM material runtime blocked; preserve its journal, restart and verify command results.'); reportedBlocked = true; }
  }, tickIntervalMs);

  logger.info(
    `HRM simulator started - API: system/service/runtime/${processName} - data: ${config.topicBase} - tick: ${tickIntervalMs}ms`
  );

  return line;
}
