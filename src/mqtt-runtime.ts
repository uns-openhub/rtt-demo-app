import { UnsProxyProcess } from "@uns-kit/core";
import { mqttChannelParameters, resolveMqttChannel, type MqttChannelConfig } from "@uns-kit/core/uns-config/mqtt-channel.js";

interface DemoMqttConfig {
  infra: MqttChannelConfig;
  output?: MqttChannelConfig;
  processName: string;
  instanceName: string;
  instanceMode: string;
  handover: boolean;
}
type ProcessFactory = (host: string, options: ConstructorParameters<typeof UnsProxyProcess>[1]) => UnsProxyProcess;

/** Resolve both connections before opening either, then retain the SDK lifecycle. */
export async function createDemoMqttRuntime(
  config: DemoMqttConfig,
  createProcess: ProcessFactory = (host, options) => new UnsProxyProcess(host, options),
) {
  const infra = resolveMqttChannel(config.infra);
  const output = resolveMqttChannel(config.infra, config.output);
  const process = createProcess(infra.host, {
    ...mqttChannelParameters(infra), processName: config.processName,
  });
  const mqttOutput = await process.createUnsMqttProxy(
    output.host, config.instanceName, config.instanceMode, config.handover,
    { ...mqttChannelParameters(output), publishThrottlingDelay: 0 },
  );
  return { process, mqttOutput };
}
