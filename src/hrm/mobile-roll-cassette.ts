import type { AssetConfig, AssetIdentityConfig, RollingPhysicsState } from "./hrm-types.js";
import { randomUUID } from "node:crypto";

export type CassetteLocation = "stand" | "store" | "workshop";
export interface WorkRollConfig extends AssetConfig {
  identity: AssetIdentityConfig;
  nominalDiameterMm: number;
}
export interface MobileCassetteConfig extends AssetConfig {
  identity: AssetIdentityConfig;
  upperRoll: WorkRollConfig;
  lowerRoll: WorkRollConfig;
  storeAssetId: string;
  workshopAssetId: string;
  initialLocation?: CassetteLocation | undefined;
}
export interface MobileAssetReading {
  assetId: string;
  description: string;
  externalId: string;
  assetPath: string;
  temperatureC: number;
  vibrationMmS: number;
  operatingSeconds: number;
  speedRpm: number;
  diameterMm?: number;
  wearMm?: number;
}
export interface MobileCassetteSnapshot {
  runId: string;
  revision: number;
  location: CassetteLocation;
  locationLabel: string;
  parentTopic: string;
  movingAllowed: boolean;
  blockedReason: string | null;
  publicationState: "waiting" | "sending" | "sent" | "failed";
  cassette: MobileAssetReading;
  rolls: MobileAssetReading[];
}

/** Illustrative equipment physics; lifecycle and identity approval stay controller-owned. */
export class MobileRollCassette {
  private runId = randomUUID();
  private location: CassetteLocation;
  private revision = 1;
  private temperatureC = 22;
  private operatingSeconds = 0;
  private vibrationMmS = 0;
  private speedMps = 0;
  publicationState: MobileCassetteSnapshot["publicationState"] = "waiting";

  constructor(
    readonly config: MobileCassetteConfig,
    private readonly topicBase: string,
    private readonly standAssetId: string,
  ) {
    this.location = config.initialLocation ?? "stand";
  }

  checkpoint() {
    return {runId: this.runId, location: this.location, revision: this.revision,
      temperatureC: this.temperatureC, operatingSeconds: this.operatingSeconds,
      vibrationMmS: this.vibrationMmS, speedMps: this.speedMps};
  }
  restoreCheckpoint(state: ReturnType<MobileRollCassette['checkpoint']>): void {
    this.runId = state.runId; this.location = state.location; this.revision = state.revision;
    this.temperatureC = state.temperatureC; this.operatingSeconds = state.operatingSeconds;
    this.vibrationMmS = state.vibrationMmS; this.speedMps = state.speedMps;
    this.publicationState = 'waiting';
  }

  get installed(): boolean { return this.location === "stand"; }

  advance(elapsedMs: number, rolling: boolean, state?: RollingPhysicsState): void {
    const working = this.installed && rolling && state?.subState === "ROLLING";
    const seconds = elapsedMs / 1000;
    if (working) this.operatingSeconds += seconds;
    const target = working ? Math.max(35, state.measuredBearingTempC) : 22;
    this.temperatureC += (target - this.temperatureC) * (1 - Math.exp(-seconds / 180));
    this.vibrationMmS = working ? state.measuredVibrationMmS : 0;
    this.speedMps = working ? Math.abs(state.measuredSpeedMps) : 0;
  }

  move(location: CassetteLocation, expectedRevision: number, expectedRunId: string, rolling: boolean): void {
    if (expectedRunId !== this.runId) throw new Error("The simulator restarted. Refresh its state before moving the cassette.");
    if (expectedRevision !== this.revision) throw new Error("The cassette changed. Refresh its state before moving it.");
    if (rolling) throw new Error("Wait until the rolling stand is empty before moving the cassette.");
    if (this.publicationState === "sending") throw new Error("Wait for the current telemetry publication before moving the cassette.");
    if (location === this.location) return;
    this.location = location;
    this.revision++;
    this.speedMps = 0;
    this.vibrationMmS = 0;
    this.publicationState = "waiting";
  }

  snapshot(rolling: boolean): MobileCassetteSnapshot {
    const parent = this.location === "stand" ? this.standAssetId
      : this.location === "store" ? this.config.storeAssetId : this.config.workshopAssetId;
    const parentTopic = `${this.topicBase.replace(/\/+$/, "")}/${parent}`;
    const assetPath = `${parentTopic}/${this.config.assetId}`;
    const blockedReason = rolling ? "The rolling stand is occupied."
      : this.publicationState === "sending" ? "Publishing equipment telemetry." : null;
    const reading = (asset: AssetConfig & {identity: AssetIdentityConfig}, path: string): MobileAssetReading => ({
      assetId: asset.assetId, description: asset.description, externalId: asset.identity.externalId,
      assetPath: path, temperatureC: Number(this.temperatureC.toFixed(2)),
      vibrationMmS: Number(this.vibrationMmS.toFixed(3)),
      operatingSeconds: Number(this.operatingSeconds.toFixed(2)), speedRpm: 0,
    });
    return {
      runId: this.runId, revision: this.revision, location: this.location,
      locationLabel: this.location === "stand" ? "Rolling stand" : this.location === "store" ? "Roll store" : "Roll workshop",
      parentTopic, movingAllowed: !blockedReason, blockedReason,
      publicationState: this.publicationState,
      cassette: reading(this.config, assetPath),
      rolls: [this.config.upperRoll, this.config.lowerRoll].map((roll, index) => {
        // Small illustrative wear during use; location changes never reset it.
        const wearMm = this.operatingSeconds / 60 * 0.002 * (index ? 1.02 : 1);
        const diameterMm = Math.max(roll.nominalDiameterMm * 0.95, roll.nominalDiameterMm - wearMm);
        return {...reading(roll, `${assetPath}/${roll.assetId}`),
          temperatureC: Number((this.temperatureC + (this.speedMps ? index + 1 : 0)).toFixed(2)),
          diameterMm: Number(diameterMm.toFixed(4)),
          wearMm: Number((roll.nominalDiameterMm - diameterMm).toFixed(4)),
          speedRpm: Number((this.speedMps * 60 / (Math.PI * diameterMm / 1000)).toFixed(2)),
        };
      }),
    };
  }
}
