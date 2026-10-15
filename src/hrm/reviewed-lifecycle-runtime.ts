import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  parseReviewedContract,
  reviewedContractSchema,
  runtimeDigest,
  type ReviewedContract,
} from "./reviewed-lifecycle-contract.js";
export interface ReviewedLifecycleConfig {
  contractFile: string;
  contractDigest: string;
  stateFile: string;
  maintenanceState?: string | undefined;
}
const pin = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const lifecycleCommandSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedContractDigest: pin,
    expectedExecutorId: z.string().uuid().optional(),
    actionKey: z.string().min(1).max(240),
  })
  .strict();
export const lifecycleAdoptionSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedContractDigest: pin,
    newContractDigest: pin,
    expectedExecutorId: z.string().uuid().optional(),
  })
  .strict();
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;
export type LifecycleAdoption = z.infer<typeof lifecycleAdoptionSchema>;
const pinnedAdoptionSchema = lifecycleAdoptionSchema.extend({
  expectedExecutorId: z.string().uuid(),
});
export const lifecycleClosureSchema = z
  .object({
    adoption: pinnedAdoptionSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedContractDigest: pin,
    expectedOfferedContractDigest: pin,
    acknowledgeClosure: z.literal(true),
  })
  .strict();
const receiptSchema = z
  .object({
    operationId: z.string().uuid(),
    requestDigest: pin,
    revision: z.number().int().positive(),
    state: z.string().min(1),
    contractDigest: pin,
    kind: z.enum(["action", "adopt"]),
    outcome: z.enum(["applied", "closed"]).optional(),
    closedAdoption: pinnedAdoptionSchema.optional(),
    closureRequestDigest: pin.optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.outcome === "closed"
        ? r.kind === "adopt" &&
          !!r.closedAdoption &&
          !!r.closureRequestDigest &&
          r.operationId === r.closedAdoption.operationId &&
          r.requestDigest ===
            runtimeDigest({ kind: "adopt", request: r.closedAdoption })
        : r.closedAdoption === undefined &&
          r.closureRequestDigest === undefined,
    "Invalid closed adoption receipt",
  );
export type LifecycleReceipt = z.infer<typeof receiptSchema>;
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    executorId: z.string().uuid().optional(),
    contract: reviewedContractSchema,
    state: z.string().min(1),
    revision: z.number().int().nonnegative(),
    receipts: z.array(receiptSchema).max(256),
    journalDigest: pin,
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const MAX_BYTES = 1024 * 1024;
async function readJson(file: string, max: number): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw Error("Expected a bounded regular local file.");
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}
/** One local filesystem/host only. An OS loopback lease is released even by SIGKILL. No protocol is served. */
export class ReviewedLifecycleRuntime {
  private journal!: Journal;
  private offered!: ReviewedContract;
  private busy = false;
  private uncertain = false;
  private closed = false;
  private constructor(
    private readonly config: ReviewedLifecycleConfig,
    private readonly stateFile: string,
    private readonly lease: net.Server,
  ) {}
  static async open(
    config: ReviewedLifecycleConfig,
  ): Promise<ReviewedLifecycleRuntime> {
    if (
      !path.isAbsolute(config.stateFile) ||
      !path.isAbsolute(config.contractFile)
    )
      throw Error("Reviewed lifecycle files must be explicit absolute paths.");
    await fs.mkdir(path.dirname(config.stateFile), {
      recursive: true,
      mode: 0o700,
    });
    const stateFile = path.join(
      await fs.realpath(path.dirname(config.stateFile)),
      path.basename(config.stateFile),
    );
    if (stateFile === (await fs.realpath(config.contractFile)))
      throw Error("State journal and contract file must differ.");
    const port =
      20000 +
      (parseInt(
        createHash("sha256").update(stateFile).digest("hex").slice(0, 8),
        16,
      ) %
        35000);
    const lease = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      lease.once("error", () =>
        reject(
          Error(
            "Local lifecycle writer lease is unavailable. Another instance or port reservation may exist.",
          ),
        ),
      );
      lease.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        resolve(),
      );
    });
    const runtime = new ReviewedLifecycleRuntime(config, stateFile, lease);
    try {
      runtime.offered = parseReviewedContract(
        await readJson(config.contractFile, 128 * 1024),
        config.contractDigest,
      );
      if (
        !runtime.offered.state.definition.spec.values.some(
          (v) => v.key === (config.maintenanceState ?? "maintenance"),
        )
      )
        throw Error(
          "The configured maintenance state is absent from the reviewed model.",
        );
      let input: unknown;
      try {
        input = await readJson(stateFile, MAX_BYTES);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (input === undefined) {
        const base = {
          schemaVersion: 1 as const,
          executorId: randomUUID(),
          contract: runtime.offered,
          state: runtime.offered.state.definition.spec.initialValue,
          revision: 0,
          receipts: [],
        };
        runtime.journal = { ...base, journalDigest: runtimeDigest(base) };
        await runtime.persist(runtime.journal);
      } else {
        const stored = journalSchema.parse(input),
          { journalDigest, ...base } = stored;
        if (
          runtimeDigest(base) !== journalDigest ||
          stored.revision !== stored.receipts.length ||
          stored.receipts.some((r, i) => r.revision !== i + 1) ||
          new Set(stored.receipts.map((r) => r.operationId)).size !==
            stored.receipts.length
        )
          throw Error(
            "Lifecycle journal integrity failed; no state reset is performed.",
          );
        parseReviewedContract(stored.contract, stored.contract.contractDigest);
        if (
          !stored.contract.state.definition.spec.values.some(
            (v) => v.key === stored.state,
          ) ||
          (stored.receipts.length &&
            stored.receipts.at(-1)!.state !== stored.state) ||
          stored.contract.state.key !== runtime.offered.state.key ||
          stored.contract.packageId !== runtime.offered.packageId
        )
          throw Error("Lifecycle journal does not match this reviewed model.");
        runtime.journal = stored;
        if (!stored.executorId) {
          const upgraded = { ...base, executorId: randomUUID() };
          runtime.journal = {
            ...upgraded,
            journalDigest: runtimeDigest(upgraded),
          };
          await runtime.persist(runtime.journal);
        }
      }
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  private async persist(value: Journal): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES)
      throw Error("Lifecycle journal capacity exceeded.");
    const pending = this.stateFile + ".pending-" + randomUUID();
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      file = await fs.open(pending, "wx", 0o600);
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(pending, this.stateFile);
      const dir = await fs.open(path.dirname(this.stateFile), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      this.uncertain = true;
      throw Error(
        "Lifecycle write outcome is unknown. Stop new commands and restart to read the durable journal; retain the operation ID.",
      );
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  status() {
    const j = this.journal;
    const summary = (c: ReviewedContract) => ({
      packageId: c.packageId,
      packageVersion: c.packageVersion,
      contractDigest: c.contractDigest,
      reviewOperationId: c.reviewOperationId,
      stateKey: c.state.key,
      actions: c.actions.map((a) => ({
        key: a.key,
        label: a.definition.label,
        transitions: a.definition.spec.stateTransitions.map((t) => ({
          from: t.from,
          to: t.to,
        })),
      })),
    });
    const reason = this.closed
      ? "The executor is stopped."
      : this.uncertain
        ? "The write outcome is unknown. Restart the executor and check the saved operation."
        : this.busy
          ? "A lifecycle write is in progress."
          : j.receipts.length >= 256
            ? "The journal is full. Preserve its receipts before preparing another demo session."
            : this.successorBlockReason();
    return {
      executorId: j.executorId!,
      closureSupported: true,
      closureAvailable:
        !this.closed &&
        !this.busy &&
        !this.uncertain &&
        j.receipts.length < 256,
      accepted: summary(j.contract),
      offered: summary(this.offered),
      adoption: { available: reason === null, reason },
      state: j.state,
      revision: j.revision,
      contractDigest: j.contract.contractDigest,
      offeredContractDigest: this.offered.contractDigest,
      reviewOperationId: j.contract.reviewOperationId,
      stateKey: j.contract.state.key,
      health: this.uncertain
        ? ("unknown" as const)
        : j.contract.contractDigest !== this.offered.contractDigest
          ? ("adoption_required" as const)
          : ("ready" as const),
      inFlight: this.busy,
      rollingAllowed: this.rollingAllowed,
      actions: j.contract.actions.map((a) => ({
        key: a.key,
        label: a.definition.label,
        available:
          !this.busy &&
          !this.uncertain &&
          j.contract.contractDigest === this.offered.contractDigest &&
          a.definition.spec.stateTransitions.filter((t) =>
            t.from.includes(j.state),
          ).length === 1,
      })),
    };
  }
  private successorBlockReason(): string | null {
    const contract = this.journal.contract,
      next = this.offered,
      state = this.journal.state;
    if (next.contractDigest === contract.contractDigest)
      return "The offered contract is already accepted.";
    if (
      next.previousSnapshotDigest !== contract.activeSnapshotDigest ||
      next.state.key !== contract.state.key ||
      next.packageId !== contract.packageId ||
      !next.state.definition.spec.values.some((v) => v.key === state) ||
      !contract.state.definition.spec.values.every((v) =>
        next.state.definition.spec.values.some(
          (n) => runtimeDigest(n) === runtimeDigest(v),
        ),
      ) ||
      next.state.definition.spec.initialValue !==
        contract.state.definition.spec.initialValue ||
      runtimeDigest(next.actions.map((a) => a.key).sort()) !==
        runtimeDigest(contract.actions.map((a) => a.key).sort())
    )
      return "The offered contract is not a direct successor that retains the current state and model identities.";
    return null;
  }
  get rollingAllowed() {
    return (
      !this.closed &&
      !this.busy &&
      !this.uncertain &&
      this.journal.contract.contractDigest === this.offered.contractDigest &&
      this.journal.state !== (this.config.maintenanceState ?? "maintenance")
    );
  }
  result(operationId: string) {
    return (() => {
      const receipt = this.journal.receipts.find(
        (r) => r.operationId === operationId,
      );
      return receipt
        ? { ...receipt, executorId: this.journal.executorId! }
        : null;
    })();
  }
  private async change(
    kind: "action" | "adopt",
    request: LifecycleCommand | LifecycleAdoption,
    guard: () => boolean,
  ): Promise<LifecycleReceipt & { replayed: boolean; executorId: string }> {
    if (
      request.expectedExecutorId !== undefined &&
      request.expectedExecutorId !== this.journal.executorId
    )
      throw Error(
        "The executor journal changed. Retain the operation and check the original executor.",
      );
    const requestDigest = runtimeDigest({ kind, request }),
      old = this.result(request.operationId);
    if (old) {
      if (old.requestDigest !== requestDigest)
        throw Error("Operation ID already belongs to a different command.");
      if (old.outcome === "closed")
        throw Error(
          "This adoption attempt was durably closed and cannot execute. Read its stored result.",
        );
      return { ...old, replayed: true, executorId: this.journal.executorId! };
    }
    if (this.closed || this.uncertain || this.busy)
      throw Error(
        "Lifecycle is unavailable or its write outcome is unknown; recover the stored result before another command.",
      );
    if (
      request.expectedRevision !== this.journal.revision ||
      request.expectedContractDigest !== this.journal.contract.contractDigest
    )
      throw Error(
        "Lifecycle state or contract changed. Refresh before executing.",
      );
    if (this.journal.receipts.length >= 256)
      throw Error(
        "Lifecycle journal is full. Preserve receipts and prepare an explicit new demo session.",
      );
    this.busy = true;
    try {
      if (!guard()) throw Error("Wait until the rolling stand is empty.");
      let contract = this.journal.contract,
        state = this.journal.state;
      if (kind === "adopt") {
        const adoption = request as LifecycleAdoption,
          next = this.offered;
        if (
          adoption.newContractDigest !== next.contractDigest ||
          this.successorBlockReason() !== null
        )
          throw Error(
            "Offered contract is not the direct reviewed successor or cannot retain the current state.",
          );
        contract = next;
      } else {
        if (contract.contractDigest !== this.offered.contractDigest)
          throw Error(
            "Explicit adoption of the offered reviewed successor is required first.",
          );
        const action = contract.actions.find(
          (a) => a.key === (request as LifecycleCommand).actionKey,
        );
        const transitions = action?.definition.spec.stateTransitions.filter(
          (t) => t.from.includes(state),
        );
        if (!transitions || transitions.length !== 1)
          throw Error(
            "Action is unavailable or ambiguous for the current state.",
          );
        state = transitions[0]!.to;
      }
      const receipt: LifecycleReceipt = {
        operationId: request.operationId,
        requestDigest,
        revision: this.journal.revision + 1,
        state,
        contractDigest: contract.contractDigest,
        kind,
        outcome: "applied",
      };
      const base = {
          schemaVersion: 1 as const,
          executorId: this.journal.executorId!,
          contract,
          state,
          revision: receipt.revision,
          receipts: [...this.journal.receipts, receipt],
        },
        next = { ...base, journalDigest: runtimeDigest(base) };
      await this.persist(next);
      this.journal = next;
      return {
        ...receipt,
        replayed: false,
        executorId: this.journal.executorId!,
      };
    } finally {
      this.busy = false;
    }
  }
  execute(input: unknown, guard: () => boolean = () => true) {
    return this.change("action", lifecycleCommandSchema.parse(input), guard);
  }
  adopt(input: unknown, guard: () => boolean = () => true) {
    return this.change("adopt", lifecycleAdoptionSchema.parse(input), guard);
  }
  /** A durable negative receipt fences late delivery without deleting evidence or changing state. */
  async closeAdoption(
    input: unknown,
  ): Promise<LifecycleReceipt & { executorId: string; replayed: boolean }> {
    const request = lifecycleClosureSchema.parse(input),
      adoption = request.adoption;
    if (adoption.expectedExecutorId !== this.journal.executorId)
      throw Error("Recover on the original executor journal.");
    const requestDigest = runtimeDigest({ kind: "adopt", request: adoption }),
      closureRequestDigest = runtimeDigest(request),
      old = this.result(adoption.operationId);
    if (old) {
      if (old.kind !== "adopt" || old.requestDigest !== requestDigest)
        throw Error("Operation ID belongs to another command.");
      if (
        old.outcome === "closed" &&
        old.closureRequestDigest !== closureRequestDigest
      )
        throw Error(
          "Use the saved identical closure request or read its stored result.",
        );
      return { ...old, replayed: true };
    }
    if (this.closed || this.busy || this.uncertain)
      throw Error(
        "The write outcome is unknown or a write is in progress. Recover before closing.",
      );
    if (
      request.expectedRevision !== this.journal.revision ||
      request.expectedContractDigest !== this.journal.contract.contractDigest ||
      request.expectedOfferedContractDigest !== this.offered.contractDigest ||
      adoption.expectedRevision > this.journal.revision
    )
      throw Error("Closure review is stale. Refresh and review again.");
    if (this.journal.receipts.length >= 256)
      throw Error("The journal is full; preserve its evidence.");
    this.busy = true;
    try {
      const receipt: LifecycleReceipt = {
        operationId: adoption.operationId,
        requestDigest,
        revision: this.journal.revision + 1,
        state: this.journal.state,
        contractDigest: this.journal.contract.contractDigest,
        kind: "adopt",
        outcome: "closed",
        closedAdoption: adoption,
        closureRequestDigest,
      };
      const base = {
          schemaVersion: 1 as const,
          executorId: this.journal.executorId!,
          contract: this.journal.contract,
          state: this.journal.state,
          revision: receipt.revision,
          receipts: [...this.journal.receipts, receipt],
        },
        next = { ...base, journalDigest: runtimeDigest(base) };
      await this.persist(next);
      this.journal = next;
      return {
        ...receipt,
        executorId: this.journal.executorId!,
        replayed: false,
      };
    } finally {
      this.busy = false;
    }
  }
  async close() {
    if (this.busy)
      throw Error(
        "Wait for the lifecycle write or terminate the process and recover from the journal.",
      );
    this.closed = true;
    if (this.lease.listening)
      await new Promise<void>((resolve) => this.lease.close(() => resolve()));
  }
}
