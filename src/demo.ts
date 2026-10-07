import { MachineDefinition } from "./types.js";

export const unaryIncrement: MachineDefinition = {
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

export const leftForever: MachineDefinition = {
  name: "left-forever",
  states: ["q", "accept", "reject"],
  startState: "q",
  acceptStates: ["accept"],
  rejectStates: ["reject"],
  symbols: ["1", "_"],
  blank: "_",
  transitions: [
    { state: "q", read: "_", next: "q", write: "_", move: "L" },
    { state: "q", read: "1", next: "q", write: "_", move: "L" },
  ],
};
