import { MachineDefinition, Transition, Limits, ApiError } from "./types.js";

export interface CompiledMachine {
  definition: MachineDefinition;
  transitionMap: Map<string, Transition>;
  terminalStates: Set<string>;
}

const key = (state: string, read: string) => state + "|" + read;

function isPrintableAscii(ch: string): boolean {
  return typeof ch === "string" && ch.length === 1 && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e;
}

export function validateMachine(raw: unknown, limits: Limits): CompiledMachine {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) throw new ApiError("VALIDATION_ERROR", "machine definition must be an object");
  const def = raw as MachineDefinition;

  const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if (!strArr(def.states)) errors.push("states must be a non-empty string array");
  if (typeof def.startState !== "string") errors.push("startState must be a string");
  if (!strArr(def.acceptStates)) errors.push("acceptStates must be a string array");
  if (!strArr(def.rejectStates)) errors.push("rejectStates must be a string array");
  if (!strArr(def.symbols)) errors.push("symbols must be a non-empty string array");
  if (!Array.isArray(def.transitions)) errors.push("transitions must be an array");
  if (errors.length) throw new ApiError("VALIDATION_ERROR", errors.join("; "));

  const states = new Set(def.states);
  if (states.size !== def.states.length) errors.push("states contains duplicates");
  if (!states.has(def.startState)) errors.push(`startState '${def.startState}' is not declared in states`);

  const accept = new Set(def.acceptStates);
  const reject = new Set(def.rejectStates);
  for (const s of def.acceptStates) if (!states.has(s)) errors.push(`accept state '${s}' is not declared`);
  for (const s of def.rejectStates) if (!states.has(s)) errors.push(`reject state '${s}' is not declared`);
  for (const s of def.acceptStates) if (reject.has(s)) errors.push(`state '${s}' is both accept and reject`);

  const symbols = new Set(def.symbols);
  if (symbols.size !== def.symbols.length) errors.push("symbols contains duplicates");
  for (const s of def.symbols) if (!isPrintableAscii(s)) errors.push(`symbol '${s}' is not a single printable ASCII char`);
  if (!isPrintableAscii(def.blank)) errors.push("blank must be a single printable ASCII char");
  else if (!symbols.has(def.blank)) errors.push(`blank '${def.blank}' must be included in symbols`);

  if (def.states.length > limits.maxStates) errors.push(`state count exceeds limit ${limits.maxStates}`);
  if (def.symbols.length > limits.maxSymbols) errors.push(`symbol count exceeds limit ${limits.maxSymbols}`);
  if (def.transitions.length > limits.maxTransitions) errors.push(`transition count exceeds limit ${limits.maxTransitions}`);

  const terminalStates = new Set([...accept, ...reject]);
  const transitionMap = new Map<string, Transition>();
  for (const t of def.transitions) {
    if (typeof t !== "object" || t === null) { errors.push("transition must be an object"); continue; }
    if (!states.has(t.state)) errors.push(`transition references undeclared state '${t.state}'`);
    if (!states.has(t.next)) errors.push(`transition references undeclared state '${t.next}'`);
    if (!symbols.has(t.read)) errors.push(`transition reads undeclared symbol '${t.read}'`);
    if (!symbols.has(t.write)) errors.push(`transition writes undeclared symbol '${t.write}'`);
    if (t.move !== "L" && t.move !== "R" && t.move !== "S") errors.push(`invalid move direction '${t.move}'`);
    if (terminalStates.has(t.state)) errors.push(`terminal state '${t.state}' must not have outgoing transitions`);
    const k = key(t.state, t.read);
    if (transitionMap.has(k)) errors.push(`duplicate rule (${t.state}, '${t.read}') rejected`);
    else transitionMap.set(k, t);
  }
  if (errors.length) throw new ApiError("VALIDATION_ERROR", errors.join("; "));

  return { definition: def, transitionMap, terminalStates };
}

export function lookupTransition(m: CompiledMachine, state: string, read: string): Transition | undefined {
  return m.transitionMap.get(key(state, read));
}
