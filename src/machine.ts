import { MachineDefinition, Move, Transition, TmError, Limits } from "./types.js";

const MOVES: Move[] = ["L", "R", "S"];

function isPrintableAsciiChar(s: unknown): s is string {
  return typeof s === "string" && s.length === 1 && s.charCodeAt(0) >= 0x20 && s.charCodeAt(0) <= 0x7e;
}

function isStateName(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 64;
}

export function validateMachine(raw: unknown, limits: Limits): MachineDefinition {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TmError("MACHINE_INVALID", "machine definition must be an object");
  }
  const d = raw as Record<string, unknown>;
  const fail = (msg: string) => {
    throw new TmError("MACHINE_INVALID", msg);
  };

  if (typeof d.name !== "string" || d.name.length === 0 || d.name.length > 128) fail("name must be a non-empty string (<=128 chars)");
  if (!Array.isArray(d.states) || d.states.length === 0) fail("states must be a non-empty array");
  if (!Array.isArray(d.acceptStates)) fail("acceptStates must be an array");
  if (!Array.isArray(d.rejectStates)) fail("rejectStates must be an array");
  if (!Array.isArray(d.symbols) || d.symbols.length === 0) fail("symbols must be a non-empty array");
  if (!Array.isArray(d.transitions)) fail("transitions must be an array");
  if (!isStateName(d.startState)) fail("startState must be a non-empty string");
  if (!isPrintableAsciiChar(d.blank)) fail("blank must be a single printable ASCII character");

  const states = d.states as unknown[];
  const accepts = d.acceptStates as unknown[];
  const rejects = d.rejectStates as unknown[];
  const symbols = d.symbols as unknown[];
  const transitions = d.transitions as unknown[];

  if (states.length > limits.maxStates) throw new TmError("LIMIT_EXCEEDED", `states exceed limit ${limits.maxStates}`);
  if (symbols.length > limits.maxSymbols) throw new TmError("LIMIT_EXCEEDED", `symbols exceed limit ${limits.maxSymbols}`);
  if (transitions.length > limits.maxTransitions) throw new TmError("LIMIT_EXCEEDED", `transitions exceed limit ${limits.maxTransitions}`);

  for (const s of states) if (!isStateName(s)) fail(`invalid state name: ${JSON.stringify(s)}`);
  const stateSet = new Set(states as string[]);
  if (stateSet.size !== states.length) fail("duplicate state names");

  for (const s of symbols) {
    if (!isPrintableAsciiChar(s)) throw new TmError("INVALID_SYMBOL", `symbol must be a single printable ASCII char: ${JSON.stringify(s)}`);
  }
  const symbolSet = new Set(symbols as string[]);
  if (symbolSet.size !== symbols.length) fail("duplicate symbols");
  if (!symbolSet.has(d.blank as string)) fail("blank must be one of the declared symbols");

  if (!stateSet.has(d.startState as string)) throw new TmError("UNDECLARED_STATE", "startState is not declared");

  const acceptSet = new Set<string>();
  for (const s of accepts) {
    if (!stateSet.has(s as string)) throw new TmError("UNDECLARED_STATE", `accept state not declared: ${String(s)}`);
    acceptSet.add(s as string);
  }
  const rejectSet = new Set<string>();
  for (const s of rejects) {
    if (!stateSet.has(s as string)) throw new TmError("UNDECLARED_STATE", `reject state not declared: ${String(s)}`);
    if (acceptSet.has(s as string)) throw new TmError("ACCEPT_REJECT_OVERLAP", `state is both accept and reject: ${String(s)}`);
    rejectSet.add(s as string);
  }
  const terminalSet = new Set([...acceptSet, ...rejectSet]);

  const seen = new Set<string>();
  const outTransitions: Transition[] = [];
  for (const t of transitions) {
    if (typeof t !== "object" || t === null) fail("transition must be an object");
    const tr = t as Record<string, unknown>;
    if (!stateSet.has(tr.state as string)) throw new TmError("UNDECLARED_STATE", `transition state not declared: ${String(tr.state)}`);
    if (!stateSet.has(tr.next as string)) throw new TmError("UNDECLARED_STATE", `transition next state not declared: ${String(tr.next)}`);
    if (!symbolSet.has(tr.read as string)) throw new TmError("UNDECLARED_SYMBOL", `transition read symbol not declared: ${JSON.stringify(tr.read)}`);
    if (!symbolSet.has(tr.write as string)) throw new TmError("UNDECLARED_SYMBOL", `transition write symbol not declared: ${JSON.stringify(tr.write)}`);
    if (!MOVES.includes(tr.move as Move)) throw new TmError("INVALID_DIRECTION", `move must be L, R or S, got: ${JSON.stringify(tr.move)}`);
    if (terminalSet.has(tr.state as string)) {
      throw new TmError("TERMINAL_HAS_OUTGOING", `terminal state ${String(tr.state)} must not have outgoing transitions`);
    }
    const key = `${tr.state}${tr.read}`;
    if (seen.has(key)) {
      throw new TmError("DUPLICATE_RULE", `duplicate rule for (state=${String(tr.state)}, read=${JSON.stringify(tr.read)})`);
    }
    seen.add(key);
    outTransitions.push({
      state: tr.state as string,
      read: tr.read as string,
      next: tr.next as string,
      write: tr.write as string,
      move: tr.move as Move,
    });
  }

  return {
    name: d.name as string,
    states: states as string[],
    startState: d.startState as string,
    acceptStates: accepts as string[],
    rejectStates: rejects as string[],
    symbols: symbols as string[],
    blank: d.blank as string,
    transitions: outTransitions,
  };
}

export function buildRuleIndex(def: MachineDefinition): Map<string, Transition> {
  const m = new Map<string, Transition>();
  for (const t of def.transitions) m.set(`${t.state}${t.read}`, t);
  return m;
}

export function terminalKind(def: MachineDefinition, state: string): "accept" | "reject" | null {
  if (def.acceptStates.includes(state)) return "accept";
  if (def.rejectStates.includes(state)) return "reject";
  return null;
}
