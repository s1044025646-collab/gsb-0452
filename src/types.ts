export type Direction = "L" | "R" | "S";

export interface Transition {
  state: string;
  read: string;
  next: string;
  write: string;
  move: Direction;
}

export interface MachineDefinition {
  name?: string;
  states: string[];
  startState: string;
  acceptStates: string[];
  rejectStates: string[];
  symbols: string[];
  blank: string;
  transitions: Transition[];
}

export interface Limits {
  maxStates: number;
  maxSymbols: number;
  maxTransitions: number;
  maxCells: number;
  maxAbsCoord: number;
  maxTotalSteps: number;
  maxStepsPerRun: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxStates: 256,
  maxSymbols: 64,
  maxTransitions: 4096,
  maxCells: 100000,
  maxAbsCoord: 1000000,
  maxTotalSteps: 1000000,
  maxStepsPerRun: 100000,
};

export type ExecStatus =
  | "running"
  | "paused_by_budget"
  | "accepted"
  | "rejected"
  | "no_transition"
  | "limited";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
