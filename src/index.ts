import { registerManagementApiCatalog as registerApiCatalog } from './management-api-catalog.js';
import {
  ConfigFile,
  ServiceTokenProvider,
  UnsClient,
  logger,
} from "@uns-kit/core";
import UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";
import type { MqttChannelConfig } from "@uns-kit/core/uns-config/mqtt-channel.js";
import { createDemoMqttRuntime } from "./mqtt-runtime.js";
import { registerAttributeDescriptions, registerObjectTypeDescriptions } from "@uns-kit/core/uns/uns-dictionary-registry.js";
import "@uns-kit/api";
import { type UnsProxyProcessWithApi } from "@uns-kit/api";
import {
  GeneratedAttributeDescriptions,
  GeneratedObjectTypeDescriptions,
} from "./uns/uns-dictionary.generated.js";
import type { IApiProxyOptions } from "@uns-kit/core/uns/uns-interfaces.js";
import { serviceApis } from "./api-routes.js";
import { initHrm } from "./hrm/hrm-index.js";
import { registerFurnaceAssetDataOffer, registerMobileEquipmentDataOffers } from "./hrm/asset-data-catalog.js";
import {
  AssetIdentityPublicationProvider,
  resolveAssetIdentityMqttInstanceName,
} from "./hrm/asset-identity-publication.js";

async function main() {
  const config = await ConfigFile.loadConfig();
  registerObjectTypeDescriptions(GeneratedObjectTypeDescriptions);
  registerAttributeDescriptions(GeneratedAttributeDescriptions);

  // Generated config types allow explicit undefined; the SDK resolver omits those fields.
  const { process: mqttProcess, mqttOutput } = await createDemoMqttRuntime({
    infra: config.infra as MqttChannelConfig,
    ...(config.output ? { output: config.output as MqttChannelConfig } : {}),
    processName: config.uns.processName!,
    instanceName: resolveAssetIdentityMqttInstanceName("templateUnsRttOutput"),
    instanceMode: config.uns.instanceMode!,
    handover: config.uns.handover!,
  });
  const unsProxyProcess = mqttProcess as UnsProxyProcessWithApi;

  if (!config.uns?.jwksWellKnownUrl) {
    throw new Error("uns.jwksWellKnownUrl is required for API authentication");
  }
  const apiOptions: IApiProxyOptions = {
    jwks: {
      wellKnownJwksUrl: config.uns.jwksWellKnownUrl,
      ...(config.uns.kidWellKnownUrl !== undefined ? { activeKidUrl: config.uns.kidWellKnownUrl } : {}),
    },
  };
  const apiInput = await unsProxyProcess.createApiProxy("rttDemoApi", apiOptions);

  if (config.hrm) {
    const identityProvider = new AssetIdentityPublicationProvider(
      new UnsClient(config.uns.rest, {
        graphqlUrl: config.uns.graphql,
        tokenProvider: new ServiceTokenProvider({
          ...(typeof config.uns.token === "string" ? { configToken: config.uns.token } : {}),
        }),
      }),
      config.hrm.productionLine,
    );
    const line = await initHrm(config.hrm, mqttOutput, config.uns.processName!, identityProvider);
    await registerApiCatalog(apiInput, {
      serviceApis,
      context: {
        line,
        processName: config.uns.processName!,
      },
      options: {
        onError: ({ method, reqPath, error }) => {
          logger.error(`Handler error [${method} ${reqPath ?? ""}]:`, error);
        },
      },
    });
    try {
      await registerFurnaceAssetDataOffer({
        config: config.hrm,
        identities: identityProvider,
        register: offer => apiInput.registerDataOffer(offer),
        processName: config.uns.processName!,
        ...(process.env["UNS_API_BASE_PATH"] ? { apiBasePath: process.env["UNS_API_BASE_PATH"] } : {}),
      });      await registerMobileEquipmentDataOffers({
        config: config.hrm,
        identities: identityProvider,
        register: offer => apiInput.registerDataOffer(offer),
        processName: config.uns.processName!,
        ...(process.env["UNS_API_BASE_PATH"] ? { apiBasePath: process.env["UNS_API_BASE_PATH"] } : {}),
      });
    } catch {
      // Catalog registration must not stop the simulator or expose proof material.
      logger.warn("Asset data offers are unavailable; verify the configured identity association.");
    }
  } else {
    logger.warn("No HRM config found. Nothing to simulate.");
  }
}

main().catch((error) => {
  const reason = error instanceof Error ? error : new Error(String(error));
  logger.error(`Fatal error in index.ts: ${reason.message}`);
  process.exit(1);
});
