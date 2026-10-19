import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DurableMaterialRuntime,
  MaterialCommandError,
} from "../src/hrm/durable-material-runtime.js";
import {
  MqttHrmTransport,
  type IHrmTransport,
} from "../src/hrm/hrm-publisher.js";
import { config } from "./fixtures/material-runtime-config.js";
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j16-material-"));
  return {
    ...structuredClone(config),
    commandStateFile: path.join(dir, "state.json"),
    simulationSpeed: 150,
  };
};
const transport = (
  calls: Array<{ method: string; args: any[] }>,
  fail = false,
): IHrmTransport =>
  new Proxy(
    {},
    {
      get: (_o, key) =>
        key === "publishMobileCassette"
          ? undefined
          : async (...args: any[]) => {
              calls.push({ method: String(key), args: structuredClone(args) });
              if (fail) throw Error("bounded injected offline");
            },
    },
  ) as IHrmTransport;
async function finish(
  runtime: DurableMaterialRuntime,
  batchId: string,
  pred = () =>
    ["DONE", "FAILED"].includes(runtime.line.getBatch(batchId)!.stage),
) {
  for (let i = 0; i < 1000 && !pred(); i++) {
    runtime.line.tick(i);
    await runtime.flushPublications();
  }
  assert.ok(pred());
}

test("load result and complete production checkpoint survive reopen; replay is copied and changed input conflicts", async () => {
  const c = fixture();
  let r = await DurableMaterialRuntime.open(c, []);
  const req = {
    requestId: "load-1",
    recipeId: "recipe-1",
    materialId: "slab-1",
    quantity: 1,
  };
  try {
    const original = r.line.submitBatch(req);
    r.line.tick(0);
    const before = r.line.getBatch(original.batchId);
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    assert.deepEqual(
      r.line.getBatch(original.batchId),
      JSON.parse(JSON.stringify(before)),
    );
    assert.deepEqual(r.line.submitBatch({ ...req }), original);
    assert.throws(
      () => r.line.submitBatch({ ...req, quantity: 2 }),
      (e) => e instanceof MaterialCommandError && e.statusCode === 409,
    );
    assert.equal(
      r.line.getState().queue.length +
        (r.line.getState().stations.furnace.occupied ? 1 : 0),
      1,
    );
    const receipt = r.line.materialCommandResult(req.requestId) as any;
    receipt.result.materialId = "changed";
    assert.equal(
      (r.line.materialCommandResult(req.requestId) as any).result.materialId,
      "slab-1",
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("legacy loads have deterministic material identity and changed recipe/quantity cannot duplicate them", async () => {
  const c = fixture();
  let r = await DurableMaterialRuntime.open(c, []);
  try {
    const req = { recipeId: "recipe-1", materialId: "legacy", quantity: 1 },
      result = r.line.submitBatch(req);
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    assert.deepEqual(r.line.submitBatch(req), result);
    assert.throws(
      () => r.line.submitBatch({ ...req, quantity: 2 }),
      /different input/,
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("split receipt, manifest and pending outputs survive restart without creating another operation", async () => {
  const c = fixture();
  let r = await DurableMaterialRuntime.open(c, []);
  try {
    const load = r.line.submitBatch({
      requestId: "load-split",
      recipeId: "recipe-1",
      materialId: "source",
      quantity: 2,
    });
    await finish(r, load.batchId);
    const req = {
        requestId: "split-1",
        sourceBatchId: load.batchId,
        outputMaterialIds: ["child-a", "child-b"] as [string, string],
      },
      result = r.line.splitMaterial(req);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const manifests = result.value.outputs.map(
      (o) => r.line.getBatch(o.batchId)!.operationManifest,
    );
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    assert.deepEqual(r.line.splitMaterial(req), result);
    assert.deepEqual(
      result.value.outputs.map(
        (o) => r.line.getBatch(o.batchId)!.operationManifest,
      ),
      manifests,
    );
    assert.equal(new Set(manifests.map((m) => m!.operationId)).size, 1);
    assert.throws(
      () =>
        r.line.splitMaterial({
          ...req,
          outputMaterialIds: ["other", "child-b"],
        }),
      /different input/,
    );
    await finish(r, result.value.outputs[1]!.batchId);
    assert.equal(r.line.getState().completed.length, 3);
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("partially consumed merge resumes with the same inputs and produces one stable output manifest", async () => {
  const c = fixture();
  let r = await DurableMaterialRuntime.open(c, []);
  try {
    const plan = {
      recipeId: "recipe-1",
      quantity: 1,
      mergeInputMaterialIds: ["merge-a", "merge-b"],
      mergeOutputMaterialId: "merged",
    };
    const a = r.line.submitBatch({
      ...plan,
      requestId: "merge-load-a",
      materialId: "merge-a",
    });
    await finish(
      r,
      a.batchId,
      () => !!r.line.getBatch(a.batchId)?.mergeConsumedAt,
    );
    const consumed = r.line.getBatch(a.batchId)!.mergeConsumedAt;
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    assert.equal(r.line.getBatch(a.batchId)!.mergeConsumedAt, consumed);
    const b = r.line.submitBatch({
      ...plan,
      requestId: "merge-load-b",
      materialId: "merge-b",
    });
    await finish(r, b.batchId, () => r.line.getState().completed.length > 0);
    const output = r.line
      .getState()
      .completed.map((x) => r.line.getBatch(x.batchId)!)
      .find((x) => x.materialId === "merged")!;
    assert.ok(output);
    assert.equal(output.operationManifest!.inputs.length, 2);
    const before = structuredClone(output);
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    for (let i = 0; i < 10; i++) r.line.tick(i);
    assert.deepEqual(
      r.line.getBatch(output.batchId)!.operationManifest,
      before.operationManifest,
    );
    assert.equal(
      r.line
        .getState()
        .completed.filter(
          (x) => r.line.getBatch(x.batchId)?.materialId === "merged",
        ).length,
      1,
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("failed critical publication stays in the journal and is replayed identically after reopening", async () => {
  const c = fixture(),
    failed: any[] = [],
    published: any[] = [];
  let r = await DurableMaterialRuntime.open(c, [transport(failed, true)]);
  try {
    r.line.submitBatch({
      requestId: "offline-load",
      recipeId: "recipe-1",
      materialId: "offline",
      quantity: 1,
    });
    await r.flushPublications();
    const state = JSON.parse(fs.readFileSync(c.commandStateFile, "utf8"));
    assert.equal(state.outbox.length, 2);
    const first = structuredClone(failed[0]);
    await r.close();
    r = await DurableMaterialRuntime.open(c, [transport(published)]);
    await r.flushPublications();
    assert.deepEqual(published[0], first);
    assert.equal(
      JSON.parse(fs.readFileSync(c.commandStateFile, "utf8")).outbox.length,
      0,
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("write failure before rename publishes nothing, blocks further writes and restart restores the previous checkpoint", async (t) => {
  const c = fixture(),
    calls: any[] = [];
  let r = await DurableMaterialRuntime.open(c, [transport(calls)]);
  try {
    const mock = t.mock.method(fs, "renameSync", () => {
      throw Error("injected rename failure");
    });
    assert.throws(
      () =>
        r.line.submitBatch({
          requestId: "failed-load",
          recipeId: "recipe-1",
          materialId: "failed",
          quantity: 1,
        }),
      (e) => e instanceof MaterialCommandError && e.statusCode === 503,
    );
    mock.mock.restore();
    assert.equal(calls.length, 0);
    assert.throws(() => r.line.tick(0), /blocked/);
    assert.throws(() => r.line.materialCommandResult("failed-load"), /blocked/);
    await r.close();
    r = await DurableMaterialRuntime.open(c, [transport(calls)]);
    assert.equal(r.line.getState().queue.length, 0);
    assert.equal(r.line.materialCommandResult("failed-load"), null);
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("failure after rename has unknown outcome; restart recovers the committed result instead of resubmitting", async (t) => {
  const c = fixture(),
    calls: any[] = [];
  let r = await DurableMaterialRuntime.open(c, [transport(calls)]);
  try {
    const sync = fs.fsyncSync;
    let n = 0;
    const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (++n === 2) throw Error("directory sync interrupted");
      sync(fd);
    });
    const req = {
      requestId: "unknown-load",
      recipeId: "recipe-1",
      materialId: "unknown",
      quantity: 1,
    };
    assert.throws(() => r.line.submitBatch(req), /unknown/);
    mock.mock.restore();
    assert.equal(calls.length, 0);
    await r.close();
    r = await DurableMaterialRuntime.open(c, [transport(calls)]);
    const result = r.line.submitBatch(req);
    assert.equal(result.status, "accepted");
    assert.equal(r.line.getState().queue.length, 1);
    await r.flushPublications();
    assert.equal(
      JSON.parse(fs.readFileSync(c.commandStateFile, "utf8")).outbox.length,
      0,
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("corrupt/config-incompatible journals fail closed and a concurrent local writer is rejected", async () => {
  const c = fixture();
  const r = await DurableMaterialRuntime.open(c, []);
  await assert.rejects(DurableMaterialRuntime.open(c, []), /lease/);
  await r.close();
  const original = fs.readFileSync(c.commandStateFile, "utf8");
  await assert.rejects(
    DurableMaterialRuntime.open({ ...c, simulationSpeed: 9 }, []),
    /incompatible/,
  );
  assert.equal(fs.readFileSync(c.commandStateFile, "utf8"), original);
  fs.writeFileSync(c.commandStateFile, original.slice(0, 20));
  await assert.rejects(DurableMaterialRuntime.open(c, []));
  assert.equal(
    fs.readFileSync(c.commandStateFile, "utf8"),
    original.slice(0, 20),
  );
  fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
});

test("receipt/outbox capacities retain evidence and refuse new work instead of evicting old IDs", async () => {
  const { createHash } = await import("node:crypto");
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  for (const capacity of ["receipts", "outbox"]) {
    const c = fixture();
    let r = await DurableMaterialRuntime.open(c, [transport([])]);
    await r.close();
    try {
      const { checksum: _old, ...journal } = JSON.parse(
        fs.readFileSync(c.commandStateFile, "utf8"),
      );
      if (capacity === "receipts")
        journal.receipts = Array.from({ length: 4096 }, (_, i) => ({
          requestId: "saved-" + i,
          kind: "load",
          requestDigest: "a".repeat(64),
          result: { status: "accepted" },
        }));
      else
        journal.outbox = Array.from({ length: 4096 }, (_, i) => ({
          id: "pending-" + i,
          target: 0,
          method: "publishMaterialStatus",
          args: [],
        }));
      const original = JSON.stringify({
        ...journal,
        checksum: createHash("sha256")
          .update(JSON.stringify(canonical(journal)))
          .digest("hex"),
      });
      fs.writeFileSync(c.commandStateFile, original);
      r = await DurableMaterialRuntime.open(c, [transport([])]);
      assert.throws(
        () =>
          r.line.submitBatch({
            requestId: "capacity-load",
            recipeId: "recipe-1",
            materialId: "capacity",
            quantity: 1,
          }),
        (e) => e instanceof MaterialCommandError && e.statusCode === 503,
      );
      assert.equal(fs.readFileSync(c.commandStateFile, "utf8"), original);
    } finally {
      await r.close();
      fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
    }
  }
});

test("recipe changes and cassette readings/location share the restored runtime checkpoint", async () => {
  const c = fixture(),
    profile = JSON.parse(
      fs.readFileSync(
        new URL("../config-development-host.json", import.meta.url),
        "utf8",
      ),
    );
  c.productionLine.rollingStand.mobileCassette =
    profile.hrm.productionLine.rollingStand.mobileCassette;
  let r = await DurableMaterialRuntime.open(c, []);
  try {
    const equipment = r.line.getState().mobileCassette!;
    assert.ok(equipment);
    assert.throws(
      () =>
        r.line.moveRollCassette(
          "workshop",
          equipment.revision + 1,
          equipment.runId,
        ),
      /changed/,
    );
    r.line.moveRollCassette("workshop", equipment.revision, equipment.runId);
    r.line.updateRecipe("recipe-1", { targetTempC: 1100 });
    r.line.tick(0);
    const before = r.line.getState().mobileCassette;
    await r.close();
    r = await DurableMaterialRuntime.open(c, []);
    assert.deepEqual(r.line.getState().mobileCassette, before);
    assert.equal(r.line.getRecipe("recipe-1")!.furnace.targetTempC, 1100);
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("SDK enqueue alone does not acknowledge an intent when publisher drain fails", async () => {
  const c = fixture(),
    calls: any[] = [],
    drains: number[] = [];
  const t = new MqttHrmTransport(
    {
      publishMqttMessage: async (message: unknown) => {
        calls.push(message);
      },
      flush: async (ms: number) => {
        drains.push(ms);
        throw Error("publish completion unavailable");
      },
    } as never,
    1000,
  );
  let r = await DurableMaterialRuntime.open(c, [t]);
  try {
    r.line.submitBatch({
      requestId: "drain-load",
      recipeId: "recipe-1",
      materialId: "drain",
      quantity: 1,
    });
    await r.flushPublications();
    assert.equal(
      JSON.parse(fs.readFileSync(c.commandStateFile, "utf8")).outbox.length,
      2,
    );
    assert.deepEqual(drains, [5000]);
    await r.close();
    r = await DurableMaterialRuntime.open(c, [transport([])]);
    await r.flushPublications();
    assert.equal(
      JSON.parse(fs.readFileSync(c.commandStateFile, "utf8")).outbox.length,
      0,
    );
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("a rejected move does not clear the in-flight cassette publication guard", async () => {
  const c = fixture(),
    profile = JSON.parse(
      fs.readFileSync(
        new URL("../config-development-host.json", import.meta.url),
        "utf8",
      ),
    );
  c.productionLine.rollingStand.mobileCassette =
    profile.hrm.productionLine.rollingStand.mobileCassette;
  const t = new Proxy(transport([]), {
    get(target, key) {
      return key === "publishMobileCassette"
        ? () => new Promise<void>(() => undefined)
        : Reflect.get(target, key);
    },
  });
  const r = await DurableMaterialRuntime.open(c, [t]);
  try {
    r.line.tick(0);
    const state = r.line.getState().mobileCassette!;
    assert.equal(state.publicationState, "sending");
    assert.throws(
      () => r.line.moveRollCassette("store", state.revision, state.runId),
      /publication/,
    );
    assert.equal(r.line.getState().mobileCassette!.publicationState, "sending");
    r.line.tick(1);
  } finally {
    await r.close();
    fs.rmSync(path.dirname(c.commandStateFile), { recursive: true });
  }
});

test("API preserves unknown storage outcomes as503, separate from an ordinary cassette conflict409", async () => {
  const { serviceApis } = await import("../src/api-routes.js");
  for (const error of [
    new MaterialCommandError(503, "Unknown durable outcome"),
    Error("The cassette changed"),
  ]) {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    await (serviceApis.moveRollCassette.handler as Function)(
      {
        req: {
          body: {
            location: "store",
            expectedRevision: 1,
            expectedRunId: "11111111-1111-4111-8111-111111111111",
          },
        },
        res,
      },
      {
        line: {
          moveRollCassette() {
            throw error;
          },
        },
      },
    );
    assert.equal(status, error instanceof MaterialCommandError ? 503 : 409);
  }
});
