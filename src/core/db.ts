import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrations } from "./schema";

export const defaultDbPath = () => process.env.MIND_DB ?? join(import.meta.dir, "../../data/mind.db");

export function openDb(path = defaultDbPath()): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  // busy_timeout first: switching to WAL itself needs a lock when another agent has the file open.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

const userVersion = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

function migrate(db: Database) {
  if (userVersion(db) >= migrations.length) return;
  // IMMEDIATE + re-read inside the lock so two processes opening a fresh DB don't both migrate.
  db.transaction(() => {
    for (let v = userVersion(db); v < migrations.length; v++) {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }).immediate();
}
