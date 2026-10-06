import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./schema.ts";

export const defaultDbPath = () => process.env.MIND_DB ?? join(import.meta.dirname, "../../data/mind.db");

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout first: switching to WAL itself needs a lock when another agent has the file open.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Run fn in a BEGIN IMMEDIATE transaction: the write lock is taken up front, so a read inside fn
 * can't go stale before the write (SQLITE_BUSY_SNAPSHOT, which busy_timeout doesn't retry).
 */
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = fn();
    db.exec("COMMIT");
    return res;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const userVersion = (db: DatabaseSync) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

function migrate(db: DatabaseSync) {
  if (userVersion(db) >= migrations.length) return;
  // IMMEDIATE + re-read inside the lock so two processes opening a fresh DB don't both migrate.
  immediate(db, () => {
    for (let v = userVersion(db); v < migrations.length; v++) {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  });
}
