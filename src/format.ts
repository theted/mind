import type { Memory, MemoryStore } from "./core/store.ts";

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
