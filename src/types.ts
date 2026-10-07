export type Move = "L" | "R" | "S";

export interface Transition {
  state: string;
  read: string;
  next: string;
  write: string;
  move: Move;
}

export interface MachineDefinition {
  name: string;
  states: string[];
  startState: string;
  acceptStates: string[];
  rejectStates: string[];
  symbols: string[];
  blank: string;
  transitions: Transition[];
}

export type ExecStatus =
  | "running"
  | "paused_by_budget"
  | "halted_accept"
  | "halted_reject"
  | "no_transition"
  | "limited";

export interface StepRecord {
  seq: number;
  oldState: string;
  head: number;
  read: string;
  rule: Transition;
  newState: string;
  newHead: number;
  written: string;
}

export interface Limits {
  maxStates: number;
  maxSymbols: number;
  maxTransitions: number;
  maxStepsTotal: number;
  maxNonBlank: number;
  maxCoord: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxStates: 1000,
  maxSymbols: 128,
  maxTransitions: 100000,
  maxStepsTotal: 1_000_000,
  maxNonBlank: 100_000,
  maxCoord: 1_000_000,
};

export class TmError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}
