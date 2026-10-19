/** Test-only loopback HTTP adapter over the real management catalog and publisher. */
import http from "node:http";
import fs from "node:fs";
import { initHrm } from "../../src/hrm/hrm-index.js";
import { serviceApis } from "../../src/api-routes.js";
import { registerManagementApiCatalog } from "../../src/management-api-catalog.js";
import { config } from "./material-runtime-config.js";
const file = process.env["J16_STATE_FILE"]!;
if (!file?.includes("/j16-process-"))
  throw Error("A disposable J16 process directory is required.");
const output = {
  flush: async () => undefined,
  publishMqttMessage: async (message: unknown) => {
    fs.appendFileSync(file + ".published", JSON.stringify(message) + "\n");
    if (process.env["J16_HOLD_PUBLISH"] === "1")
      await new Promise<void>(() => undefined);
  },
};
const line = await initHrm(
  {
    ...structuredClone(config),
    topicBase: "canary/j16-process/",
    tickIntervalMs: 60000,
    simulationSpeed: 2.5,
    commandStateFile: file,
  },
  output as never,
  "rtt-demo-app",
);
const listeners = new Map<string, (event: unknown) => Promise<void>>();
const proxy: any = {
  getProcessName: () => "rtt-demo-app",
  event: {
    on: (name: string, fn: (event: unknown) => Promise<void>) =>
      listeners.set(name, fn),
  },
};
for (const method of ["get", "post", "put", "patch", "delete"])
  proxy[method] = async () => undefined;
await registerManagementApiCatalog(proxy, {
  serviceApis,
  context: { line, processName: "rtt-demo-app" },
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 4096)
        throw Error("test request too large");
    }
    let status = 200,
      body: unknown;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };
    const handler = listeners.get(
      req.method === "POST" ? "apiPostEvent" : "apiGetEvent",
    )!;
    await handler({
      req: {
        path: url.pathname.replace(/^\/api/, ""),
        query: Object.fromEntries(url.searchParams),
        body: chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined,
      },
      res: response,
    });
    if (req.headers["x-j16-drop-response"] === "1") {
      res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Test adapter failure" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  process.send?.({
    kind: "ready",
    port: (server.address() as { port: number }).port,
  });
});
process.on("message", (m: any) => {
  if (m?.kind === "tick") {
    try {
      for (let i = 0; i < m.count; i++) line.tick(i);
      process.send?.({ kind: "ticked" });
    } catch {
      process.send?.({ kind: "tick-failed" });
    }
  } else if (m?.kind === "arm") {
    const rename = fs.renameSync;
    fs.renameSync = ((...args: Parameters<typeof rename>) => {
      if (m.point === "after") rename(...args);
      process.kill(process.pid, "SIGKILL");
    }) as typeof rename;
    process.send?.({ kind: "armed" });
  }
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
