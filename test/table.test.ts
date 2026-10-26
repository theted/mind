import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, test } from "node:test";
import type { Memory } from "../src/core/types.ts";
import { age, memoryTable } from "../src/format.ts";
import { displayWidth, renderTable, truncate } from "../src/table.ts";

const memory = (id: number, over: Partial<Memory> = {}): Memory => ({
  id,
  project: "kolla",
  kind: "gotcha",
  title: `Memory number ${id} with a fairly long title that will need truncating`,
  body: "Some body text explaining why and how to apply it.",
  tags: ["deploy", "docker"],
  files: [],
  source: "cli",
  importance: 3,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_accessed_at: null,
  access_count: 0,
  superseded_by: null,
  ...over,
});

const widths = (table: string) => table.split("\n").map(displayWidth);

describe("text width", () => {
  test("counts terminal cells", () => {
    assert.equal(displayWidth("abc"), 3);
    assert.equal(displayWidth("日本語"), 6);
    assert.equal(displayWidth("🚀 go"), 5);
    assert.equal(displayWidth("★★★"), 3);
    assert.equal(displayWidth("é"), 1);
    assert.equal(displayWidth("\x1b[1mbold\x1b[22m"), 4);
  });

  test("truncates by cells without splitting wide characters", () => {
    assert.equal(truncate("hello world", 6), "hello…");
    assert.equal(truncate("short", 10), "short");
    assert.equal(truncate("日本語テキスト", 6), "日本…");
    assert.ok(displayWidth(truncate("日本語テキスト", 6)) <= 6);
  });
});

describe("tables", () => {
  test("fit the given width, every line the same width", () => {
    for (const width of [60, 80, 120, 200]) {
      const table = memoryTable([memory(1), memory(22, { title: "短いタイトル" })], { width, color: false });
      const lines = widths(table);
      assert.ok(lines.every((w) => w === lines[0]), `uneven lines at ${width}`);
      assert.ok(lines[0]! <= width, `${lines[0]} > ${width}`);
    }
  });

  test("drop optional columns when too narrow, flexible ones first", () => {
    const wide = memoryTable([memory(1)], { width: 200, color: false });
    const narrow = memoryTable([memory(1)], { width: 70, color: false });
    assert.match(wide, /Tags/);
    assert.match(wide, /Updated/);
    assert.doesNotMatch(narrow, /Tags/);
    assert.match(narrow, /Title/);
  });

  test("unlimited width never truncates", () => {
    const table = memoryTable([memory(1)], { width: Number.POSITIVE_INFINITY, color: false });
    assert.match(table, /fairly long title that will need truncating/);
  });

  test("color can be forced on or off", () => {
    const columns = [{ header: "A", value: (r: string) => r, style: () => "red" as const }];
    const on = renderTable(["x"], columns, { color: true });
    assert.notEqual(stripVTControlCharacters(on), on);
    assert.equal(stripVTControlCharacters(renderTable(["x"], columns, { color: false })), renderTable(["x"], columns, { color: false }));
  });

  test("marks superseded memories and shows body details for recall", () => {
    const table = memoryTable([memory(1, { superseded_by: 9 })], { detail: "body", width: 300, color: false });
    assert.match(table, /\(→ #9\)/);
    assert.match(table, /Details/);
    assert.match(table, /Some body text/);
  });

  test("relative ages", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    assert.equal(age("2026-10-26T11:59:30Z", now), "now");
    assert.equal(age("2026-10-26T09:00:00Z", now), "3h ago");
    assert.equal(age("2026-10-20T12:00:00Z", now), "6d ago");
    assert.equal(age("2026-07-01T12:00:00Z", now), "3mo ago");
    assert.equal(age("2024-01-01T12:00:00Z", now), "2y ago");
  });
});
