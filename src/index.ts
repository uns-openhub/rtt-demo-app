import {
  ConfigFile,
  ServiceTokenProvider,
  UnsClient,
  UnsProxyProcess,
  logger,
} from "@uns-kit/core";
import UnsMqttProxy from "@uns-kit/core/uns-mqtt/uns-mqtt-proxy.js";
import { registerAttributeDescriptions, registerObjectTypeDescriptions } from "@uns-kit/core/uns/uns-dictionary-registry.js";
import "@uns-kit/api";
import { registerApiCatalog, type UnsProxyProcessWithApi } from "@uns-kit/api";
import {
  GeneratedAttributeDescriptions,
  GeneratedObjectTypeDescriptions,
} from "./uns/uns-dictionary.generated.js";
import type { IApiProxyOptions } from "@uns-kit/core/uns/uns-interfaces.js";
import { serviceApis } from "./api-routes.js";
import { initHrm } from "./hrm/hrm-index.js";
import {
  AssetIdentityPublicationProvider,
  resolveAssetIdentityMqttInstanceName,
} from "./hrm/asset-identity-publication.js";

async function main() {
  const config = await ConfigFile.loadConfig();
  registerObjectTypeDescriptions(GeneratedObjectTypeDescriptions);
  registerAttributeDescriptions(GeneratedAttributeDescriptions);

  const unsProxyProcess = new UnsProxyProcess(config.infra.host!, {
    processName: config.uns.processName!,
  }) as UnsProxyProcessWithApi;

  const mqttOutput = await unsProxyProcess.createUnsMqttProxy(
    config.output?.host ?? config.infra.host!,
    resolveAssetIdentityMqttInstanceName("templateUnsRttOutput"),
    config.uns.instanceMode!,
    config.uns.handover!,
    { publishThrottlingDelay: 0 }
  );

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
  } else {
    logger.warn("No HRM config found. Nothing to simulate.");
  }
}

main().catch((error) => {
  const reason = error instanceof Error ? error : new Error(String(error));
  logger.error(`Fatal error in index.ts: ${reason.message}`);
  process.exit(1);
});
