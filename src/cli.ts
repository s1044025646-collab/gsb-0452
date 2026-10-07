import { readFileSync } from "node:fs";
import { TmService } from "./service.js";
import { openDb } from "./db.js";
import { validateMachine } from "./machine.js";
import { DEFAULT_LIMITS, TmError } from "./types.js";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function loadMachineFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const UNARY_INC = {
  name: "unary-increment",
  states: ["q", "accept", "reject"],
  startState: "q",
  acceptStates: ["accept"],
  rejectStates: ["reject"],
  symbols: ["1", "_"],
  blank: "_",
  transitions: [
    { state: "q", read: "1", next: "q", write: "1", move: "R" },
    { state: "q", read: "_", next: "accept", write: "1", move: "S" },
  ],
};

const LEFT_MOVER = {
  name: "left-mover",
  states: ["q", "accept"],
  startState: "q",
  acceptStates: ["accept"],
  rejectStates: [],
  symbols: ["1", "_"],
  blank: "_",
  transitions: [{ state: "q", read: "_", next: "q", write: "_", move: "L" }],
};

function demo(service: TmService) {
  console.log("=== Demo 1: unary increment, input 111 ===");
  const m1 = service.createMachine(UNARY_INC);
  const e1 = service.createExecution(m1.machineKey, { tape: "111", head: 0 });
  const r1 = service.run(e1.id, 100, e1.version);
  console.log(`status=${r1.status} steps=${r1.totalSteps} head=${r1.head} state=${r1.state}`);
  const w1 = service.getTapeWindow(e1.id, 0, 8);
  console.log("tape window [0,8):", w1.cells.map((c) => `${c.pos}:${c.char}`).join(" "));

  console.log("\n=== Demo 2: left mover, budget 5 then resume 3 ===");
  const m2 = service.createMachine(LEFT_MOVER);
  const e2 = service.createExecution(m2.machineKey, { tape: "", head: 0 });
  const r2 = service.run(e2.id, 5, e2.version);
  console.log(`after 5: status=${r2.status} head=${r2.head} state=${r2.state}`);
  const r3 = service.run(e2.id, 3, r2.version);
  console.log(`after +3: status=${r3.status} head=${r3.head} totalSteps=${r3.totalSteps}`);

  const e2b = service.createExecution(m2.machineKey, { tape: "", head: 0 });
  const r8 = service.run(e2b.id, 8, e2b.version);
  console.log(`single run of 8: head=${r8.head} totalSteps=${r8.totalSteps} (matches: ${r8.head === r3.head})`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dataDir = argValue(args, "data") ?? process.env.TM_DATA_DIR ?? "data";

  try {
    if (cmd === "validate") {
      const file = args[1];
      if (!file) throw new TmError("BAD_REQUEST", "usage: cli validate <machine.json>");
      const def = validateMachine(loadMachineFile(file), DEFAULT_LIMITS);
      console.log(`OK: machine "${def.name}" valid (${def.transitions.length} transitions)`);
      return;
    }
    if (cmd === "demo") {
      demo(new TmService(openDb(dataDir)));
      return;
    }
    if (cmd === "run") {
      const file = args[1];
      if (!file) throw new TmError("BAD_REQUEST", "usage: cli run <machine.json> --tape 111 --head 0 --budget 100");
      const service = new TmService(openDb(dataDir));
      const m = service.createMachine(loadMachineFile(file));
      const e = service.createExecution(m.machineKey, {
        tape: argValue(args, "tape") ?? "",
        head: argValue(args, "head") !== undefined ? Number(argValue(args, "head")) : 0,
      });
      const r = service.run(e.id, Number(argValue(args, "budget") ?? "100"), e.version);
      print({
        executionId: e.id,
        status: r.status,
        totalSteps: r.totalSteps,
        head: r.head,
        state: r.state,
        tape: service.getTapeWindow(e.id, r.head - 10, 21).cells,
      });
      return;
    }
    if (cmd === "status") {
      const service = new TmService(openDb(dataDir));
      print(service.getExecution(Number(args[1])));
      return;
    }
    console.log("commands: validate <file> | run <file> [--tape X --head N --budget N] | demo | status <execId>");
    console.log("server: npm start (env PORT, TM_DATA_DIR)");
  } catch (err) {
    if (err instanceof TmError) {
      console.error(`error ${err.code}: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

main();
