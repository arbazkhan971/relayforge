import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/**
 * Project Intelligence — "train the team on the project".
 *
 * Scans a working directory and produces a compact PROJECT-INTELLIGENCE.md that is
 * injected into every SME's prompt. The goal is that a frontend/backend/QA expert
 * never has to re-discover the stack, the dir layout, or — most importantly — the
 * real test/build/lint commands. We detect commands from manifests rather than letting
 * agents invent them, which is the single biggest source of wasted autonomous loops.
 */

export type ProjectIntelligence = {
  root: string;
  name: string;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  commands: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
    typecheck?: string;
    dev?: string;
  };
  entrypoints: string[];
  dirs: string[];
  git?: { branch?: string; remote?: string };
  notes: string[];
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".turbo", ".cache", "vendor", "target", "__pycache__", ".venv", "venv", ".loop"
]);

const SOURCE_EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java",
  ".kt": "Kotlin", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".vue": "Vue",
  ".svelte": "Svelte"
};

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function detectPackageManager(root: string): string | undefined {
  if (existsSync(resolve(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(root, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(root, "bun.lockb")) || existsSync(resolve(root, "bun.lock"))) return "bun";
  if (existsSync(resolve(root, "package-lock.json"))) return "npm";
  if (existsSync(resolve(root, "package.json"))) return "npm";
  return undefined;
}

function pmRun(pm: string | undefined, script: string): string {
  const runner = pm ?? "npm";
  if (runner === "npm") return `npm run ${script}`;
  return `${runner} ${script}`;
}

function topLevelDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((name) => {
        if (IGNORE_DIRS.has(name) || name.startsWith(".")) return false;
        try {
          return statSync(resolve(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function detectLanguages(root: string): string[] {
  const counts: Record<string, number> = {};
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue;
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const dot = entry.lastIndexOf(".");
        if (dot < 0) continue;
        const lang = SOURCE_EXT_TO_LANG[entry.slice(dot)];
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }
  };
  walk(root, 0);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang)
    .slice(0, 5);
}

function detectFrameworks(root: string, deps: Record<string, string>): string[] {
  const found = new Set<string>();
  const has = (name: string) => Boolean(deps[name]);
  if (has("next")) found.add("Next.js");
  if (has("react")) found.add("React");
  if (has("vue")) found.add("Vue");
  if (has("svelte") || has("@sveltejs/kit")) found.add("Svelte");
  if (has("@angular/core")) found.add("Angular");
  if (has("express")) found.add("Express");
  if (has("fastify")) found.add("Fastify");
  if (has("@nestjs/core")) found.add("NestJS");
  if (has("vitest")) found.add("Vitest");
  if (has("jest")) found.add("Jest");
  if (has("playwright") || has("@playwright/test")) found.add("Playwright");
  if (has("tailwindcss")) found.add("Tailwind");
  if (has("prisma") || has("@prisma/client")) found.add("Prisma");
  if (has("drizzle-orm")) found.add("Drizzle");
  // Non-JS ecosystems
  if (existsSync(resolve(root, "go.mod"))) found.add("Go modules");
  if (existsSync(resolve(root, "Cargo.toml"))) found.add("Cargo");
  if (existsSync(resolve(root, "requirements.txt")) || existsSync(resolve(root, "pyproject.toml"))) {
    found.add("Python");
  }
  if (existsSync(resolve(root, "Dockerfile"))) found.add("Docker");
  return [...found];
}

function detectGit(root: string): ProjectIntelligence["git"] {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    let remote: string | undefined;
    try {
      remote = execSync("git remote get-url origin", {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      remote = undefined;
    }
    return { branch, remote };
  } catch {
    return undefined;
  }
}

export function analyzeProject(root: string): ProjectIntelligence {
  const absRoot = resolve(root);
  const notes: string[] = [];
  const pm = detectPackageManager(absRoot);
  const commands: ProjectIntelligence["commands"] = {};
  const entrypoints: string[] = [];
  let name = basename(absRoot);
  let deps: Record<string, string> = {};

  const pkgRaw = safeRead(resolve(absRoot, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.name) name = pkg.name;
      deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const scripts: Record<string, string> = pkg.scripts ?? {};
      commands.install = pm ? (pm === "npm" ? "npm install" : `${pm} install`) : undefined;
      if (scripts.build) commands.build = pmRun(pm, "build");
      if (scripts.test) commands.test = pmRun(pm, "test");
      if (scripts.lint) commands.lint = pmRun(pm, "lint");
      if (scripts.typecheck) commands.typecheck = pmRun(pm, "typecheck");
      else if (deps.typescript) commands.typecheck = "tsc --noEmit";
      if (scripts.dev) commands.dev = pmRun(pm, "dev");
      if (pkg.main) entrypoints.push(String(pkg.main));
      if (pkg.bin) {
        const bin = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin as Record<string, string>);
        entrypoints.push(...bin.map(String));
      }
    } catch {
      notes.push("package.json present but failed to parse.");
    }
  }

  // Non-JS command detection.
  if (!commands.test) {
    if (existsSync(resolve(absRoot, "go.mod"))) {
      commands.test = "go test ./...";
      commands.build = "go build ./...";
    } else if (existsSync(resolve(absRoot, "Cargo.toml"))) {
      commands.test = "cargo test";
      commands.build = "cargo build";
    } else if (existsSync(resolve(absRoot, "pyproject.toml")) || existsSync(resolve(absRoot, "pytest.ini"))) {
      commands.test = "pytest";
    } else if (existsSync(resolve(absRoot, "Makefile"))) {
      const mk = safeRead(resolve(absRoot, "Makefile")) ?? "";
      if (/^test:/m.test(mk)) commands.test = "make test";
      if (/^build:/m.test(mk)) commands.build = "make build";
      notes.push("Makefile detected — prefer make targets where present.");
    }
  }

  for (const candidate of ["src/index.ts", "src/main.ts", "src/cli.ts", "main.go", "src/main.py", "app.py", "index.js"]) {
    if (existsSync(resolve(absRoot, candidate))) entrypoints.push(candidate);
  }

  return {
    root: absRoot,
    name,
    languages: detectLanguages(absRoot),
    frameworks: detectFrameworks(absRoot, deps),
    packageManager: pm,
    commands,
    entrypoints: [...new Set(entrypoints)].slice(0, 8),
    dirs: topLevelDirs(absRoot),
    git: detectGit(absRoot),
    notes
  };
}

export function renderIntelligence(intel: ProjectIntelligence): string {
  const cmd = (label: string, value?: string) => `- **${label}:** ${value ? `\`${value}\`` : "_(not detected — ask before assuming)_"}`;
  return [
    `# Project Intelligence: ${intel.name}`,
    ``,
    `> Auto-generated by \`relayforge learn\`. Every SME on this team is grounded in this file.`,
    `> Treat the detected commands as the source of truth — do not invent build/test commands.`,
    ``,
    `## Stack`,
    `- **Languages:** ${intel.languages.join(", ") || "unknown"}`,
    `- **Frameworks / tools:** ${intel.frameworks.join(", ") || "none detected"}`,
    `- **Package manager:** ${intel.packageManager ?? "unknown"}`,
    ``,
    `## Commands (authoritative — use these verbatim)`,
    cmd("Install", intel.commands.install),
    cmd("Build", intel.commands.build),
    cmd("Test", intel.commands.test),
    cmd("Lint", intel.commands.lint),
    cmd("Typecheck", intel.commands.typecheck),
    cmd("Dev server", intel.commands.dev),
    ``,
    `## Layout`,
    `- **Top-level dirs:** ${intel.dirs.join(", ") || "(flat)"}`,
    `- **Entrypoints:** ${intel.entrypoints.join(", ") || "unknown"}`,
    ``,
    `## Git`,
    `- **Branch:** ${intel.git?.branch ?? "unknown"}`,
    `- **Remote:** ${intel.git?.remote ?? "none"}`,
    intel.notes.length ? `\n## Notes\n${intel.notes.map((n) => `- ${n}`).join("\n")}` : "",
    ``
  ].join("\n");
}

export function writeIntelligence(root: string, outPath: string): ProjectIntelligence {
  const intel = analyzeProject(root);
  writeFileSync(outPath, renderIntelligence(intel));
  return intel;
}
