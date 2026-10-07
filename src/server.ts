import * as http from "node:http";
import { openDb } from "./db.js";
import {
  createMachine, listMachines, exportMachine, createExecution, getExecution,
  runExecution, getTapeWindow, getSteps, replayExecution,
} from "./engine.js";
import { ApiError } from "./types.js";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError("VALIDATION_ERROR", "request body must be valid JSON")); }
    });
    req.on("error", reject);
  });
}

export function createServer(dbPath: string) {
  const db = openDb(dbPath);

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};

      if (method === "GET" && url.pathname === "/health") return send(200, { ok: true });

      if (method === "POST" && url.pathname === "/machines")
        return send(201, createMachine(db, body.definition, body.limits as never));
      if (method === "GET" && url.pathname === "/machines") return send(200, listMachines(db));
      if (method === "GET" && parts[0] === "machines" && parts.length === 2)
        return send(200, exportMachine(db, Number(parts[1])));

      if (method === "POST" && url.pathname === "/executions")
        return send(201, createExecution(db, Number(body.machineId), String(body.tape ?? ""), Number(body.head ?? 0)));
      if (method === "GET" && parts[0] === "executions" && parts.length === 2)
        return send(200, getExecution(db, Number(parts[1])));
      if (method === "POST" && parts[0] === "executions" && parts[2] === "run")
        return send(200, runExecution(db, Number(parts[1]), Number(body.budget ?? 1),
          body.expectedVersion as number | undefined, body.requestId as string | undefined));
      if (method === "POST" && parts[0] === "executions" && parts[2] === "step")
        return send(200, runExecution(db, Number(parts[1]), 1,
          body.expectedVersion as number | undefined, body.requestId as string | undefined));
      if (method === "POST" && parts[0] === "executions" && parts[2] === "replay")
        return send(201, replayExecution(db, Number(parts[1])));
      if (method === "GET" && parts[0] === "executions" && parts[2] === "tape")
        return send(200, getTapeWindow(db, Number(parts[1]), Number(url.searchParams.get("start")),
          Number(url.searchParams.get("width"))));
      if (method === "GET" && parts[0] === "executions" && parts[2] === "steps")
        return send(200, getSteps(db, Number(parts[1]),
          Number(url.searchParams.get("from") ?? 1), Number(url.searchParams.get("limit") ?? 1000)));

      throw new ApiError("NOT_FOUND", `no route for ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.code, message: e.message });
      send(500, { error: "INTERNAL", message: String(e) });
    }
  };

  return http.createServer((req, res) => { void handler(req, res); });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dbPath = process.env.TM_DB ?? "data/tm.db";
  const server = createServer(dbPath);
  const portArg = process.env.PORT ? Number(process.env.PORT) : 0;
  server.listen(portArg, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : portArg;
    console.log(`TM server listening on http://127.0.0.1:${port} (db: ${dbPath})`);
  });
}
