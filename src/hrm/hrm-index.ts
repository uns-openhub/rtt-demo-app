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

  const line = new HrmProductionLine(config, [transport]);

  let step = 0;
  setInterval(() => {
    line.tick(step++);
  }, tickIntervalMs);

  logger.info(
    `HRM simulator started - API: system/service/runtime/${processName} - data: ${config.topicBase} - tick: ${tickIntervalMs}ms`
  );

  return line;
}
