// Ordered migrations; index + 1 is the PRAGMA user_version after applying it.
// Append only — never edit a migration that has shipped.
export const migrations: string[] = [
  `
  CREATE TABLE memories (
    id               INTEGER PRIMARY KEY,
    project          TEXT,                       -- NULL = global
    kind             TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','gotcha','howto','episode')),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    tags             TEXT NOT NULL DEFAULT '',   -- space-separated, lowercase
    files            TEXT NOT NULL DEFAULT '[]', -- JSON array of paths
    source           TEXT,                       -- agent/tool that wrote it
    importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    content_hash     TEXT NOT NULL,
    created_at       INTEGER NOT NULL,           -- unix ms
    updated_at       INTEGER NOT NULL,
    last_accessed_at INTEGER,
    access_count     INTEGER NOT NULL DEFAULT 0,
    superseded_by    INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    deleted_at       INTEGER
  );

  CREATE UNIQUE INDEX memories_dedupe ON memories(ifnull(project, ''), content_hash) WHERE deleted_at IS NULL;
  CREATE INDEX memories_project ON memories(project, updated_at);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, body, tags,
    content = 'memories', content_rowid = 'id',
    tokenize = 'porter unicode61'
  );

  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  END;
  -- Only re-index when searchable columns change, so access bookkeeping doesn't churn the index.
  CREATE TRIGGER memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  `,
];
