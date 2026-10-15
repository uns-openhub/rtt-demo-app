import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ReviewedLifecycleRuntime } from "../src/hrm/reviewed-lifecycle-runtime.js";
import {
  runtimeDigest,
  parseReviewedContract,
} from "../src/hrm/reviewed-lifecycle-contract.js";
import { HrmProductionLine } from "../src/hrm/hrm-production-line.js";
import type { HrmConfig } from "../src/hrm/hrm-types.js";
function capsule(to = "maintenance", previous = "a", active = "b") {
  const base = {
    schemaVersion: 1,
    kind: "reviewed-demo-state-action",
    scopeKey: "tenant:default",
    packageId: "demo.core",
    packageVersion: active === "b" ? "1.1.1" : "1.1.2",
    reviewOperationId: randomUUID(),
    reviewDigest: "sha256:" + "d".repeat(64),
    previousSnapshotDigest: "sha256:" + previous.repeat(64),
    activeSnapshotDigest: "sha256:" + active.repeat(64),
    state: {
      key: "demo.lifecycle",
      definition: {
        schemaVersion: 1,
        label: "Lifecycle",
        spec: {
          values: [
            { key: "idle", label: "Idle" },
            { key: "busy", label: "Busy" },
            { key: "maintenance", label: "Maintenance" },
          ],
          initialValue: "idle",
          transitions: [
            { from: "idle", to: "busy" },
            { from: "idle", to: "maintenance" },
          ],
        },
      },
    },
    actions: [
      {
        key: "demo.use",
        definition: {
          schemaVersion: 1,
          label: "Use",
          spec: {
            target: "entity",
            stateTransitions: [{ state: "demo.lifecycle", from: ["idle"], to }],
          },
        },
      },
    ],
  };
  return { ...base, contractDigest: runtimeDigest(base) };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "g207-demo-unit-"));
  const first = capsule(),
    contractFile = path.join(root, "contract.json"),
    stateFile = path.join(root, "state.json");
  await fs.writeFile(contractFile, JSON.stringify(first));
  return {
    root,
    first,
    config: { contractFile, stateFile, contractDigest: first.contractDigest },
  };
}
test("pinned contract is required; altered executable specs and unknown fields are rejected", () => {
  const a = capsule();
  assert.equal(
    parseReviewedContract(a, a.contractDigest).state.key,
    "demo.lifecycle",
  );
  assert.throws(() => parseReviewedContract(a, "sha256:" + "0".repeat(64)));
  const b = structuredClone(a);
  b.actions[0]!.definition.spec.stateTransitions[0]!.to = "busy";
  assert.throws(() => parseReviewedContract(b, a.contractDigest));
  assert.throws(() =>
    parseReviewedContract({ ...a, token: "not-allowed" }, a.contractDigest),
  );
});
test("actual demo line blocks rolling during maintenance; restart restores state and replay", async () => {
  const f = await fixture();
  let r: ReviewedLifecycleRuntime | undefined;
  try {
    r = await ReviewedLifecycleRuntime.open(f.config);
    const request = {
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedContractDigest: f.first.contractDigest,
      actionKey: "demo.use",
    };
    const config = (
      JSON.parse(
        await fs.readFile(
          new URL("../config-development-host.json", import.meta.url),
          "utf8",
        ),
      ) as { hrm: HrmConfig }
    ).hrm;
    config.simulationSpeed = 100;
    for (const recipe of config.recipes) {
      recipe.furnace.targetTempC = 30;
      recipe.furnace.pusherPaceMin = 0.001;
      recipe.furnace.soakingTimeMin = 0.001;
      recipe.furnace.zones.forEach((z) => (z.setpointC = 30));
    }
    config.productionLine.descaling.durationMin = 0.001;
    const line = new HrmProductionLine(config, [], r);
    await line.executeReviewedAction(request);
    line.submitBatch({
      recipeId: config.recipes[0]!.id,
      materialId: "g207-unit",
      quantity: 1,
    });
    for (let i = 0; i < 300; i++) line.tick(i);
    assert.equal(line.getState().stations.rolling.occupied, false);
    assert.equal(line.getState().stations.descaling.occupied, true);
    assert.equal(line.rollingPermitted, false);
    await r.close();
    r = await ReviewedLifecycleRuntime.open(f.config);
    assert.equal(r.status().state, "maintenance");
    assert.equal((await r.execute(request)).replayed, true);
    assert.equal(r.status().revision, 1);
    await assert.rejects(
      r.execute({ ...request, actionKey: "other" }),
      /different command/,
    );
    await assert.rejects(
      r.execute({ ...request, operationId: randomUUID() }),
      /changed/,
    );
  } finally {
    await r?.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("one writer, corrupt journal is never reset, and a reviewed successor requires explicit adoption", async () => {
  const f = await fixture();
  let r: ReviewedLifecycleRuntime | undefined;
  try {
    r = await ReviewedLifecycleRuntime.open(f.config);
    await assert.rejects(ReviewedLifecycleRuntime.open(f.config), /lease/);
    await r.close();
    r = undefined;
    const next = capsule("busy", "b", "c");
    await fs.writeFile(f.config.contractFile, JSON.stringify(next));
    r = await ReviewedLifecycleRuntime.open({
      ...f.config,
      contractDigest: next.contractDigest,
    });
    assert.equal(r.status().health, "adoption_required");
    assert.equal(r.rollingAllowed, false);
    const command = {
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedContractDigest: f.first.contractDigest,
      actionKey: "demo.use",
    };
    await assert.rejects(r.execute(command), /adoption/);
    await r.adopt({
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedContractDigest: f.first.contractDigest,
      newContractDigest: next.contractDigest,
    });
    assert.equal(r.status().state, "idle");
    assert.equal(r.status().revision, 1);
    const applied = await r.execute({
      ...command,
      operationId: randomUUID(),
      expectedRevision: 1,
      expectedContractDigest: next.contractDigest,
    });
    assert.equal(applied.state, "busy");
    assert.equal(r.rollingAllowed, true);
    await r.close();
    r = undefined;
    await fs.writeFile(f.config.stateFile, "broken");
    await assert.rejects(
      ReviewedLifecycleRuntime.open({
        ...f.config,
        contractDigest: next.contractDigest,
      }),
    );
    assert.equal(await fs.readFile(f.config.stateFile, "utf8"), "broken");
  } finally {
    await r?.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("operator status explains offers, pins executor identity and upgrades a legacy journal without resetting receipts", async () => {
  const f = await fixture();
  let r: ReviewedLifecycleRuntime | undefined;
  try {
    r = await ReviewedLifecycleRuntime.open(f.config);
    const id = r.status().executorId;
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(r.status().adoption.available, false);
    assert.equal(r.status().accepted.contractDigest, f.first.contractDigest);
    const request = {
      operationId: randomUUID(),
      expectedRevision: 0,
      expectedContractDigest: f.first.contractDigest,
      expectedExecutorId: id,
      actionKey: "demo.use",
    };
    await assert.rejects(
      r.execute({ ...request, expectedExecutorId: randomUUID() }),
      /journal changed/,
    );
    await r.execute(request);
    await r.close();
    r = await ReviewedLifecycleRuntime.open(f.config);
    assert.equal(r.status().executorId, id);
    assert.equal(r.result(request.operationId)?.executorId, id);
    await r.close();
    r = undefined;
    const journal = JSON.parse(await fs.readFile(f.config.stateFile, "utf8"));
    delete journal.executorId;
    for(const receipt of journal.receipts)delete receipt.outcome;
    delete journal.journalDigest;
    await fs.writeFile(
      f.config.stateFile,
      JSON.stringify({ ...journal, journalDigest: runtimeDigest(journal) }),
    );
    r = await ReviewedLifecycleRuntime.open(f.config);
    const migrated = r.status();
    assert.equal(migrated.state, "maintenance");
    assert.equal(migrated.revision, 1);
    assert.equal(
      r.result(request.operationId)?.operationId,
      request.operationId,
    );
    await r.close();
    r = undefined;
    const next = capsule("busy", "b", "c");
    await fs.writeFile(f.config.contractFile, JSON.stringify(next));
    r = await ReviewedLifecycleRuntime.open({
      ...f.config,
      contractDigest: next.contractDigest,
    });
    assert.equal(r.status().executorId, migrated.executorId);
    assert.equal(r.status().adoption.available, true);
    assert.equal(r.status().offered.packageVersion, "1.1.2");
  } finally {
    await r?.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

async function closureFixture() {
  const f = await fixture(),
    next = capsule("busy", "b", "c");
  let runtime = await ReviewedLifecycleRuntime.open(f.config);
  await runtime.close();
  await fs.writeFile(f.config.contractFile, JSON.stringify(next));
  const config = { ...f.config, contractDigest: next.contractDigest };
  runtime = await ReviewedLifecycleRuntime.open(config);
  const adoption = {
    operationId: randomUUID(),
    expectedExecutorId: runtime.status().executorId,
    expectedRevision: 0,
    expectedContractDigest: f.first.contractDigest,
    newContractDigest: next.contractDigest,
  };
  const closure = {
    adoption,
    expectedRevision: 0,
    expectedContractDigest: f.first.contractDigest,
    expectedOfferedContractDigest: next.contractDigest,
    acknowledgeClosure: true as const,
  };
  return { ...f, next, config, runtime, adoption, closure };
}
test("durable closure preserves state and fences late adoption across restart; fresh adoption uses a new ID", async () => {
  const f = await closureFixture();
  let r = f.runtime;
  try {
    const before = r.status();
    const closed = await r.closeAdoption(f.closure);
    assert.equal(closed.outcome, "closed");
    assert.equal(closed.revision, 1);
    assert.equal(r.status().state, before.state);
    assert.equal(r.status().contractDigest, before.contractDigest);
    assert.equal((await r.closeAdoption(f.closure)).replayed, true);
    await assert.rejects(r.adopt(f.adoption), /closed/);
    await r.close();
    r = await ReviewedLifecycleRuntime.open(f.config);
    assert.equal(r.result(f.adoption.operationId)?.outcome, "closed");
    await assert.rejects(r.adopt(f.adoption), /closed/);
    const applied = await r.adopt({
      ...f.adoption,
      operationId: randomUUID(),
      expectedRevision: 1,
    });
    assert.equal(applied.outcome, "applied");
    assert.equal(applied.revision, 2);
    assert.equal(applied.state, before.state);
  } finally {
    await r.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("adoption and closure serialize to exactly one terminal result", async () => {
  for (const adoptionFirst of [true, false]) {
    const f = await closureFixture();
    const r = f.runtime;
    try {
      const first = adoptionFirst
        ? r.adopt(f.adoption)
        : r.closeAdoption(f.closure);
      await assert.rejects(
        adoptionFirst ? r.closeAdoption(f.closure) : r.adopt(f.adoption),
        /progress|unknown|unavailable/,
      );
      await first;
      assert.equal(r.status().revision, 1);
      if (adoptionFirst) {
        const result = await r.closeAdoption(f.closure);
        assert.equal(result.outcome, "applied");
        assert.equal(result.replayed, true);
        assert.equal(r.status().contractDigest, f.next.contractDigest);
      } else {
        await assert.rejects(r.adopt(f.adoption), /closed/);
        assert.equal(r.status().contractDigest, f.first.contractDigest);
      }
    } finally {
      await r.close();
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
});
test("closure requires exact fresh pins, original executor and explicit acknowledgement", async () => {
  const f = await closureFixture();
  try {
    const before = await fs.readFile(f.config.stateFile, "utf8");
    for (const request of [
      { ...f.closure, expectedRevision: 1 },
      { ...f.closure, expectedContractDigest: "sha256:" + "0".repeat(64) },
      {
        ...f.closure,
        expectedOfferedContractDigest: "sha256:" + "0".repeat(64),
      },
      {
        ...f.closure,
        adoption: { ...f.adoption, expectedExecutorId: randomUUID() },
      },
      { ...f.closure, acknowledgeClosure: false },
      { ...f.closure, force: true },
    ])
      await assert.rejects(f.runtime.closeAdoption(request));
    assert.equal(await fs.readFile(f.config.stateFile, "utf8"), before);
    await f.runtime.closeAdoption(f.closure);
    await assert.rejects(
      f.runtime.closeAdoption({ ...f.closure, expectedRevision: 1 }),
      /identical closure/,
    );
    await assert.rejects(
      f.runtime.closeAdoption({
        ...f.closure,
        adoption: {
          ...f.adoption,
          newContractDigest: "sha256:" + "0".repeat(64),
        },
      }),
      /another command/,
    );
  } finally {
    await f.runtime.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("closed receipts never evict evidence at the journal capacity limit", async () => {
  const f = await closureFixture();
  try {
    for (let i = 0; i < 256; i++)
      await f.runtime.closeAdoption({
        ...f.closure,
        adoption: { ...f.adoption, operationId: randomUUID() },
        expectedRevision: i,
      });
    assert.equal(f.runtime.status().closureAvailable, false);
    assert.equal(f.runtime.status().revision, 256);
    await assert.rejects(
      f.runtime.closeAdoption({
        ...f.closure,
        adoption: { ...f.adoption, operationId: randomUUID() },
        expectedRevision: 256,
      }),
      /full/,
    );
    assert.equal(f.runtime.status().revision, 256);
  } finally {
    await f.runtime.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
