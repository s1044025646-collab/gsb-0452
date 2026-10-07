import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { TmService } from "./service.js";
import { openDb } from "./db.js";
import { TmError } from "./types.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TmError("BAD_REQUEST", "request body must be valid JSON");
  }
}

export function createApp(service: TmService) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? ((await readBody(req)) as Record<string, unknown>) : {};

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, { service: "tm-lab", endpoints: ["POST /machines", "GET /machines/:key", "POST /machines/:key/executions", "POST /executions/:id/run"] });
      }

      if (method === "POST" && parts[0] === "machines" && parts.length === 1) {
        return sendJson(res, 201, service.createMachine(body));
      }
      if (method === "PUT" && parts[0] === "machines" && parts.length === 2) {
        return sendJson(res, 200, service.updateMachine(parts[1], body));
      }
      if (method === "GET" && parts[0] === "machines" && parts.length === 2) {
        const v = url.searchParams.get("version");
        return sendJson(res, 200, service.getMachine(parts[1], v !== null ? Number(v) : undefined));
      }
      if (method === "GET" && parts[0] === "machines" && parts[2] === "transitions" && parts.length === 3) {
        const v = url.searchParams.get("version");
        return sendJson(res, 200, service.getTransitions(parts[1], v !== null ? Number(v) : undefined));
      }
      if (method === "POST" && parts[0] === "machines" && parts[2] === "executions" && parts.length === 3) {
        const b = body as { tape?: string; head?: number; state?: string; machineVersion?: number };
        return sendJson(res, 201, service.createExecution(parts[1], b));
      }
      if (method === "GET" && parts[0] === "executions" && parts.length === 2) {
        return sendJson(res, 200, service.getExecution(Number(parts[1])));
      }
      if (method === "GET" && parts[0] === "executions" && parts[2] === "tape" && parts.length === 3) {
        const start = url.searchParams.get("start");
        const width = url.searchParams.get("width");
        if (start === null || width === null) throw new TmError("BAD_REQUEST", "tape window requires ?start=<int>&width=<int>");
        return sendJson(res, 200, service.getTapeWindow(Number(parts[1]), Number(start), Number(width)));
      }
      if (method === "GET" && parts[0] === "executions" && parts[2] === "steps" && parts.length === 3) {
        return sendJson(res, 200, { steps: service.getSteps(Number(parts[1])) });
      }
      if (method === "POST" && parts[0] === "executions" && parts[2] === "run" && parts.length === 3) {
        const b = body as { budget?: number; expectedVersion?: number; requestId?: string };
        return sendJson(res, 200, service.run(Number(parts[1]), b.budget ?? 0, b.expectedVersion as number, b.requestId));
      }
      if (method === "POST" && parts[0] === "executions" && parts[2] === "step" && parts.length === 3) {
        const b = body as { expectedVersion?: number; requestId?: string };
        return sendJson(res, 200, service.step(Number(parts[1]), b.expectedVersion as number, b.requestId));
      }
      if (method === "POST" && parts[0] === "executions" && parts[2] === "replay" && parts.length === 3) {
        const b = body as { budget?: number };
        return sendJson(res, 200, service.replay(Number(parts[1]), b.budget));
      }

      throw new TmError("NOT_FOUND", `no route: ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof TmError) {
        const status =
          err.code === "NOT_FOUND" ? 404 :
          err.code === "VERSION_CONFLICT" ? 409 :
          err.code === "ALREADY_HALTED" ? 409 :
          err.code === "LIMIT_EXCEEDED" ? 413 : 400;
        return sendJson(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

if (require.main === module) {
  const dataDir = process.env.TM_DATA_DIR ?? "data";
  const portArg = process.env.PORT !== undefined ? Number(process.env.PORT) : 0;
  const service = new TmService(openDb(dataDir));
  const app = createApp(service);
  app.listen(portArg, () => {
    const addr = app.address();
    const port = typeof addr === "object" && addr ? addr.port : portArg;
    console.log(`tm-lab listening on http://127.0.0.1:${port} (data dir: ${dataDir})`);
  });
}
