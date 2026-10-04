import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const playgroundRoot = () => resolve(process.env.MIND_ROOT ?? join(homedir(), "Playground"));

/** "global", "" and null all mean the global scope, stored as NULL. */
export const normalizeProject = (p?: string | null): string | null => {
  const t = p?.trim();
  return !t || t.toLowerCase() === "global" ? null : t;
};

/**
 * Map a working directory to a project name:
 * the first path segment under the playground root, else the git toplevel's name.
 * Git worktrees resolve to their main repo so `kolla-feature` still counts as `kolla`.
 */
export function resolveProject(cwd = process.cwd()): string | null {
  const root = playgroundRoot();
  const abs = resolve(cwd);
  const rel = relative(root, abs);
  if (rel === "") return null;
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    const seg = rel.split(sep)[0]!;
    return worktreeMain(join(root, seg)) ?? seg;
  }
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: abs, stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  const top = r.stdout.toString().trim();
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
