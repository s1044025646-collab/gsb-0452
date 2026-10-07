import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "tm.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(machine_key, version)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL REFERENCES machines(id),
      initial_tape_json TEXT NOT NULL,
      initial_head INTEGER NOT NULL,
      initial_state TEXT NOT NULL,
      tape_json TEXT NOT NULL,
      head INTEGER NOT NULL,
      state TEXT NOT NULL,
      steps INTEGER NOT NULL,
      status TEXT NOT NULL,
      limit_reason TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id INTEGER NOT NULL REFERENCES executions(id),
      seq INTEGER NOT NULL,
      old_state TEXT NOT NULL,
      head INTEGER NOT NULL,
      read TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      new_state TEXT NOT NULL,
      new_head INTEGER NOT NULL,
      written TEXT NOT NULL,
      UNIQUE(execution_id, seq)
    );
    CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY,
      execution_id INTEGER NOT NULL,
      response_json TEXT NOT NULL
    );
  `);
  return db;
}
