import { DatabaseSync } from "node:sqlite";
import { validateMachine, lookupTransition, CompiledMachine } from "./machine.js";
import { ApiError, DEFAULT_LIMITS, ExecStatus, Limits, MachineDefinition } from "./types.js";

class LimitError extends Error {
  constructor(message: string) { super(message); }
}

export interface RunResult {
  executionId: number;
  status: ExecStatus;
  state: string;
  head: number;
  stepsExecuted: number;
  stepsThisRun: number;
  version: number;
  stopReason: string;
  error?: string;
}

interface ExecRow {
  id: number; machine_id: number; initial_tape: string; initial_head: number;
  state: string; head: number; status: ExecStatus; steps_executed: number; version: number;
}

function getExecRow(db: DatabaseSync, id: number): ExecRow {
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecRow | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `execution ${id} not found`, 404);
  return row;
}

function loadMachine(db: DatabaseSync, machineId: number): { compiled: CompiledMachine; limits: Limits } {
  const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as
    | { id: number; definition: string; limits: string } | undefined;
  if (!row) throw new ApiError("NOT_FOUND", `machine ${machineId} not found`, 404);
  const limits = { ...DEFAULT_LIMITS, ...(JSON.parse(row.limits) as Partial<Limits>) };
  const compiled = validateMachine(JSON.parse(row.definition), limits);
  return { compiled, limits };
}

export function createMachine(db: DatabaseSync, rawDef: unknown, rawLimits?: Partial<Limits>) {
  const limits = { ...DEFAULT_LIMITS, ...(rawLimits ?? {}) };
  const compiled = validateMachine(rawDef, limits);
  const info = db
    .prepare("INSERT INTO machines (name, definition, limits) VALUES (?, ?, ?)")
    .run(compiled.definition.name ?? null, JSON.stringify(compiled.definition), JSON.stringify(limits));
  return { machineId: Number(info.lastInsertRowid), limits };
}

export function listMachines(db: DatabaseSync) {
  return db.prepare("SELECT id, name, created_at FROM machines ORDER BY id").all();
}

export function exportMachine(db: DatabaseSync, machineId: number) {
  const { compiled } = loadMachine(db, machineId);
  return {
    machineId,
    name: compiled.definition.name ?? null,
    states: compiled.definition.states,
    startState: compiled.definition.startState,
    acceptStates: compiled.definition.acceptStates,
    rejectStates: compiled.definition.rejectStates,
    symbols: compiled.definition.symbols,
    blank: compiled.definition.blank,
    transitions: compiled.definition.transitions,
  };
}

const TERMINAL_STATUSES: ExecStatus[] = ["accepted", "rejected", "no_transition", "limited"];

export function createExecution(db: DatabaseSync, machineId: number, tape: string, head: number): RunResult {
  const { compiled, limits } = loadMachine(db, machineId);
  if (typeof tape !== "string") throw new ApiError("VALIDATION_ERROR", "tape must be a string");
  if (!Number.isInteger(head)) throw new ApiError("VALIDATION_ERROR", "head must be an integer");
  if (tape.length > limits.maxCells) throw new ApiError("LIMIT_EXCEEDED", `initial tape length exceeds maxCells ${limits.maxCells}`);
  if (Math.abs(head) > limits.maxAbsCoord || Math.abs(head + tape.length) > limits.maxAbsCoord)
    throw new ApiError("LIMIT_EXCEEDED", `initial head/tape exceeds maxAbsCoord ${limits.maxAbsCoord}`);
  for (const ch of tape)
    if (!compiled.definition.symbols.includes(ch) || ch === compiled.definition.blank)
      throw new ApiError("VALIDATION_ERROR", `tape char '${ch}' must be a declared non-blank symbol`);

  const status: ExecStatus = compiled.terminalStates.has(compiled.definition.startState)
    ? (compiled.definition.acceptStates.includes(compiled.definition.startState) ? "accepted" : "rejected")
    : "running";

  db.exec("BEGIN IMMEDIATE");
  try {
    const info = db
      .prepare("INSERT INTO executions (machine_id, initial_tape, initial_head, state, head, status) VALUES (?,?,?,?,?,?)")
      .run(machineId, tape, head, compiled.definition.startState, head, status);
    const execId = Number(info.lastInsertRowid);
    const ins = db.prepare("INSERT INTO tape_cells (execution_id, coord, symbol) VALUES (?,?,?)");
    for (let i = 0; i < tape.length; i++) ins.run(execId, head + i, tape[i]);
    db.exec("COMMIT");
    return {
      executionId: execId, status, state: compiled.definition.startState, head,
      stepsExecuted: 0, stepsThisRun: 0, version: 0,
      stopReason: status === "running" ? "created" : "initial_state_terminal",
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getExecution(db: DatabaseSync, id: number) {
  const row = getExecRow(db, id);
  return {
    executionId: row.id, machineId: row.machine_id, status: row.status, state: row.state,
    head: row.head, stepsExecuted: row.steps_executed, version: row.version,
    initialTape: row.initial_tape, initialHead: row.initial_head,
  };
}

export function runExecution(
  db: DatabaseSync,
  execId: number,
  budget: number,
  expectedVersion?: number,
  requestId?: string,
): RunResult {
  if (!Number.isInteger(budget) || budget < 0) throw new ApiError("VALIDATION_ERROR", "budget must be a non-negative integer");

  if (requestId) {
    const prev = db.prepare("SELECT response FROM run_requests WHERE request_id = ?").get(requestId) as
      | { response: string } | undefined;
    if (prev) return JSON.parse(prev.response) as RunResult;
  }

  db.exec("BEGIN IMMEDIATE");
  let result: RunResult;
  try {
    const row = getExecRow(db, execId);
    const { compiled, limits } = loadMachine(db, row.machine_id);
    if (budget > limits.maxStepsPerRun)
      throw new ApiError("LIMIT_EXCEEDED", `budget exceeds maxStepsPerRun ${limits.maxStepsPerRun}`);
    if (expectedVersion !== undefined && expectedVersion !== row.version)
      throw new ApiError("VERSION_CONFLICT", `expected version ${expectedVersion}, current ${row.version}`, 409);

    let state = row.state;
    let head = row.head;
    let steps = row.steps_executed;
    let status: ExecStatus = row.status;
    let stopReason = "budget_exhausted";
    let stepsThisRun = 0;

    if (TERMINAL_STATUSES.includes(status)) {
      stopReason = status === "limited" ? "limited" : `already_${status}`;
    } else {
      const getCell = db.prepare("SELECT symbol FROM tape_cells WHERE execution_id = ? AND coord = ?");
      const delCell = db.prepare("DELETE FROM tape_cells WHERE execution_id = ? AND coord = ?");
      const setCell = db.prepare("INSERT OR REPLACE INTO tape_cells (execution_id, coord, symbol) VALUES (?,?,?)");
      const insStep = db.prepare(
        "INSERT INTO steps (execution_id, step_no, old_state, head, read_symbol, rule, new_state) VALUES (?,?,?,?,?,?,?)");
      const countCells = db.prepare("SELECT COUNT(*) AS n FROM tape_cells WHERE execution_id = ?");

      while (stepsThisRun < budget) {
        const readRow = getCell.get(execId, head) as { symbol: string } | undefined;
        const read = readRow ? readRow.symbol : compiled.definition.blank;
        const rule = lookupTransition(compiled, state, read);
        if (!rule) { status = "no_transition"; stopReason = "no_transition"; break; }

        if (steps + 1 > limits.maxTotalSteps) throw new LimitError(`maxTotalSteps ${limits.maxTotalSteps} exceeded`);
        const newHead = rule.move === "L" ? head - 1 : rule.move === "R" ? head + 1 : head;
        if (Math.abs(newHead) > limits.maxAbsCoord) throw new LimitError(`maxAbsCoord ${limits.maxAbsCoord} exceeded`);
        if (rule.write !== compiled.definition.blank) {
          if (!readRow) {
            const n = (countCells.get(execId) as { n: number }).n;
            if (n + 1 > limits.maxCells) throw new LimitError(`maxCells ${limits.maxCells} exceeded`);
          }
          setCell.run(execId, head, rule.write);
        } else {
          delCell.run(execId, head);
        }
        steps += 1;
        stepsThisRun += 1;
        insStep.run(execId, steps, state, head, read, JSON.stringify(rule), rule.next);
        state = rule.next;
        head = newHead;

        if (compiled.terminalStates.has(state)) {
          status = compiled.definition.acceptStates.includes(state) ? "accepted" : "rejected";
          stopReason = status;
          break;
        }
      }
      if (status === "running" && stepsThisRun >= budget) stopReason = "budget_exhausted";
      if (status === "running") status = "paused_by_budget";
    }

    const newVersion = row.version + 1;
    db.prepare("UPDATE executions SET state=?, head=?, status=?, steps_executed=?, version=? WHERE id=?")
      .run(state, head, status, steps, newVersion, execId);
    result = {
      executionId: execId, status, state, head, stepsExecuted: steps,
      stepsThisRun, version: newVersion, stopReason,
    };
    if (requestId)
      db.prepare("INSERT INTO run_requests (request_id, execution_id, response) VALUES (?,?,?)")
        .run(requestId, execId, JSON.stringify(result));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    if (e instanceof LimitError) {
      db.prepare("UPDATE executions SET status='limited' WHERE id=?").run(execId);
      const row = getExecRow(db, execId);
      return {
        executionId: execId, status: "limited", state: row.state, head: row.head,
        stepsExecuted: row.steps_executed, stepsThisRun: 0, version: row.version,
        stopReason: "limited", error: e.message,
      };
    }
    throw e;
  }
  return result;
}

export function getTapeWindow(db: DatabaseSync, execId: number, start: number, width: number) {
  getExecRow(db, execId);
  if (!Number.isInteger(start) || !Number.isInteger(width) || width < 1 || width > 10000)
    throw new ApiError("VALIDATION_ERROR", "start must be an integer and width an integer in [1, 10000]");
  const rows = db
    .prepare("SELECT coord, symbol FROM tape_cells WHERE execution_id = ? AND coord >= ? AND coord < ? ORDER BY coord")
    .all(execId, start, start + width) as { coord: number; symbol: string }[];
  const exec = getExecution(db, execId);
  const cells = rows.map((r) => ({ coord: r.coord, symbol: r.symbol }));
  return { executionId: execId, start, width, head: exec.head, state: exec.state, status: exec.status, cells };
}

export function getSteps(db: DatabaseSync, execId: number, from = 1, limit = 1000) {
  getExecRow(db, execId);
  const rows = db
    .prepare("SELECT * FROM steps WHERE execution_id = ? AND step_no >= ? ORDER BY step_no LIMIT ?")
    .all(execId, from, limit) as { step_no: number; old_state: string; head: number; read_symbol: string; rule: string; new_state: string }[];
  return rows.map((r) => ({
    stepNo: r.step_no, oldState: r.old_state, head: r.head, read: r.read_symbol,
    rule: JSON.parse(r.rule), newState: r.new_state,
  }));
}

export function replayExecution(db: DatabaseSync, execId: number): RunResult {
  const row = getExecRow(db, execId);
  return createExecution(db, row.machine_id, row.initial_tape, row.initial_head);
}
