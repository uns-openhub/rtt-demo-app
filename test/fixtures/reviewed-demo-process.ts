/** Loopback-only acceptance harness. Uses the real demo line and registered handlers; no MQTT transport. */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { ReviewedLifecycleRuntime } from "../../src/hrm/reviewed-lifecycle-runtime.js";
import { HrmProductionLine } from "../../src/hrm/hrm-production-line.js";
import type { HrmConfig } from "../../src/hrm/hrm-types.js";
import { serviceApis } from "../../src/api-routes.js";
const rawStateFile = process.env["G207_STATE_FILE"]!,
  stateFile = path.join(
    await fs.realpath(path.dirname(rawStateFile)),
    path.basename(rawStateFile),
  ),
  contractFile = process.env["G207_CONTRACT_FILE"]!,
  expected = process.env["G207_CONTRACT_DIGEST"]!,
  bearer = process.env["G207_TEST_BEARER"]!;
if (
  !path
    .resolve(stateFile)
    .startsWith(
      (await fs.realpath(process.env["G207_TEMP_ROOT"]!)) + path.sep,
    ) ||
  !bearer
)
  throw Error("Generated test state path required");
let fault: string | null = null,
  dropReply = false;
const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  if (String(to) === stateFile && fault === "beforeRename") {
    fault = null;
    process.send?.({ barrier: "beforeRename" });
    await new Promise(() => {});
  }
  await rename(from, to);
  if (String(to) === stateFile && fault === "throwAfterRename") {
    fault = null;
    throw Error("Fixture lost journal acknowledgement");
  }
  if (String(to) === stateFile && fault === "afterRename") {
    fault = null;
    process.send?.({ barrier: "afterRename" });
    await new Promise(() => {});
  }
};
try {
  const runtime = await ReviewedLifecycleRuntime.open({
    contractFile,
    contractDigest: expected,
    stateFile,
  });
  const config = (
    JSON.parse(
      await fs.readFile(
        new URL("../../config-development-host.json", import.meta.url),
        "utf8",
      ),
    ) as { hrm: HrmConfig }
  ).hrm;
  config.simulationSpeed = 100;
  for (const r of config.recipes) {
    r.furnace.targetTempC = 30;
    r.furnace.pusherPaceMin = 0.001;
    r.furnace.soakingTimeMin = 0.001;
    r.furnace.zones.forEach((z) => (z.setpointC = 30));
  }
  config.productionLine.descaling.durationMin = 0.001;
  const line = new HrmProductionLine(config, [], runtime);
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + bearer) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown = {};
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) {
        text += String(chunk);
        if (text.length > 8192) {
          res.writeHead(413);
          res.end();
          return;
        }
      }
      try {
        body = JSON.parse(text);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
    }
    const adapter = {
      status(code: number) {
        res.statusCode = code;
        return adapter;
      },
      json(value: unknown) {
        if (
          dropReply &&
          (url.pathname === "/action" ||
            url.pathname === "/adopt" ||
            url.pathname === "/close")
        ) {
          dropReply = false;
          res.destroy();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      },
    };
    if (req.method === "POST" && url.pathname === "/exercise") {
      line.submitBatch({
        recipeId: config.recipes[0]!.id,
        materialId: "g207-synthetic",
        quantity: 1,
      });
      let enteredRolling = false;
      for (let i = 0; i < 300; i++) {
        line.tick(i);
        enteredRolling ||= line.getState().stations.rolling.occupied;
      }
      adapter.json({
        enteredRolling,
        rollingPermitted: line.rollingPermitted,
        lifecycle: line.getState().reviewedLifecycle,
        descalingOccupied: line.getState().stations.descaling.occupied,
      });
      return;
    }
    const handler =
      req.method === "GET" && url.pathname === "/status"
        ? serviceApis.status.handler
        : req.method === "GET" && url.pathname === "/result"
          ? serviceApis.reviewedResult.handler
          : req.method === "POST" && url.pathname === "/action"
            ? serviceApis.reviewedAction.handler
            : req.method === "POST" && url.pathname === "/adopt"
              ? serviceApis.reviewedAdoption.handler
              : req.method === "POST" && url.pathname === "/close"
                ? serviceApis.reviewedClosure.handler
                : null;
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      await (handler as Function)(
        {
          req: { body, query: Object.fromEntries(url.searchParams) },
          res: adapter,
        },
        { line, processName: "g207-local-acceptance" },
      );
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No local server");
  process.on("message", async (message) => {
    const m = message as {
      fault?: string;
      dropReply?: boolean;
      stop?: boolean;
    };
    if (m.fault) {
      fault = m.fault;
      process.send?.({ armed: true });
    }
    if (m.dropReply) {
      dropReply = true;
      process.send?.({ armed: true });
    }
    if (m.stop) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.close();
      process.exit(0);
    }
  });
  process.send?.({ ready: true, port: address.port });
} catch {
  process.send?.({ failed: true });
  process.exitCode = 1;
}
