import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      definition TEXT NOT NULL,
      limits TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL REFERENCES machines(id),
      initial_tape TEXT NOT NULL,
      initial_head INTEGER NOT NULL,
      state TEXT NOT NULL,
      head INTEGER NOT NULL,
      status TEXT NOT NULL,
      steps_executed INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tape_cells (
      execution_id INTEGER NOT NULL REFERENCES executions(id),
      coord INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      PRIMARY KEY (execution_id, coord)
    );
    CREATE TABLE IF NOT EXISTS steps (
      execution_id INTEGER NOT NULL REFERENCES executions(id),
      step_no INTEGER NOT NULL,
      old_state TEXT NOT NULL,
      head INTEGER NOT NULL,
      read_symbol TEXT NOT NULL,
      rule TEXT NOT NULL,
      new_state TEXT NOT NULL,
      PRIMARY KEY (execution_id, step_no)
    );
    CREATE TABLE IF NOT EXISTS run_requests (
      request_id TEXT PRIMARY KEY,
      execution_id INTEGER NOT NULL REFERENCES executions(id),
      response TEXT NOT NULL
    );
  `);
  return db;
}
