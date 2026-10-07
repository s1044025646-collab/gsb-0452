import { DatabaseSync } from "node:sqlite";
import {
  MachineDefinition,
  StepRecord,
  TmError,
  Limits,
  DEFAULT_LIMITS,
  ExecStatus,
} from "./types.js";
import { validateMachine, terminalKind } from "./machine.js";
import { parseTape, runBudget, tapeWindow, Tape } from "./engine.js";

function tapeToJson(tape: Tape): string {
  return JSON.stringify(Object.fromEntries(tape));
}

function tapeFromJson(json: string): Tape {
  const obj = JSON.parse(json) as Record<string, string>;
  const tape: Tape = new Map();
  for (const [k, v] of Object.entries(obj)) tape.set(Number(k), v);
  return tape;
}

interface ExecRow {
  id: number;
  machine_id: number;
  initial_tape_json: string;
  initial_head: number;
  initial_state: string;
  tape_json: string;
  head: number;
  state: string;
  steps: number;
  status: string;
  limit_reason: string | null;
  version: number;
}

export class TmService {
  private limits: Limits;

  constructor(
    private db: DatabaseSync,
    limits?: Partial<Limits>
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  getLimits(): Limits {
    return this.limits;
  }

  createMachine(raw: unknown): { machineKey: string; version: number; machineId: number } {
    const def = validateMachine(raw, this.limits);
    const key = `${def.name}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const info = this.db
      .prepare("INSERT INTO machines (machine_key, version, definition_json) VALUES (?, 1, ?)")
      .run(key, JSON.stringify(def));
    return { machineKey: key, version: 1, machineId: Number(info.lastInsertRowid) };
  }

  updateMachine(machineKey: string, raw: unknown): { machineKey: string; version: number; machineId: number } {
    const def = validateMachine(raw, this.limits);
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM machines WHERE machine_key = ?")
      .get(machineKey) as { v: number | null } | undefined;
    if (!row || row.v === null) throw new TmError("NOT_FOUND", `machine not found: ${machineKey}`);
    const newVersion = row.v + 1;
    const info = this.db
      .prepare("INSERT INTO machines (machine_key, version, definition_json) VALUES (?, ?, ?)")
      .run(machineKey, newVersion, JSON.stringify(def));
    return { machineKey, version: newVersion, machineId: Number(info.lastInsertRowid) };
  }

  private getMachineRow(machineKey: string, version?: number): { id: number; def: MachineDefinition; version: number } {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT * FROM machines WHERE machine_key = ? ORDER BY version DESC LIMIT 1").get(machineKey)
        : this.db.prepare("SELECT * FROM machines WHERE machine_key = ? AND version = ?").get(machineKey, version)
    ) as { id: number; version: number; definition_json: string } | undefined;
    if (!row) throw new TmError("NOT_FOUND", `machine not found: ${machineKey}${version !== undefined ? `@${version}` : ""}`);
    return { id: row.id, def: JSON.parse(row.definition_json) as MachineDefinition, version: row.version };
  }

  getMachine(machineKey: string, version?: number) {
    const { def, version: v } = this.getMachineRow(machineKey, version);
    return { machineKey, version: v, definition: def };
  }

  getTransitions(machineKey: string, version?: number) {
    const { def, version: v } = this.getMachineRow(machineKey, version);
    return { machineKey, version: v, transitions: def.transitions };
  }

  createExecution(machineKey: string, opts: { tape?: string; head?: number; state?: string; machineVersion?: number }) {
    const { id: machineId, def, version } = this.getMachineRow(machineKey, opts.machineVersion);
    const head = opts.head ?? 0;
    if (!Number.isInteger(head)) throw new TmError("BAD_REQUEST", "head must be an integer");
    if (Math.abs(head) > this.limits.maxCoord) throw new TmError("LIMIT_EXCEEDED", `head exceeds coordinate limit ±${this.limits.maxCoord}`);
    const state = opts.state ?? def.startState;
    if (!def.states.includes(state)) throw new TmError("UNDECLARED_STATE", `initial state not declared: ${state}`);
    const tape = parseTape(opts.tape ?? "", def, this.limits);
    const term = terminalKind(def, state);
    const status: ExecStatus = term === "accept" ? "halted_accept" : term === "reject" ? "halted_reject" : "running";
    const info = this.db
      .prepare(
        `INSERT INTO executions (machine_id, initial_tape_json, initial_head, initial_state, tape_json, head, state, steps, status, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`
      )
      .run(machineId, tapeToJson(tape), head, state, tapeToJson(tape), head, state, status);
    return this.getExecution(Number(info.lastInsertRowid));
  }

  private getExecRow(id: number): ExecRow {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecRow | undefined;
    if (!row) throw new TmError("NOT_FOUND", `execution not found: ${id}`);
    return row;
  }

  private getExecDef(row: ExecRow): MachineDefinition {
    const m = this.db.prepare("SELECT definition_json FROM machines WHERE id = ?").get(row.machine_id) as { definition_json: string };
    return JSON.parse(m.definition_json) as MachineDefinition;
  }

  getExecution(id: number) {
    const row = this.getExecRow(id);
    return {
      id: row.id,
      machineId: row.machine_id,
      head: row.head,
      state: row.state,
      steps: row.steps,
      status: row.status,
      limitReason: row.limit_reason,
      version: row.version,
      initialHead: row.initial_head,
      initialState: row.initial_state,
    };
  }

  getTapeWindow(id: number, start: number, width: number) {
    const row = this.getExecRow(id);
    const tape = tapeFromJson(row.tape_json);
    const win = tapeWindow(tape, start, width, this.limits);
    return { ...win, head: row.head, state: row.state, steps: row.steps, status: row.status };
  }

  getSteps(id: number): StepRecord[] {
    this.getExecRow(id);
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE execution_id = ? ORDER BY seq ASC")
      .all(id) as unknown as {
      seq: number; old_state: string; head: number; read: string; rule_json: string;
      new_state: string; new_head: number; written: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      oldState: r.old_state,
      head: r.head,
      read: r.read,
      rule: JSON.parse(r.rule_json),
      newState: r.new_state,
      newHead: r.new_head,
      written: r.written,
    }));
  }

  run(id: number, budget: number, expectedVersion: number, requestId?: string) {
    if (!Number.isInteger(budget) || budget < 0) throw new TmError("BAD_REQUEST", "budget must be a non-negative integer");
    if (budget > 1_000_000) throw new TmError("BAD_REQUEST", "budget too large for a single request (max 1000000)");
    if (!Number.isInteger(expectedVersion)) throw new TmError("BAD_REQUEST", "expectedVersion must be an integer");

    if (requestId !== undefined) {
      const existing = this.db.prepare("SELECT response_json FROM requests WHERE request_id = ?").get(requestId) as
        | { response_json: string }
        | undefined;
      if (existing) return { ...JSON.parse(existing.response_json), idempotentReplay: true };
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getExecRow(id);
      if (row.version !== expectedVersion) {
        throw new TmError("VERSION_CONFLICT", `execution version conflict: expected ${expectedVersion}, current ${row.version}`);
      }
      if (row.status === "halted_accept" || row.status === "halted_reject" || row.status === "no_transition" || row.status === "limited") {
        throw new TmError("ALREADY_HALTED", `execution already stopped with status ${row.status}`);
      }
      const def = this.getExecDef(row);
      const tape = tapeFromJson(row.tape_json);
      const result = runBudget(def, tape, row.head, row.state, row.steps, budget, this.limits);

      const insertStep = this.db.prepare(
        "INSERT INTO steps (execution_id, seq, old_state, head, read, rule_json, new_state, new_head, written) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const s of result.steps) {
        insertStep.run(id, s.seq, s.oldState, s.head, s.read, JSON.stringify(s.rule), s.newState, s.newHead, s.written);
      }
      const newStatus: ExecStatus = result.status;
      this.db
        .prepare("UPDATE executions SET tape_json = ?, head = ?, state = ?, steps = ?, status = ?, limit_reason = ?, version = version + 1 WHERE id = ?")
        .run(tapeToJson(result.tape), result.head, result.state, row.steps + result.steps.length, newStatus, result.limitReason ?? null, id);

      const response = {
        id,
        executedSteps: result.steps.length,
        steps: result.steps,
        head: result.head,
        state: result.state,
        totalSteps: row.steps + result.steps.length,
        status: newStatus,
        limitReason: result.limitReason ?? null,
        version: row.version + 1,
      };
      if (requestId !== undefined) {
        this.db.prepare("INSERT INTO requests (request_id, execution_id, response_json) VALUES (?, ?, ?)").run(
          requestId,
          id,
          JSON.stringify(response)
        );
      }
      this.db.exec("COMMIT");
      return response;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  step(id: number, expectedVersion: number, requestId?: string) {
    return this.run(id, 1, expectedVersion, requestId);
  }

  replay(id: number, budget?: number) {
    const row = this.getExecRow(id);
    const def = this.getExecDef(row);
    const tape = tapeFromJson(row.initial_tape_json);
    const effectiveBudget = budget ?? row.steps;
    const result = runBudget(def, tape, row.initial_head, row.initial_state, 0, effectiveBudget, this.limits);
    return {
      id,
      budget: effectiveBudget,
      head: result.head,
      state: result.state,
      totalSteps: result.steps.length,
      status: result.status,
      steps: result.steps,
      matchesCurrent:
        budget === undefined &&
        result.head === row.head &&
        result.state === row.state &&
        result.steps.length === row.steps,
    };
  }
}
