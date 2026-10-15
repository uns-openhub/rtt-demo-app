import { buildDataCatalogOfferOperation, type DataCatalogOfferRegistration } from "@uns-kit/api";
import type { AssetIdentityPublicationProvider } from "./asset-identity-publication.js";
import type { HrmConfig } from "./hrm-types.js";

/** Only an explicitly configured, controller-resolved Asset gets an identity offer. */
export async function registerFurnaceAssetDataOffer(input: {
  config: HrmConfig;
  identities: Pick<AssetIdentityPublicationProvider, "forAsset">;
  register: (offer: DataCatalogOfferRegistration) => void;
  processName: string;
  apiBasePath?: string;
}): Promise<boolean> {
  const furnace = input.config.productionLine.furnace;
  if (!furnace.identity) return false;
  const evidence = await input.identities.forAsset(furnace.assetId, input.config.topicBase);
  if (!evidence || !("assetStableEntityId" in evidence)) return false;
  const statusOperation = buildDataCatalogOfferOperation({
    topic: "system", asset: "hrm", objectType: "service", objectId: input.processName, attribute: "status",
  }, { method: "GET", summary: "Production line status" }, input.apiBasePath);
  input.register({
    offerId: `hrm-furnace-temperature-${evidence.assetStableEntityId}`,
    displayName: "Furnace zone 1 temperature",
    description: "Current furnace temperature and archived observations across verified Asset moves.",
    tags: ["hrm", "temperature", "identity"],
    categories: ["Asset data"],
    operations: [statusOperation],
    metadata: {
      assetIdentity: {
        version: 1,
        stableEntityId: evidence.assetStableEntityId,
        attributePath: "equipment/zone-1/temperature",
      },
    },
  });
  return true;
}
