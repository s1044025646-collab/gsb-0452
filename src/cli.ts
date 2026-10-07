import * as fs from "node:fs";
import { openDb } from "./db.js";
import {
  createMachine, listMachines, exportMachine, createExecution, getExecution,
  runExecution, getTapeWindow, getSteps, replayExecution,
} from "./engine.js";
import { unaryIncrement, leftForever } from "./demo.js";

const dbPath = process.env.TM_DB ?? "data/tm.db";
const db = openDb(dbPath);
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

const [, , cmd, ...args] = process.argv;

function readJsonArg(a: string): unknown {
  if (a.startsWith("@")) return JSON.parse(fs.readFileSync(a.slice(1), "utf8"));
  return JSON.parse(a);
}

try {
  switch (cmd) {
    case "machine:create": {
      const def = readJsonArg(args[0]);
      out(createMachine(db, def));
      break;
    }
    case "machine:list": out(listMachines(db)); break;
    case "machine:export": out(exportMachine(db, Number(args[0]))); break;
    case "exec:create": out(createExecution(db, Number(args[0]), args[1] ?? "", Number(args[2] ?? 0))); break;
    case "exec:status": out(getExecution(db, Number(args[0]))); break;
    case "exec:step": {
      const r = runExecution(db, Number(args[0]), 1,
        args[1] !== undefined ? Number(args[1]) : undefined, args[2]);
      out(r); break;
    }
    case "exec:run": {
      const r = runExecution(db, Number(args[0]), Number(args[1]),
        args[2] !== undefined ? Number(args[2]) : undefined, args[3]);
      out(r); break;
    }
    case "exec:tape": out(getTapeWindow(db, Number(args[0]), Number(args[1]), Number(args[2]))); break;
    case "exec:steps": out(getSteps(db, Number(args[0]))); break;
    case "exec:replay": out(replayExecution(db, Number(args[0]))); break;
    case "demo": {
      console.log("== demo 1: unary increment, input 111 ==");
      const m1 = createMachine(db, unaryIncrement);
      const e1 = createExecution(db, m1.machineId, "111", 0);
      const r1 = runExecution(db, e1.executionId, 100);
      out(r1);
      out(getTapeWindow(db, e1.executionId, 0, 8));
      out(getSteps(db, e1.executionId));

      console.log("== demo 2: left-forever, budget 5 then 3 ==");
      const m2 = createMachine(db, leftForever);
      const e2 = createExecution(db, m2.machineId, "", 0);
      const r2 = runExecution(db, e2.executionId, 5);
      out(r2);
      const r3 = runExecution(db, e2.executionId, 3, r2.version);
      out(r3);
      const e3 = createExecution(db, m2.machineId, "", 0);
      const r4 = runExecution(db, e3.executionId, 8);
      console.log(`5+3 head=${r3.head}, single-8 head=${r4.head}, equal=${r3.head === r4.head && r3.stepsExecuted === r4.stepsExecuted}`);
      break;
    }
    default:
      console.log(`Usage: node dist/cli.js <command> [args]
  machine:create '<json>'|@file   validate and save a machine (new version)
  machine:list                    list machines
  machine:export <machineId>      export transition detail
  exec:create <machineId> [tape] [head]
  exec:status <execId>
  exec:step <execId> [expectedVersion] [requestId]
  exec:run <execId> <budget> [expectedVersion] [requestId]
  exec:tape <execId> <start> <width>
  exec:steps <execId>
  exec:replay <execId>
  demo                            run built-in demos`);
  }
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(JSON.stringify({ error: err.code ?? "ERROR", message: err.message ?? String(e) }));
  process.exitCode = 1;
}
