import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
const wait = (child: ChildProcess, kind: string) =>
  new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", onMessage);
      reject(Error("Child did not reach " + kind));
    }, 10000);
    const onMessage = (message: any) => {
      if (message?.kind === kind) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        resolve(message);
      }
    };
    child.on("message", onMessage);
  });
async function start(file: string, hold = false) {
  const child = fork(
    new URL("./fixtures/durable-material-process.ts", import.meta.url),
    {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        J16_STATE_FILE: file,
        J16_HOLD_PUBLISH: hold ? "1" : "0",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr?.on("data", chunk => { errors = (errors + String(chunk)).slice(-8000); });
  child.on("exit", (code, signal) => { if (code && signal !== "SIGKILL") console.error(errors); });
  const { port } = await wait(child, "ready");
  return {
    child,
    base: `http://127.0.0.1:${port}/api/system/hrm/service/rtt-demo-app`,
  };
}
async function kill(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
  }
}
async function call(
  base: string,
  endpoint: string,
  body?: unknown,
  drop = false,
) {
  return fetch(base + "/" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "connection": "close",
      ...(drop ? { "x-j16-drop-response": "1" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
}
async function tick(child: ChildProcess, count: number) {
  const ready = wait(child, "ticked");
  child.send({ kind: "tick", count });
  await ready;
}

async function waitForDelivery(base: string) {
  for (let n=0;n<150;n++) {
    const state=await (await call(base,"status")).json();
    if(state.commandDurability.state === "ready") return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("Retained publications did not drain");
}

test("real child-process/API: lost load/split replies, SIGKILL, durable state and identical publisher replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j16-process-")),
    file = path.join(dir, "state.json");
  let p = await start(file, true);
  try {
    const load = {
      requestId: "process-load",
      recipeId: "recipe-1",
      materialId: "process-source",
      quantity: 2,
    };
    const publicationHeld = wait(p.child, "publication-held");
    await assert.rejects(call(p.base, "batch", load, true));
    await publicationHeld;
    await kill(p.child);
    const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
    const receipt = recorded.receipts.find(
      (r: any) => r.requestId === load.requestId,
    );
    assert.ok(receipt);
    const id = receipt.result.batchId;
    // Restore delivery before advancing production: a retained queue now pauses admission.
    p = await start(file);
    const replay = await (await call(p.base, "batch", load)).json();
    assert.deepEqual(replay, receipt.result);
    assert.equal(
      (await call(p.base, "batch", { ...load, quantity: 3 })).status,
      409,
    );
    await waitForDelivery(p.base);
    await tick(p.child, 80);
    const source = await (await call(p.base, "batch?batchId=" + id)).json();
    assert.ok(["DONE", "FAILED"].includes(source.stage));
    const split = {
      requestId: "process-split",
      sourceBatchId: id,
      outputMaterialIds: ["process-child-a", "process-child-b"],
    };
    await assert.rejects(call(p.base, "material-split", split, true));
    await kill(p.child);
    const disk = JSON.parse(fs.readFileSync(file, "utf8")),
      saved = disk.receipts.find((r: any) => r.requestId === split.requestId)
        .result.value;
    assert.equal(saved.outputs.length, 2);
    p = await start(file);
    const found = await (
      await call(p.base, "material-command-result?requestId=" + split.requestId)
    ).json();
    assert.deepEqual(found.result.result.value, saved);
    assert.deepEqual(
      await (await call(p.base, "material-split", split)).json(),
      saved,
    );
    await waitForDelivery(p.base);
    await tick(p.child, 15);
    const state = await (await call(p.base, "status")).json();
    assert.equal(state.completed.length, 3);
    assert.equal(
      (
        await call(p.base, "material-split", {
          ...split,
          outputMaterialIds: ["other", "process-child-b"],
        })
      ).status,
      409,
    );
    await kill(p.child);
    const publications = fs
      .readFileSync(file + ".published", "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      publications[0],
      publications[1],
      "unacknowledged first intent replays identically",
    );
    const manifests = publications.flatMap((p) =>
      (p.attributes ?? []).flatMap((a: any) => {
        try {
          const envelope = JSON.parse(a.data?.value);
          return envelope?.format === "uns.relationship-operation.v1"
            ? [envelope.manifest]
            : [];
        } catch {
          return [];
        }
      }),
    );
    assert.ok(manifests.length >= 2);
    assert.deepEqual(
      [...new Set(manifests.map((m) => m.operationId))],
      [saved.operationId],
    );
  } finally {
    await kill(p.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const point of ["before", "after"])
  test(
    "SIGKILL " +
      point +
      " journal rename does not publish uncommitted state or duplicate an accepted command",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j16-process-")),
        file = path.join(dir, "state.json");
      let p = await start(file);
      try {
        const armed = wait(p.child, "armed");
        p.child.send({ kind: "arm", point });
        await armed;
        const exit = once(p.child, "exit"),
          request = {
            requestId: "killed-" + point,
            recipeId: "recipe-1",
            materialId: "kill-" + point,
            quantity: 1,
          };
        await assert.rejects(call(p.base, "batch", request));
        await exit;
        assert.equal(fs.existsSync(file + ".published"), false);
        p = await start(file, true);
        const result = await (
          await call(
            p.base,
            "material-command-result?requestId=" + request.requestId,
          )
        ).json();
        assert.equal(!!result.result, point === "after");
        const responses = await Promise.all([
          call(p.base, "batch", request),
          call(p.base, "batch", request),
        ]);
        const [accepted, replayed] = await Promise.all(
          responses.map((response) => response.json()),
        );
        assert.deepEqual(replayed, accepted);
        assert.equal(accepted.status, "accepted");
        const state = await (await call(p.base, "status")).json();
        assert.equal(state.queue.length, 1);
      } finally {
        await kill(p.child);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
