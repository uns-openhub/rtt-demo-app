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

/** Stable selectors for the movable assembly and its independently identified rolls. */
export async function registerMobileEquipmentDataOffers(input: Parameters<typeof registerFurnaceAssetDataOffer>[0]): Promise<number> {
  const cassette = input.config.productionLine.rollingStand.mobileCassette;
  if (!cassette) return 0;
  const parent = cassette.initialLocation === "store" ? cassette.storeAssetId
    : cassette.initialLocation === "workshop" ? cassette.workshopAssetId
    : input.config.productionLine.rollingStand.assetId;
  const base = `${input.config.topicBase.replace(/\/+$/, "")}/${parent}`;
  let count = 0;
  for (const asset of [cassette, cassette.upperRoll, cassette.lowerRoll]) {
    const assetBase = asset === cassette ? base : `${base}/${cassette.assetId}`;
    const evidence = await input.identities.forAsset(asset.assetId, assetBase);
    if (!evidence || !("assetStableEntityId" in evidence)) continue;
    input.register({
      offerId: `hrm-mobile-temperature-${evidence.assetStableEntityId}`,
      displayName: `${asset.description} temperature`,
      description: "Current equipment temperature and archived observations across verified Asset moves.",
      tags: ["hrm", "temperature", "identity", "mobile-equipment"], categories: ["Asset data"],
      operations: [buildDataCatalogOfferOperation({topic:"system",asset:"hrm",objectType:"service",objectId:input.processName,attribute:"status"}, {method:"GET",summary:"Production line and mobile equipment status"}, input.apiBasePath)],
      metadata: {assetIdentity:{version:1,stableEntityId:evidence.assetStableEntityId,attributePath:"equipment/main/temperature"}},
    });
    count++;
  }
  return count;
}
