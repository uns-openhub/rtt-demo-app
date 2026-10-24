import {setImmediate as yieldToIo} from "node:timers/promises";
import {IdentitySourceReviewRequired, type PublicationAsset} from "./publication-readiness.js";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { HrmProductionLine } from "./hrm-production-line.js";
import type {
  HrmConfig,
  BatchSubmitRequest,
  MaterialSplitRequest,
} from "./hrm-types.js";
import type { IHrmTransport } from "./hrm-publisher.js";
import type { ReviewedLifecycleRuntime } from "./reviewed-lifecycle-runtime.js";

const METHODS = [
  "publishMaterialTransition",
  "publishMaterialStatus",
  "publishAssetMaterialOccupancy",
  "publishWarehouseState",
  "publishPassComplete",
  "publishAlarm",
] as const;
const TELEMETRY = [
  "publishFurnaceState",
  "publishFurnaceMaterialState",
  "publishIdleFurnaceState",
  "publishDescalingState",
  "publishIdleDescalingState",
  "publishRollingState",
  "publishIdleRollingState",
  "publishMobileCassette",
] as const;
const MAX_BYTES = 16 * 1024 * 1024,
  MAX_BATCHES = 2000,
  MAX_RECEIPTS = 4096,
  MAX_OUTBOX = 4096;
type Checkpoint = ReturnType<HrmProductionLine["checkpoint"]>;
type Intent = {
  id: string;
  target: number;
  method: (typeof METHODS)[number];
  args: unknown[];
};
type Receipt = {
  requestId: string;
  kind: "load" | "split";
  requestDigest: string;
  result: unknown;
};
type Journal = {
  version: 1;
  configDigest: string;
  transportCount: number;
  step: number;
  checkpoint: Checkpoint;
  receipts: Receipt[];
  outbox: Intent[];
};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
class PublicationCapacityError extends Error {}
export class MaterialCommandError extends Error {
  constructor(
    public readonly statusCode: 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Single instance filesystem/host. Atomic state+receipt+outbox; MQTT delivery is at least once. */
export class DurableMaterialRuntime {
  readonly line: HrmProductionLine;
  private readonly engine: HrmProductionLine;
  private journal!: Journal;
  private blocked = false;
  private closed = false;
  private collecting = false;
  private transient: Array<() => Promise<void>> = [];
  private flushing: Promise<void> | undefined;
  private retryAt = 0;
  private failures = 0;
  private publicationIssue: "checking" | "identity-review-required" | "publication-unavailable" | "queue-capacity" | "draining" | null = null;

  private constructor(
    private readonly file: string,
    private readonly lease: net.Server,
    private readonly config: HrmConfig,
    private readonly transports: IHrmTransport[],
    lifecycle?: ReviewedLifecycleRuntime,
  ) {
    if (transports.some(t => t.checkPublicationReadiness)) this.publicationIssue = "checking";
    const wrapped = transports.map(
      (transport, target) =>
        new Proxy(transport, {
          get: (object, key) => {
            if (METHODS.includes(key as (typeof METHODS)[number]))
              return (...args: unknown[]) => {
                if (!this.collecting)
                  return Promise.reject(
                    new Error("Material publication outside a durable step."),
                  );
                if (this.journal.outbox.length >= MAX_OUTBOX) throw new PublicationCapacityError();
                this.journal.outbox.push({
                  id: randomUUID(),
                  target,
                  method: key as (typeof METHODS)[number],
                  args: json(args),
                });
                return Promise.resolve();
              };
            if (
              TELEMETRY.includes(key as (typeof TELEMETRY)[number]) &&
              typeof Reflect.get(object, key) === "function"
            )
              return (...args: unknown[]) => {
                const copy = structuredClone(args);
                this.transient.push(() =>
                  Reflect.apply(
                    Reflect.get(object, key) as (
                      ...a: unknown[]
                    ) => Promise<void>,
                    object,
                    copy,
                  ),
                );
                return Promise.resolve();
              };
            const value = Reflect.get(object, key);
            return typeof value === "function" ? value.bind(object) : value;
          },
        }),
    );
    this.engine = new HrmProductionLine(
      structuredClone(config),
      wrapped,
      lifecycle,
    );
    this.line = new Proxy(this.engine, {
      get: (engine, key) => {
        if (key === "submitBatch")
          return (request: BatchSubmitRequest) =>
            this.command(
              "load",
              request.requestId ?? `legacy-submit:${request.materialId}`,
              request,
              () => engine.submitBatch(request),
            );
        if (key === "splitMaterial")
          return (request: MaterialSplitRequest) =>
            this.command("split", request?.requestId, request, () =>
              engine.splitMaterial(request),
            );
        if (key === "tick")
          return () => {
            if (this.isPublicationPaused()) { void this.flushPublications(); return; }
            return this.transaction(() => {
              engine.tick(this.journal.step);
              this.journal.step++;
            });
          };
        if (key === "updateRecipe" || key === "moveRollCassette")
          return (...args: unknown[]) =>
            this.transaction(
              () =>
                Reflect.apply(
                  Reflect.get(engine, key) as (...a: unknown[]) => unknown,
                  engine,
                  args,
                ),
              key === "moveRollCassette",
            );
        if (key === "materialCommandResult")
          return (id: string) => {
            this.requireReadable();
            return structuredClone(
              this.journal.receipts.find((r) => r.requestId === id) ?? null,
            );
          };
        if (key === "getState" || key === "getRuntimeConfig")
          return () => ({
            ...Reflect.apply(
              Reflect.get(engine, key) as () => object,
              engine,
              [],
            ),
            commandDurability: {
              state: this.blocked ? "blocked" : this.isPublicationPaused() ? "paused" : "ready",
              reason: this.blocked ? "journal-unavailable" : this.publicationIssue ?? (this.journal.outbox.length >= MAX_OUTBOX ? "queue-capacity" : null),
              pendingPublications: this.journal.outbox.length,
              maxPendingPublications: MAX_OUTBOX,
              automaticRetry: !this.blocked,
              retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null,
              protocol: 1,
            },
          });
        const value = Reflect.get(engine, key);
        return typeof value === "function" ? value.bind(engine) : value;
      },
    });
  }

  static async open(
    config: HrmConfig,
    transports: IHrmTransport[],
    lifecycle?: ReviewedLifecycleRuntime,
  ): Promise<DurableMaterialRuntime> {
    const requested =
      config.commandStateFile ?? path.resolve("hrm-runtime-state.json");
    if (!path.isAbsolute(requested))
      throw Error("commandStateFile must be an absolute instance-local path.");
    fs.mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
    const file = path.join(
      fs.realpathSync(path.dirname(requested)),
      path.basename(requested),
    );
    const port =
      10000 +
      (parseInt(digest("hrm-material:" + file).slice(0, 8), 16) % 10000);
    const lease = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      lease.once("error", () =>
        reject(
          Error(
            "Local material writer lease unavailable; check the instance or port reservation.",
          ),
        ),
      );
      lease.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    const runtime = new DurableMaterialRuntime(
      file,
      lease,
      config,
      transports,
      lifecycle,
    );
    try {
      const { commandStateFile: _ignored, ...legacyPinnedConfig } = config;
      const { reviewedLifecycle, ...materialConfig } = legacyPinnedConfig;
      // Offering a separately reviewed lifecycle successor must not invalidate
      // material jobs/outbox. Keep its journal identity and maintenance policy
      // pinned; the lifecycle runtime independently validates file + digest.
      const pinnedConfig = {
        ...materialConfig,
        ...(reviewedLifecycle ? { reviewedLifecycle: {
          stateFile: reviewedLifecycle.stateFile,
          maintenanceState: reviewedLifecycle.maintenanceState,
        } } : {}),
      };
      const configDigest = digest(pinnedConfig);
      const legacyConfigDigest = digest(legacyPinnedConfig);
      let stored: unknown;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
          throw Error("Material journal must be a bounded regular file.");
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          if (fs.fstatSync(fd).size > MAX_BYTES)
            throw Error("Material journal exceeds its file bound.");
          stored = JSON.parse(fs.readFileSync(fd, "utf8"));
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stored !== undefined) {
        const { checksum, ...journal } = stored as Journal & {
          checksum: string;
        };
        if (
          checksum !== digest(journal) ||
          journal.version !== 1 ||
          (journal.configDigest !== configDigest && journal.configDigest !== legacyConfigDigest) ||
          journal.transportCount !== transports.length
        )
          throw Error(
            "Material journal is corrupt or incompatible with this configuration. Preserve it and review the instance configuration.",
          );
        runtime.validate(journal);
        runtime.journal = journal;
        runtime.engine.restoreCheckpoint(journal.checkpoint);
        // A legacy pin can be upgraded only after the exact old full config,
        // checksum, checkpoint and transport count have all validated. A changed
        // config cannot authorize this conversion; restart unchanged once first.
        if (journal.configDigest !== configDigest) {
          runtime.journal.configDigest = configDigest;
          runtime.save();
        }
      } else {
        runtime.journal = {
          version: 1,
          configDigest,
          transportCount: transports.length,
          step: 0,
          checkpoint: runtime.engine.checkpoint(),
          receipts: [],
          outbox: [],
        };
        runtime.save();
      }
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  private validate(journal: Journal): void {
    const s = journal.checkpoint;
    if (
      !Number.isSafeInteger(journal.step) ||
      journal.step < 0 ||
      !Array.isArray(journal.receipts) ||
      journal.receipts.length > MAX_RECEIPTS ||
      !Array.isArray(journal.outbox) ||
      journal.outbox.length > MAX_OUTBOX ||
      !s ||
      !Array.isArray(s.batches) ||
      s.batches.length > MAX_BATCHES ||
      !Array.isArray(s.queue) ||
      !Array.isArray(s.pendingSplitOutputs) ||
      !Array.isArray(s.pendingMerges) ||
      !Array.isArray(s.completed) ||
      !Array.isArray(s.recipes) ||
      !Array.isArray(s.activeFurnaceAlarms) ||
      !Array.isArray(s.furnaceSlotBatchIds) ||
      s.furnaceSlotBatchIds.length !== 5 ||
      !Number.isFinite(s.currentSimulationTimeMs) ||
      !Number.isFinite(Date.parse(s.simulationStartTimeIso))
    )
      throw Error("Invalid material journal state.");
    const ids = new Set(
      s.batches.map(([id, batch]) => {
        if (!id || id !== batch.batchId)
          throw Error("Invalid stored batch identity.");
        return id;
      }),
    );
    if (
      ids.size !== s.batches.length ||
      [
        ...s.queue,
        ...s.pendingSplitOutputs,
        ...s.furnaceSlotBatchIds.filter(Boolean),
        s.descalingBatchId,
        s.rollingBatchId,
        s.warehouseBatchId,
      ].some((id) => id && !ids.has(id))
    )
      throw Error("Invalid stored material references.");
    if (
      new Set(journal.receipts.map((r) => r.requestId)).size !==
        journal.receipts.length ||
      journal.receipts.some(
        (r) =>
          !r.requestId ||
          !["load", "split"].includes(r.kind) ||
          !/^[a-f0-9]{64}$/.test(r.requestDigest),
      )
    )
      throw Error("Invalid material receipt journal.");
    if (
      new Set(journal.outbox.map((i) => i.id)).size !== journal.outbox.length ||
      journal.outbox.some(
        (i) =>
          !METHODS.includes(i.method) ||
          !Array.isArray(i.args) ||
          !Number.isInteger(i.target) ||
          i.target < 0 ||
          i.target >= this.transports.length,
      )
    )
      throw Error("Invalid material publication journal.");
  }

  private save(): void {
    this.journal.checkpoint = json(this.engine.checkpoint());
    this.validate(this.journal);
    const text = JSON.stringify({
      ...this.journal,
      checksum: digest(this.journal),
    });
    if (Buffer.byteLength(text) > MAX_BYTES)
      throw new MaterialCommandError(
        503,
        "Material journal capacity reached. Preserve the journal and inspect this demo instance.",
      );
    const pending = this.file + ".pending-" + randomUUID();
    let fd: number | undefined;
    try {
      fd = fs.openSync(pending, "wx", 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(pending, this.file);
      const dir = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(pending);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private command<T>(
    kind: Receipt["kind"],
    requestId: string,
    request: unknown,
    perform: () => T,
  ): T {
    this.requireReadable();
    if (
      typeof requestId !== "string" ||
      (!/^legacy-submit:[A-Za-z0-9._-]{1,100}$/.test(requestId) &&
        !/^[A-Za-z0-9._-]{1,100}$/.test(requestId))
    )
      throw new MaterialCommandError(409, "Provide a valid command requestId.");
    const requestDigest = digest({ kind, request });
    const prior = this.journal.receipts.find((r) => r.requestId === requestId);
    if (prior) {
      if (prior.requestDigest !== requestDigest || prior.kind !== kind)
        throw new MaterialCommandError(
          409,
          "This command ID belongs to different input. Check its recorded result.",
        );
      return structuredClone(prior.result) as T;
    }
    this.requireWritable();
    if (this.journal.receipts.length >= MAX_RECEIPTS)
      throw new MaterialCommandError(
        503,
        "Command receipt capacity reached; preserve the instance journal.",
      );
    return this.transaction(() => {
      const result = perform();
      const outcome = result as { status?: string; ok?: boolean };
      if (outcome.status === "accepted" || outcome.ok === true)
        this.journal.receipts.push({
          requestId,
          kind,
          requestDigest,
          result: structuredClone(result),
        });
      return result;
    });
  }

  private isPublicationPaused(): boolean {
    return this.publicationIssue !== null || this.journal.outbox.length >= MAX_OUTBOX;
  }

  private requireWritable(): void {
    this.requireReadable();
    if (this.isPublicationPaused()) throw new MaterialCommandError(503, "Publication is paused. Resolve the reported dependency and wait for retained publications to drain. Keep the journal and original command IDs.");
  }

  private requireReadable(): void {
    if (this.closed || this.blocked)
      throw new MaterialCommandError(
        503,
        "Material runtime is blocked. Preserve its journal, restart and verify the original command result before sending another command.",
      );
  }

  private transaction<T>(perform: () => T, rejectWithoutBlocking = false): T {
    this.requireWritable();
    const before = structuredClone(this.journal);
    this.collecting = true;
    this.transient = [];
    let result: T;
    let performed = false;
    try {
      result = perform();
      performed = true;
      this.save();
    } catch (error) {
      this.journal = before;
      this.transient = [];
      if (error instanceof PublicationCapacityError) {
        this.engine.restoreCheckpoint(before.checkpoint);
        this.publicationIssue = "queue-capacity";
        void this.flushPublications();
        throw new MaterialCommandError(503, "Publication queue is full. Retained work will drain before simulation resumes; keep the journal.");
      }
      // Cassette precondition checks throw before mutation. Keep its in-flight
      // publication flag; restoring a startup snapshot would falsely unlock it.
      if (rejectWithoutBlocking && !performed) throw error;
      this.engine.restoreCheckpoint(before.checkpoint);
      this.blocked = true;
      throw new MaterialCommandError(
        503,
        "Material step could not be durably confirmed. Its outcome may be unknown; restart and check the original command result.",
      );
    } finally {
      this.collecting = false;
    }
    for (const publish of this.transient)
      void Promise.resolve()
        .then(publish)
        .catch(() => undefined);
    this.transient = [];
    void this.flushPublications();
    return result;
  }

  flushPublications(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.closed || this.blocked || Date.now() < this.retryAt)
      return Promise.resolve();
    this.flushing = (async () => {
      const recovering = this.isPublicationPaused();
      try {
        const assets: PublicationAsset[] = Object.values(this.config.productionLine)
          .filter(asset => asset && typeof asset.assetId === "string")
          .map(asset => ({assetId: asset.assetId, topicBase: this.config.topicBase}));
        const mobile = this.engine.getState().mobileCassette;
        if (mobile) for (const asset of [mobile.cassette, ...mobile.rolls]) {
          assets.push({assetId: asset.assetId, topicBase: asset.assetPath.slice(0, asset.assetPath.lastIndexOf("/"))});
        }
        for (const t of this.transports) {
          if (!t.checkPublicationReadiness) continue;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([t.checkPublicationReadiness(assets), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Publication readiness timeout")), 8000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        }
      } catch (error) { this.recordPublicationFailure(error); return; }
      if (recovering && this.journal.outbox.length) this.publicationIssue = "draining";
      let drained = 0;
      while (!this.closed && !this.blocked && this.journal.outbox.length) {
        const intent = this.journal.outbox[0]!;
        try {
          await Reflect.apply(
            Reflect.get(this.transports[intent.target]!, intent.method) as (
              ...a: unknown[]
            ) => Promise<void>,
            this.transports[intent.target],
            structuredClone(intent.args),
          );
          await this.transports[intent.target]!.flushCritical?.();
        } catch (error) {
          this.recordPublicationFailure(error);
          return;
        }
        if (this.closed || this.blocked) return;
        this.journal.outbox.shift();
        try {
          this.save();
        } catch {
          this.blocked = true;
          return;
        }
        this.failures = 0;
        this.retryAt = 0;
        // A full retained queue must not monopolize the status/API event loop.
        if (++drained % 16 === 0) await yieldToIo();
      }
      if (!this.closed && !this.blocked) { this.publicationIssue = null; this.failures = 0; this.retryAt = 0; }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private recordPublicationFailure(error: unknown): void {
    this.publicationIssue = error instanceof IdentitySourceReviewRequired ? "identity-review-required" : "publication-unavailable";
    this.failures++;
    this.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.lease.listening)
      await new Promise<void>((resolve) => this.lease.close(() => resolve()));
  }
}
