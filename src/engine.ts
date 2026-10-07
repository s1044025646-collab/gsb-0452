import { MachineDefinition, StepRecord, Transition, Limits, TmError } from "./types.js";
import { buildRuleIndex, terminalKind } from "./machine.js";

export type Tape = Map<number, string>;

export function parseTape(input: string, def: MachineDefinition, limits: Limits): Tape {
  if (typeof input !== "string") throw new TmError("BAD_REQUEST", "tape input must be a string");
  if (input.length > limits.maxNonBlank) throw new TmError("LIMIT_EXCEEDED", `initial tape exceeds non-blank limit ${limits.maxNonBlank}`);
  const tape: Tape = new Map();
  const symbolSet = new Set(def.symbols);
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!symbolSet.has(ch)) throw new TmError("UNDECLARED_SYMBOL", `tape symbol not declared: ${JSON.stringify(ch)}`);
    if (ch !== def.blank) tape.set(i, ch);
  }
  return tape;
}

export function readCell(tape: Tape, pos: number, blank: string): string {
  return tape.get(pos) ?? blank;
}

export interface StepOutcome {
  kind: "step";
  record: Omit<StepRecord, "seq">;
  tape: Tape;
  head: number;
  state: string;
}

export interface StopOutcome {
  kind: "stop";
  reason: "halted_accept" | "halted_reject" | "no_transition";
}

export function stepOnce(
  def: MachineDefinition,
  rules: Map<string, Transition>,
  tape: Tape,
  head: number,
  state: string
): StepOutcome | StopOutcome {
  const term = terminalKind(def, state);
  if (term === "accept") return { kind: "stop", reason: "halted_accept" };
  if (term === "reject") return { kind: "stop", reason: "halted_reject" };

  const read = readCell(tape, head, def.blank);
  const rule = rules.get(`${state}${read}`);
  if (!rule) return { kind: "stop", reason: "no_transition" };

  const newTape: Tape = new Map(tape);
  if (rule.write === def.blank) newTape.delete(head);
  else newTape.set(head, rule.write);

  const newHead = rule.move === "L" ? head - 1 : rule.move === "R" ? head + 1 : head;

  return {
    kind: "step",
    record: { oldState: state, head, read, rule, newState: rule.next, newHead, written: rule.write },
    tape: newTape,
    head: newHead,
    state: rule.next,
  };
}

export interface RunResult {
  tape: Tape;
  head: number;
  state: string;
  steps: StepRecord[];
  status: "paused_by_budget" | "halted_accept" | "halted_reject" | "no_transition" | "limited";
  limitReason?: string;
}

export function checkStepLimits(
  limits: Limits,
  tape: Tape,
  head: number,
  totalSteps: number
): string | null {
  if (totalSteps >= limits.maxStepsTotal) return `total steps limit ${limits.maxStepsTotal} reached`;
  if (tape.size > limits.maxNonBlank) return `non-blank cell limit ${limits.maxNonBlank} exceeded`;
  if (Math.abs(head) > limits.maxCoord) return `head coordinate limit ±${limits.maxCoord} exceeded`;
  return null;
}

export function runBudget(
  def: MachineDefinition,
  tape: Tape,
  head: number,
  state: string,
  totalSteps: number,
  budget: number,
  limits: Limits
): RunResult {
  const rules = buildRuleIndex(def);
  const steps: StepRecord[] = [];
  let curTape = tape;
  let curHead = head;
  let curState = state;
  let curTotal = totalSteps;

  for (let i = 0; i < budget; i++) {
    const outcome = stepOnce(def, rules, curTape, curHead, curState);
    if (outcome.kind === "stop") {
      return { tape: curTape, head: curHead, state: curState, steps, status: outcome.reason };
    }
    const limitHit = checkStepLimits(limits, outcome.tape, outcome.head, curTotal + 1);
    if (limitHit) {
      return { tape: curTape, head: curHead, state: curState, steps, status: "limited", limitReason: limitHit };
    }
    steps.push({ seq: curTotal + 1, ...outcome.record });
    curTape = outcome.tape;
    curHead = outcome.head;
    curState = outcome.state;
    curTotal += 1;
  }

  const after = stepOnce(def, rules, curTape, curHead, curState);
  if (after.kind === "stop") {
    return { tape: curTape, head: curHead, state: curState, steps, status: after.reason };
  }
  return { tape: curTape, head: curHead, state: curState, steps, status: "paused_by_budget" };
}

export function tapeWindow(
  tape: Tape,
  start: number,
  width: number,
  limits: Limits
): { start: number; width: number; cells: { pos: number; char: string }[] } {
  if (!Number.isInteger(start)) throw new TmError("BAD_REQUEST", "start must be an integer");
  if (!Number.isInteger(width) || width < 0 || width > 10_000) {
    throw new TmError("BAD_REQUEST", "width must be an integer between 0 and 10000");
  }
  if (Math.abs(start) > limits.maxCoord + 10_000) throw new TmError("BAD_REQUEST", "start out of allowed coordinate range");
  const cells: { pos: number; char: string }[] = [];
  for (const [pos, char] of tape) {
    if (pos >= start && pos < start + width) cells.push({ pos, char });
  }
  cells.sort((a, b) => a.pos - b.pos);
  return { start, width, cells };
}
