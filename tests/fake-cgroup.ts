import type { ScopeOs } from "../src/scope.js";

/**
 * The in-memory cgroup v2 tree the scope tests run against — no real process, signal, or timer.
 *
 * Shared (rather than living inside scope.test.ts) because the ORPHAN GATE in the orchestrator needs it
 * too: the outcome that matters most there is an UNKILLABLE survivor, and a process that ignores
 * SIGKILL is not something a test can stage with real processes. That is precisely why that branch
 * shipped unproven — and wrong (it reported the survivor as reclaimed).
 */
/** An in-memory cgroup v2 tree: directories with attribute files, plus a settable population. */
export class FakeCgroupFs implements ScopeOs {
  readonly dirs = new Map<string, { ino: string; ageMs: number }>();
  /** Tasks per cgroup path. `populated` for a cgroup is (its own tasks) ∪ (any descendant's). */
  readonly tasks = new Map<string, number>();
  readonly kills: string[] = [];
  /** A cgroup whose members refuse to die: `cgroup.kill` is written, but the population stays. */
  unkillable = new Set<string>();
  /** Attribute writes that must fail (e.g. an EACCES cgroup.kill). */
  denyWrite = new Set<string>();
  private nextIno = 1000;

  constructor(readonly root = "/sys/fs/cgroup/test") {
    this.dirs.set(root, { ino: String(this.nextIno++), ageMs: 0 });
  }

  selfCgroupDir(): string | undefined {
    return this.root;
  }
  mkdir(path: string): void {
    if (this.dirs.has(path)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.dirs.set(path, { ino: String(this.nextIno++), ageMs: 0 });
  }
  rmdir(path: string): void {
    if (!this.dirs.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    // The kernel refuses to remove a cgroup that holds a task or a child cgroup. That refusal is the
    // whole basis of the reap proof, so the fake must reproduce it exactly.
    if ((this.tasks.get(path) ?? 0) > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    if (this.children(path).length > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    this.dirs.delete(path);
    this.tasks.delete(path);
  }
  readdir(path: string): string[] {
    if (!this.dirs.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const kids = this.children(path).map((p) => p.slice(path.length + 1));
    return ["cgroup.procs", "cgroup.kill", "cgroup.events", ...kids];
  }
  readText(path: string): string {
    const dir = path.replace(/\/cgroup\.[a-z]+$/, "");
    if (!this.dirs.has(dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (path.endsWith("cgroup.events")) return `populated ${this.populated(dir) ? 1 : 0}\nfrozen 0\n`;
    return "";
  }
  writeText(path: string, data: string): void {
    if (this.denyWrite.has(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const dir = path.replace(/\/cgroup\.[a-z]+$/, "");
    if (!this.dirs.has(dir)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (path.endsWith("cgroup.kill") && data.trim() === "1") {
      this.kills.push(dir);
      if (this.unkillable.has(dir)) return; // members that survive a SIGKILL (the fail-closed case)
      // cgroup.kill is RECURSIVE: every task in the cgroup and every descendant cgroup dies.
      for (const d of [dir, ...this.descendants(dir)]) this.tasks.set(d, 0);
    }
  }
  inodeOf(path: string): string | undefined {
    return this.dirs.get(path)?.ino;
  }
  isDir(path: string): boolean {
    return this.dirs.has(path);
  }
  ageMs(path: string): number | undefined {
    return this.dirs.get(path)?.ageMs;
  }
  shellExists(): boolean {
    return true;
  }

  private children(path: string): string[] {
    return [...this.dirs.keys()].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"));
  }
  private descendants(path: string): string[] {
    return [...this.dirs.keys()].filter((p) => p.startsWith(`${path}/`));
  }
  private populated(path: string): boolean {
    return [path, ...this.descendants(path)].some((p) => (this.tasks.get(p) ?? 0) > 0);
  }
}

/** The fake's methods live on its prototype, so a spread would silently drop them. Bind them explicitly,
 *  then apply the overrides a test wants to break. */
export function osWith(base: FakeCgroupFs, over: Partial<ScopeOs>): ScopeOs {
  return {
    selfCgroupDir: () => base.selfCgroupDir(),
    mkdir: (p) => base.mkdir(p),
    rmdir: (p) => base.rmdir(p),
    readdir: (p) => base.readdir(p),
    readText: (p) => base.readText(p),
    writeText: (p, d) => base.writeText(p, d),
    inodeOf: (p) => base.inodeOf(p),
    isDir: (p) => base.isDir(p),
    ageMs: (p) => base.ageMs(p),
    shellExists: () => base.shellExists(),
    ...over
  };
}

