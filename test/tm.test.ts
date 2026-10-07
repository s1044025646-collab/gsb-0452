import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmService } from "../src/service.js";
import { openDb } from "../src/db.js";
import { TmError } from "../src/types.js";

function svc(): TmService {
  return new TmService(openDb(mkdtempSync(join(tmpdir(), "tm-test-"))));
}

const unaryInc = JSON.parse(readFileSync(join(__dirname, "../../examples/unary-increment.json"), "utf8"));
const leftMover = JSON.parse(readFileSync(join(__dirname, "../../examples/left-mover.json"), "utf8"));

function expectCode(code: string, fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof TmError, `expected TmError, got ${e}`);
    assert.equal((e as TmError).code, code);
    return;
  }
  assert.fail(`expected error ${code}`);
}

test("unary increment: 111 -> 1111 in 4 steps, halted_accept", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "111", head: 0 });
  const r = s.run(e.id, 100, e.version);
  assert.equal(r.status, "halted_accept");
  assert.equal(r.totalSteps, 4);
  const w = s.getTapeWindow(e.id, 0, 8);
  assert.deepEqual(w.cells, [
    { pos: 0, char: "1" }, { pos: 1, char: "1" }, { pos: 2, char: "1" }, { pos: 3, char: "1" },
  ]);
  assert.equal(w.head, 3);
});

test("hand-checked step order: read before move, write before move", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "1", head: 0 });
  const r1 = s.step(e.id, e.version);
  assert.deepEqual(
    r1.steps.map((x: any) => [x.oldState, x.head, x.read, x.rule.write, x.rule.move, x.newState, x.newHead]),
    [["q", 0, "1", "1", "R", "q", 1]]
  );
  const r2 = s.step(e.id, r1.version);
  assert.deepEqual(
    r2.steps.map((x: any) => [x.oldState, x.head, x.read, x.rule.write, x.rule.move, x.newState, x.newHead]),
    [["q", 1, "_", "1", "S", "accept", 1]]
  );
  assert.equal(r2.status, "halted_accept");
});

test("single-step and batch runs produce identical trajectories", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e1 = s.createExecution(m.machineKey, { tape: "111", head: 0 });
  let v = e1.version;
  const traceA: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    const r = s.step(e1.id, v);
    v = r.version;
    traceA.push(...r.steps);
  }
  const e2 = s.createExecution(m.machineKey, { tape: "111", head: 0 });
  const rb = s.run(e2.id, 100, e2.version);
  assert.deepEqual(traceA, rb.steps);
});

test("left mover: budget 5 -> head -5 paused_by_budget; resume 3 equals single 8", () => {
  const s = svc();
  const m = s.createMachine(leftMover);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r5 = s.run(e.id, 5, e.version);
  assert.equal(r5.status, "paused_by_budget");
  assert.equal(r5.head, -5);
  const r8a = s.run(e.id, 3, r5.version);
  assert.equal(r8a.head, -8);
  assert.equal(r8a.totalSteps, 8);
  const e2 = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r8b = s.run(e2.id, 8, e2.version);
  assert.equal(r8b.head, r8a.head);
  assert.equal(r8b.status, r8a.status);
});

test("empty input tape is all blank", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r = s.run(e.id, 10, e.version);
  assert.equal(r.status, "halted_accept");
  assert.equal(r.totalSteps, 1);
  const w = s.getTapeWindow(e.id, 0, 4);
  assert.deepEqual(w.cells, [{ pos: 0, char: "1" }]);
});

test("initial terminal state: zero-budget run reports halted without executing", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0, state: "accept" });
  assert.equal(e.status, "halted_accept");
  expectCode("ALREADY_HALTED", () => s.run(e.id, 0, e.version));
});

test("zero budget on running machine executes nothing and reports paused", () => {
  const s = svc();
  const m = s.createMachine(leftMover);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r = s.run(e.id, 0, e.version);
  assert.equal(r.executedSteps, 0);
  assert.equal(r.status, "paused_by_budget");
  assert.equal(r.head, 0);
});

test("S move keeps head in place", () => {
  const s = svc();
  const def = {
    name: "stay", states: ["q", "acc"], startState: "q", acceptStates: ["acc"], rejectStates: [],
    symbols: ["a", "_"], blank: "_",
    transitions: [{ state: "q", read: "_", next: "acc", write: "a", move: "S" }],
  };
  const m = s.createMachine(def);
  const e = s.createExecution(m.machineKey, { tape: "", head: 5 });
  const r = s.run(e.id, 10, e.version);
  assert.equal(r.head, 5);
  assert.equal(r.status, "halted_accept");
});

test("writing blank deletes sparse cell", () => {
  const s = svc();
  const def = {
    name: "erase", states: ["q", "acc"], startState: "q", acceptStates: ["acc"], rejectStates: [],
    symbols: ["1", "_"], blank: "_",
    transitions: [{ state: "q", read: "1", next: "acc", write: "_", move: "S" }],
  };
  const m = s.createMachine(def);
  const e = s.createExecution(m.machineKey, { tape: "1", head: 0 });
  s.run(e.id, 10, e.version);
  const w = s.getTapeWindow(e.id, -5, 20);
  assert.deepEqual(w.cells, []);
});

test("missing rule stops with no_transition, not accept/reject", () => {
  const s = svc();
  const def = {
    name: "gap", states: ["q", "acc"], startState: "q", acceptStates: ["acc"], rejectStates: [],
    symbols: ["1", "_"], blank: "_",
    transitions: [{ state: "q", read: "1", next: "q", write: "1", move: "R" }],
  };
  const m = s.createMachine(def);
  const e = s.createExecution(m.machineKey, { tape: "11", head: 0 });
  const r = s.run(e.id, 100, e.version);
  assert.equal(r.status, "no_transition");
  assert.equal(r.head, 2);
  assert.equal(r.state, "q");
});

test("invalid machine definitions are rejected", () => {
  const s = svc();
  const base = {
    name: "x", states: ["q", "a", "r"], startState: "q", acceptStates: ["a"], rejectStates: ["r"],
    symbols: ["1", "_"], blank: "_",
    transitions: [{ state: "q", read: "1", next: "q", write: "1", move: "R" }],
  };
  expectCode("DUPLICATE_RULE", () => s.createMachine({ ...base, transitions: [...base.transitions, base.transitions[0]] }));
  expectCode("UNDECLARED_STATE", () => s.createMachine({ ...base, transitions: [{ state: "zz", read: "1", next: "q", write: "1", move: "R" }] }));
  expectCode("UNDECLARED_SYMBOL", () => s.createMachine({ ...base, transitions: [{ state: "q", read: "9", next: "q", write: "1", move: "R" }] }));
  expectCode("TERMINAL_HAS_OUTGOING", () => s.createMachine({ ...base, transitions: [{ state: "a", read: "1", next: "q", write: "1", move: "R" }] }));
  expectCode("ACCEPT_REJECT_OVERLAP", () => s.createMachine({ ...base, rejectStates: ["a"] }));
  expectCode("INVALID_SYMBOL", () => s.createMachine({ ...base, symbols: ["ab", "_"] }));
  expectCode("INVALID_DIRECTION", () => s.createMachine({ ...base, transitions: [{ state: "q", read: "1", next: "q", write: "1", move: "X" }] }));
  expectCode("MACHINE_INVALID", () => s.createMachine({ ...base, blank: "?" }));
  expectCode("UNDECLARED_STATE", () => s.createMachine({ ...base, startState: "nope" }));
});

test("version conflict: second concurrent run is rejected", () => {
  const s = svc();
  const m = s.createMachine(leftMover);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r1 = s.run(e.id, 2, e.version);
  assert.equal(r1.head, -2);
  expectCode("VERSION_CONFLICT", () => s.run(e.id, 2, e.version));
  const r2 = s.run(e.id, 2, r1.version);
  assert.equal(r2.head, -4);
});

test("idempotent requestId does not double-execute", () => {
  const s = svc();
  const m = s.createMachine(leftMover);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r1 = s.run(e.id, 3, e.version, "req-1");
  const r2 = s.run(e.id, 3, e.version, "req-1");
  assert.equal(r2.idempotentReplay, true);
  assert.equal(r2.totalSteps, 3);
  assert.equal(s.getExecution(e.id).steps, 3);
});

test("replay from initial conditions matches current configuration", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "111", head: 0 });
  s.run(e.id, 100, e.version);
  const rep = s.replay(e.id);
  assert.equal(rep.matchesCurrent, true);
  assert.equal(rep.totalSteps, 4);
});

test("tape window requires start and width and keeps logical coordinates", () => {
  const s = svc();
  const m = s.createMachine(leftMover);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  s.run(e.id, 5, e.version);
  const w = s.getTapeWindow(e.id, -10, 20);
  assert.equal(w.head, -5);
  expectCode("BAD_REQUEST", () => s.getTapeWindow(e.id, 0, Number.NaN));
});

test("machine update creates new version; old executions keep locked table", () => {
  const s = svc();
  const m = s.createMachine(unaryInc);
  const e = s.createExecution(m.machineKey, { tape: "1", head: 0 });
  const m2 = s.updateMachine(m.machineKey, leftMover);
  assert.equal(m2.version, 2);
  const r = s.run(e.id, 10, e.version);
  assert.equal(r.status, "halted_accept");
  const latest = s.getMachine(m.machineKey);
  assert.equal(latest.version, 2);
  const v1 = s.getMachine(m.machineKey, 1);
  assert.equal(v1.definition.name, "unary-increment");
});

test("resource limit: non-blank cap yields limited status without partial transition", () => {
  const s = new TmService(openDb(mkdtempSync(join(tmpdir(), "tm-test-"))), { maxNonBlank: 3 });
  const def = {
    name: "fill", states: ["q"], startState: "q", acceptStates: [], rejectStates: [],
    symbols: ["1", "_"], blank: "_",
    transitions: [{ state: "q", read: "_", next: "q", write: "1", move: "R" }],
  };
  const m = s.createMachine(def);
  const e = s.createExecution(m.machineKey, { tape: "", head: 0 });
  const r = s.run(e.id, 100, e.version);
  assert.equal(r.status, "limited");
  assert.equal(r.totalSteps, 3);
  assert.equal(s.getTapeWindow(e.id, 0, 100).cells.length, 3);
});

test("restart recovery: reopening db preserves committed state", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-test-"));
  const s1 = new TmService(openDb(dir));
  const m = s1.createMachine(leftMover);
  const e = s1.createExecution(m.machineKey, { tape: "", head: 0 });
  s1.run(e.id, 4, e.version);
  const s2 = new TmService(openDb(dir));
  const ex = s2.getExecution(e.id);
  assert.equal(ex.head, -4);
  assert.equal(ex.steps, 4);
  const r = s2.run(e.id, 2, ex.version);
  assert.equal(r.head, -6);
});
