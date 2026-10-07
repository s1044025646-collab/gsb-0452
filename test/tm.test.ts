import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../dist/db.js";
import {
  createMachine, createExecution, runExecution, getExecution,
  getTapeWindow, getSteps, replayExecution,
} from "../dist/engine.js";
import { unaryIncrement, leftForever } from "../dist/demo.js";
import { ApiError } from "../dist/types.js";
import type { MachineDefinition } from "../dist/types.js";

const mem = () => openDb(":memory:");

function baseMachine(patch: Partial<MachineDefinition> = {}): MachineDefinition {
  return {
    states: ["q", "accept", "reject"],
    startState: "q",
    acceptStates: ["accept"],
    rejectStates: ["reject"],
    symbols: ["1", "_"],
    blank: "_",
    transitions: [{ state: "q", read: "1", next: "accept", write: "1", move: "S" }],
    ...patch,
  };
}

test("unary increment: 111 -> 1111 in 4 steps, accepted", () => {
  const db = mem();
  const { machineId } = createMachine(db, unaryIncrement);
  const { executionId } = createExecution(db, machineId, "111", 0);
  const r = runExecution(db, executionId, 100);
  assert.equal(r.status, "accepted");
  assert.equal(r.stepsExecuted, 4);
  const tape = getTapeWindow(db, executionId, 0, 8);
  assert.deepEqual(tape.cells, [
    { coord: 0, symbol: "1" }, { coord: 1, symbol: "1" },
    { coord: 2, symbol: "1" }, { coord: 3, symbol: "1" },
  ]);
  const steps = getSteps(db, executionId);
  assert.equal(steps.length, 4);
  // read happens at the pre-move head; write then move
  assert.deepEqual(steps.map((s) => [s.head, s.read, s.rule.move]),
    [[0, "1", "R"], [1, "1", "R"], [2, "1", "R"], [3, "_", "S"]]);
  assert.equal(steps[3].rule.write, "1");
  assert.equal(steps[3].newState, "accept");
});

test("single-step and batch runs produce identical trajectories", () => {
  const db = mem();
  const { machineId } = createMachine(db, unaryIncrement);
  const a = createExecution(db, machineId, "111", 0);
  const b = createExecution(db, machineId, "111", 0);
  runExecution(db, a.executionId, 100);
  for (let i = 0; i < 4; i++) runExecution(db, b.executionId, 1);
  assert.deepEqual(getSteps(db, a.executionId), getSteps(db, b.executionId));
  assert.equal(getExecution(db, b.executionId).status, "accepted");
});

test("left-forever: budget 5 pauses at head -5; 5+3 equals 8", () => {
  const db = mem();
  const { machineId } = createMachine(db, leftForever);
  const e = createExecution(db, machineId, "", 0);
  const r1 = runExecution(db, e.executionId, 5);
  assert.equal(r1.status, "paused_by_budget");
  assert.equal(r1.head, -5);
  const r2 = runExecution(db, e.executionId, 3, r1.version);
  const e2 = createExecution(db, machineId, "", 0);
  const r3 = runExecution(db, e2.executionId, 8);
  assert.equal(r2.head, -8);
  assert.equal(r2.head, r3.head);
  assert.equal(r2.stepsExecuted, r3.stepsExecuted);
  assert.equal(r2.status, "paused_by_budget");
});

test("empty input is allowed", () => {
  const db = mem();
  const { machineId } = createMachine(db, unaryIncrement);
  const e = createExecution(db, machineId, "", 0);
  const r = runExecution(db, e.executionId, 10);
  assert.equal(r.status, "accepted");
  assert.equal(r.stepsExecuted, 1);
});

test("initial state already terminal", () => {
  const db = mem();
  const { machineId } = createMachine(db, baseMachine({ startState: "accept", transitions: [] }));
  const e = createExecution(db, machineId, "", 0);
  assert.equal(e.status, "accepted");
  const r = runExecution(db, e.executionId, 5);
  assert.equal(r.stepsThisRun, 0);
  assert.equal(r.status, "accepted");
});

test("S move keeps head in place", () => {
  const db = mem();
  const m = baseMachine({
    transitions: [{ state: "q", read: "1", next: "q", write: "1", move: "S" }],
  });
  const { machineId } = createMachine(db, m);
  const e = createExecution(db, machineId, "1", 5);
  const r = runExecution(db, e.executionId, 3);
  assert.equal(r.head, 5);
  assert.equal(r.stepsExecuted, 3);
});

test("writing blank deletes the sparse cell", () => {
  const db = mem();
  const m = baseMachine({
    transitions: [{ state: "q", read: "1", next: "accept", write: "_", move: "S" }],
  });
  const { machineId } = createMachine(db, m);
  const e = createExecution(db, machineId, "1", 0);
  runExecution(db, e.executionId, 1);
  const tape = getTapeWindow(db, e.executionId, -2, 10);
  assert.deepEqual(tape.cells, []);
});

test("missing rule stops with no_transition, not accept/reject", () => {
  const db = mem();
  const m = baseMachine({
    transitions: [{ state: "q", read: "1", next: "q", write: "1", move: "R" }],
  });
  const { machineId } = createMachine(db, m);
  const e = createExecution(db, machineId, "1", 0);
  const r = runExecution(db, e.executionId, 10);
  assert.equal(r.status, "no_transition");
  assert.equal(r.head, 1);
});

test("invalid machine definitions are rejected", () => {
  const db = mem();
  const bad: [string, MachineDefinition][] = [
    ["duplicate rule", baseMachine({ transitions: [
      { state: "q", read: "1", next: "q", write: "1", move: "L" },
      { state: "q", read: "1", next: "accept", write: "_", move: "R" },
    ] })],
    ["undeclared state", baseMachine({ transitions: [
      { state: "q", read: "1", next: "ghost", write: "1", move: "L" },
    ] })],
    ["undeclared symbol", baseMachine({ transitions: [
      { state: "q", read: "x", next: "q", write: "1", move: "L" },
    ] })],
    ["accept and reject overlap", baseMachine({ rejectStates: ["accept"] })],
    ["terminal state has outgoing edge", baseMachine({ transitions: [
      { state: "accept", read: "1", next: "q", write: "1", move: "L" },
    ] })],
    ["non-printable symbol", baseMachine({ symbols: ["1", "\t", "_"] })],
    ["blank not in symbols", baseMachine({ blank: " " })],
    ["undeclared start", baseMachine({ startState: "nope" })],
  ];
  for (const [name, def] of bad) {
    assert.throws(() => createMachine(db, def), (e: unknown) => {
      assert.ok(e instanceof ApiError && e.code === "VALIDATION_ERROR", name);
      return true;
    });
  }
});

test("zero budget executes nothing but reports terminal state", () => {
  const db = mem();
  const { machineId } = createMachine(db, unaryIncrement);
  const e = createExecution(db, machineId, "111", 0);
  const r = runExecution(db, e.executionId, 0);
  assert.equal(r.stepsThisRun, 0);
  assert.equal(r.status, "paused_by_budget");
  const db2 = mem();
  const m2 = createMachine(db2, baseMachine({ startState: "accept", transitions: [] }));
  const e2 = createExecution(db2, m2.machineId, "", 0);
  const r2 = runExecution(db2, e2.executionId, 0);
  assert.equal(r2.status, "accepted");
});

test("version conflict rejects the second writer", () => {
  const db = mem();
  const { machineId } = createMachine(db, leftForever);
  const e = createExecution(db, machineId, "", 0);
  const r1 = runExecution(db, e.executionId, 2, 0);
  assert.equal(r1.version, 1);
  assert.throws(() => runExecution(db, e.executionId, 2, 0),
    (e: unknown) => e instanceof ApiError && e.code === "VERSION_CONFLICT");
  const r2 = runExecution(db, e.executionId, 2, r1.version);
  assert.equal(r2.stepsExecuted, 4);
});

test("duplicate requestId does not re-execute", () => {
  const db = mem();
  const { machineId } = createMachine(db, leftForever);
  const e = createExecution(db, machineId, "", 0);
  const r1 = runExecution(db, e.executionId, 3, undefined, "req-1");
  const r2 = runExecution(db, e.executionId, 3, undefined, "req-1");
  assert.deepEqual(r2, r1);
  assert.equal(getExecution(db, e.executionId).stepsExecuted, 3);
});

test("resource limit rolls back the whole run and marks limited", () => {
  const db = mem();
  const { machineId } = createMachine(db, leftForever, { maxAbsCoord: 3 });
  const e = createExecution(db, machineId, "", 0);
  const r = runExecution(db, e.executionId, 10);
  assert.equal(r.status, "limited");
  assert.match(r.error ?? "", /maxAbsCoord/);
  const after = getExecution(db, e.executionId);
  assert.equal(after.stepsExecuted, 0);
  assert.equal(after.head, 0);
  assert.equal(after.status, "limited");
  assert.deepEqual(getSteps(db, e.executionId), []);
});

test("replay restarts from initial conditions on the locked machine", () => {
  const db = mem();
  const { machineId } = createMachine(db, unaryIncrement);
  const e = createExecution(db, machineId, "111", 0);
  runExecution(db, e.executionId, 100);
  const e2 = replayExecution(db, e.executionId);
  assert.equal(e2.stepsExecuted, 0);
  const r = runExecution(db, e2.executionId, 100);
  assert.equal(r.status, "accepted");
  assert.deepEqual(getSteps(db, e.executionId), getSteps(db, e2.executionId));
  // executions are isolated
  assert.equal(getExecution(db, e.executionId).stepsExecuted, 4);
});

test("tape window requires start and width and keeps logical coordinates", () => {
  const db = mem();
  const { machineId } = createMachine(db, leftForever);
  const e = createExecution(db, machineId, "", 0);
  runExecution(db, e.executionId, 5);
  const w = getTapeWindow(db, e.executionId, -10, 20);
  assert.equal(w.head, -5);
  assert.throws(() => getTapeWindow(db, e.executionId, NaN, 5),
    (err: unknown) => err instanceof ApiError && err.code === "VALIDATION_ERROR");
});


