import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

const expandHome = (p: string) => (p === "~" || /^~[\\/]/.test(p) ? join(homedir(), p.slice(1)) : p);

/**
 * Project roots from MIND_ROOT: one or more directories separated like PATH (":", or ";" on Windows).
 * Defaults to ~/Playground; an empty MIND_ROOT disables root mapping.
 */
export const projectRoots = (): string[] => {
  const raw = process.env.MIND_ROOT ?? join(homedir(), "Playground");
  const roots = raw
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(expandHome(p)));
  return [...new Set(roots)];
};

/** "global", "" and null all mean the global scope, stored as NULL. */
export const normalizeProject = (p?: string | null): string | null => {
  const t = p?.trim();
  return !t || t.toLowerCase() === "global" ? null : t;
};

/** Path of `abs` relative to `root`, or null when it lies outside. */
const relativeInside = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
};

/**
 * Map a working directory to a project name:
 * the first path segment under a project root (the most specific one when roots are nested),
 * else the git toplevel's name. A root itself maps to global.
 * Git worktrees resolve to their main repo so `kolla-feature` still counts as `kolla`.
 */
export function resolveProject(cwd = process.cwd()): string | null {
  const abs = resolve(cwd);
  for (const root of projectRoots().sort((a, b) => b.length - a.length)) {
    const rel = relativeInside(root, abs);
    if (rel === null) continue;
    if (rel === "") return null;
    const seg = rel.split(sep)[0]!;
    return worktreeMain(join(root, seg)) ?? seg;
  }
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: abs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  return worktreeMain(top) ?? basename(top);
}

// A worktree's .git is a file: "gitdir: /path/to/main/.git/worktrees/<name>"
function worktreeMain(dir: string): string | null {
  try {
    const gitPath = join(dir, ".git");
    if (!statSync(gitPath).isFile()) return null;
    const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m);
    return m ? basename(m[1]!) : null;
  } catch {
    return null;
  }
}
