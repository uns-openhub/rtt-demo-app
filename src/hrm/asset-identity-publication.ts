import type {
  AssetIdentityPublicationMetadata,
  ProviderAssetIdentity,
  UnsClient,
} from "@uns-kit/core";
import type { AssetIdentityConfig, ProductionLineConfig } from "./hrm-types.js";

const DEFAULT_REFRESH_SKEW_MS = 30_000;

export type AssetIdentityMqttMetadata = Pick<
  AssetIdentityPublicationMetadata,
  "assetStableEntityId" | "assetIdentityProof"
> & {
  assetDisplayName?: string;
};

type AssetIdentityProofClient = Pick<
  UnsClient,
  "issueAssetIdentityPublicationProofByExternalIdentity"
>;

type CachedProof = {
  metadata: AssetIdentityMqttMetadata;
  candidateAssetPath: string;
  expiresAtMs: number;
};

export class AssetIdentityPublicationProvider {
  private readonly identities = new Map<string, {
    identity: AssetIdentityConfig;
    displayName: string;
  }>();
  private readonly cache = new Map<string, CachedProof>();
  private readonly inFlight = new Map<string, Promise<CachedProof>>();

  constructor(
    private readonly client: AssetIdentityProofClient,
    productionLine: ProductionLineConfig,
    private readonly refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    private readonly now: () => number = Date.now,
  ) {
    for (const asset of Object.values(productionLine)) {
      if (asset?.identity) {
        this.identities.set(asset.assetId, {
          identity: asset.identity,
          displayName: asset.description,
        });
      }
    }
  }

  async forAsset(
    assetId: string,
    topicBase: string,
  ): Promise<AssetIdentityMqttMetadata | undefined> {
    const configured = this.identities.get(assetId);
    if (!configured) return undefined;

    const candidateAssetPath = this.assetPath(topicBase, assetId);
    const key = JSON.stringify([assetId, candidateAssetPath, configured.identity]);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > this.now() + this.refreshSkewMs) {
      return cached.metadata;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.requestProof(configured.identity, candidateAssetPath, configured.displayName);
      this.inFlight.set(key, pending);
    }
    try {
      const refreshed = await pending;
      this.cache.set(key, refreshed);
      return refreshed.metadata;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private async requestProof(
    identity: ProviderAssetIdentity,
    candidateAssetPath: string,
    assetDisplayName: string | undefined,
  ): Promise<CachedProof> {
    const result = await this.client.issueAssetIdentityPublicationProofByExternalIdentity(
      identity,
      candidateAssetPath,
    );
    if (this.normalizePath(result.candidateAssetPath) !== candidateAssetPath) {
      throw new Error("Controller returned an Asset identity proof for a different candidate path.");
    }
    const expiresAtMs = Date.parse(result.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error("Controller returned an expired Asset identity proof.");
    }
    return {
      candidateAssetPath,
      expiresAtMs,
      metadata: {
        assetStableEntityId: result.assetStableEntityId,
        assetIdentityProof: result.assetIdentityProof,
        ...(assetDisplayName?.trim() ? { assetDisplayName: assetDisplayName.trim() } : {}),
      },
    };
  }

  private assetPath(topicBase: string, assetId: string): string {
    return [topicBase, assetId]
      .map((part) => this.normalizePath(part))
      .filter(Boolean)
      .join("/");
  }

  private normalizePath(value: string): string {
    return value.trim().normalize("NFC").replace(/^\/+|\/+$/g, "");
  }
}
