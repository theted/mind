import type { SemanticStatus } from "./core/mind.ts";
import type { MemoryStore } from "./core/store.ts";
import type { Kind, Memory } from "./core/types.ts";
import { type Column, renderTable, type Style, type TableOptions } from "./table.ts";

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const scope = (m: Memory) => m.project ?? "global";

/** Compact one-liner for lists. */
export const memoryLine = (m: Memory, bodyChars = 160) => {
  const meta = [`#${m.id}`, m.kind, scope(m), m.importance !== 3 ? `★${m.importance}` : ""].filter(Boolean).join(" · ");
  const body = m.body ? ` — ${oneLine(m.body, bodyChars)}` : "";
  const flag = m.superseded_by ? ` (superseded by #${m.superseded_by})` : "";
  return `- [${meta}] **${m.title}**${body}${flag}`;
};

/** Full record. */
export const memoryBlock = (m: Memory) => {
  const header = [
    `### #${m.id} ${m.title}`,
    `${m.kind} · ${scope(m)} · importance ${m.importance}${m.tags.length ? ` · tags: ${m.tags.join(", ")}` : ""}`,
    `source: ${m.source ?? "?"} · created ${m.created_at.slice(0, 10)} · updated ${m.updated_at.slice(0, 10)}` +
      (m.superseded_by ? ` · superseded by #${m.superseded_by}` : ""),
    m.files.length ? `files: ${m.files.join(", ")}` : "",
  ].filter(Boolean);
  return m.body ? `${header.join("\n")}\n\n${m.body}` : header.join("\n");
};

/** Markdown injected at session start (SessionStart hook / `mind context`). */
export function contextMarkdown(store: MemoryStore, project: string | null): string {
  const { project: proj, global } = store.context(project);
  const out = [
    `# Shared memory (mind)${project ? ` — project: ${project}` : ""}`,
    `Long-term memory shared by all agents across projects. Search it with the \`mind\` MCP tool \`recall\` (or \`mind recall "<query>"\`) before non-trivial work; save durable, non-obvious learnings with \`remember\`.`,
  ];
  if (proj.length) out.push("", `## ${project}`, ...proj.map((m) => memoryLine(m)));
  if (global.length) out.push("", "## global", ...global.map((m) => memoryLine(m)));
  if (!proj.length && !global.length) out.push("", "_No memories stored yet for this scope._");
  return out.join("\n");
}

// Tables for humans at a terminal (the CLI); agents get the markdown lines above, which cost fewer tokens.

const KIND_STYLE: Record<Kind, Style> = {
  fact: "blue",
  decision: "magenta",
  preference: "green",
  gotcha: "red",
  howto: "cyan",
  episode: "gray",
};

const AGE_UNITS: [seconds: number, unit: string][] = [
  [31_536_000, "y"],
  [2_592_000, "mo"],
  [604_800, "w"],
  [86_400, "d"],
  [3_600, "h"],
  [60, "m"],
];

/** "3d ago"-style age of an ISO timestamp. */
export const age = (iso: string, now = Date.now()) => {
  const seconds = (now - Date.parse(iso)) / 1000;
  const unit = AGE_UNITS.find(([n]) => seconds >= n);
  return unit ? `${Math.floor(seconds / unit[0])}${unit[1]} ago` : "now";
};

/**
 * Memories as a table. `detail` picks the last flexible column: tags (for browsing) or a body
 * snippet (for search results).
 */
export const memoryTable = (memories: Memory[], { detail = "tags", ...opts }: { detail?: "tags" | "body" } & TableOptions<Memory> = {}) => {
  const columns: Column<Memory>[] = [
    { header: "#", value: (m) => String(m.id), align: "right" },
    { header: "Kind", value: (m) => m.kind, style: (m) => KIND_STYLE[m.kind] },
    { header: "Project", value: scope },
    { header: "Imp", value: (m) => "★".repeat(m.importance), style: (m) => (m.importance > 3 ? "yellow" : "dim") },
    {
      header: "Title",
      value: (m) => (m.superseded_by ? `${m.title} (→ #${m.superseded_by})` : m.title),
      flex: 4,
      min: 20,
      style: () => "bold",
    },
    detail === "tags"
      ? { header: "Tags", value: (m) => m.tags.join(", "), flex: 1, min: 8, optional: true, style: () => "cyan" }
      : { header: "Details", value: (m) => m.body, flex: 3, min: 16, optional: true, style: () => "dim" },
    { header: "Updated", value: (m) => age(m.updated_at), align: "right", optional: true },
  ];
  return renderTable(memories, columns, { rowStyle: (m) => (m.superseded_by ? "dim" : undefined), ...opts });
};

export const projectsTable = (projects: { project: string; count: number; last_updated: string }[], opts: TableOptions<(typeof projects)[number]> = {}) =>
  renderTable(
    projects,
    [
      { header: "Project", value: (p) => p.project, style: (p) => (p.project === "global" ? "magenta" : "bold") },
      { header: "Memories", value: (p) => String(p.count), align: "right" },
      { header: "Last updated", value: (p) => `${p.last_updated.slice(0, 10)} (${age(p.last_updated)})` },
    ],
    opts,
  );

export const statsTable = (stats: ReturnType<MemoryStore["stats"]>, semantic: SemanticStatus | null, opts: TableOptions<[string, string]> = {}) => {
  const rows: [string, string][] = [
    ["Memories", String(stats.memories)],
    ...Object.entries(stats.by_kind).map(([kind, n]): [string, string] => [`· ${kind}`, String(n)]),
    ["Superseded", String(stats.superseded)],
    ["Deleted", String(stats.deleted)],
    ["Projects", String(stats.projects)],
    [
      "Semantic index",
      semantic
        ? `${semantic.embedded}/${semantic.total} embedded · ${semantic.model}${semantic.error ? ` · error: ${semantic.error}` : ""}`
        : "off (set MIND_EMBED_URL)",
    ],
  ];
  return renderTable(
    rows,
    [
      { header: "Stat", value: ([k]) => k, style: ([k]) => (k.startsWith("·") ? "dim" : "bold") },
      { header: "Value", value: ([, v]) => v, flex: 1, min: 10 },
    ],
    opts,
  );
};
