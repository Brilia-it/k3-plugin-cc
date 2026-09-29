#!/usr/bin/env node
// BRILIA fork: the identity map between upstream (linxule/kimi-plugin-cc) and
// this fork (k3-plugin-cc).
//
// WHY THIS EXISTS
//
// This fork carries its own name everywhere a user or another program can see
// it: commands (/k3:*), agents and Codex skills (k3-*), the plugin and
// marketplace ids, the environment variables (K3_PLUGIN_CC_*), the marker of
// the block it writes into ~/.kimi-code/config.toml, its data directory and its
// messages. Upstream keeps "kimi". Two reasons, both practical:
//
//   - the two plugins can be installed side by side without one reading the
//     other's variables or rewriting the other's hook block;
//   - "Kimi" is Moonshot AI's trademark; this fork uses it only nominatively,
//     to name the CLI it drives (`kimi`, `kimi-code`, KIMI_CODE_*), which is
//     NOT renamed: those are the names of Moonshot's program, not ours.
//
// The renaming is mechanical, and this file is its single definition. It is
// used in two ways:
//
//   apply   rewrites files (and file names) in place. Run it on an upstream
//           checkout BEFORE merging it, so upstream arrives already speaking
//           our names and the merge conflicts only where behaviour differs.
//   verify  applies the map to every file of an upstream ref and compares the
//           result with HEAD. A file must come out byte for byte identical
//           unless it is declared in DECLARED_DIVERGENT with the reason. This
//           is what backs the claim in NOTICE that the identity changes alter
//           no behaviour: everything else that differs is listed, with why.
//
// Never run `apply` on this repository's own tree: the code that migrates a
// pre-0.6 install (runtime/hooks/legacy-brand.ts, runtime/legacy-names.ts,
// runtime/paths.ts, runtime/commands/setup.ts) spells upstream's names on
// purpose, and the map would rewrite them into ours. It happened once while
// 0.6.0 was being built; tests/scripts/brand-residue.test.js and
// tests/runtime/legacy-brand.test.ts both fail when it does.
//
// Usage:
//   node scripts/identity-map.mjs apply <file-or-dir>...
//   node scripts/identity-map.mjs verify <upstream-ref>
//
// Exit codes: 0 ok. 1 verify found an undeclared or stale divergence.
//             2 usage or tool error.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Agent, command and Codex skill names that upstream spells kimi-<name>.
const SURFACE_NAMES = "swarm-write|swarm|rescue|review|challenge|ask|pursue|setup|status|result|cancel|replay";

// Order matters: the longer, more specific tokens first.
export const IDENTITY_RULES = Object.freeze([
  { name: "Claude plugin data id", from: /(?<![\w-])kimi-kimi-marketplace(?![\w-])/g, to: "k3-brilia-k3-marketplace" },
  { name: "Codex plugin data id", from: /(?<![\w-])kimi-marketplace-kimi(?![\w-])/g, to: "brilia-k3-marketplace-k3" },
  { name: "plugin id", from: /(?<![\w-])kimi@kimi-marketplace(?![\w-])/g, to: "k3@brilia-k3-marketplace" },
  { name: "marketplace", from: /(?<![\w-])kimi-marketplace(?![\w-])/g, to: "brilia-k3-marketplace" },
  { name: "Codex plugin directory", from: /(?<![\w-])kimi-codex(?![\w-])/g, to: "k3-codex" },
  { name: "slash commands", from: /\/kimi:/g, to: "/k3:" },
  {
    name: "agents and Codex skills",
    from: new RegExp(`(?<![\\w.-])kimi-(${SURFACE_NAMES})(?![\\w-])`, "g"),
    to: "k3-$1",
  },
  { name: "environment variables", from: /(?<!\w)KIMI_PLUGIN_CC_/g, to: "K3_PLUGIN_CC_" },
  // Not when it names the upstream repository or its npm package: this fork is
  // not on npm, so on npm that name is only ever upstream's.
  {
    name: "product name",
    from: /(?<![\w-])(?<!linxule\/)(?<!package\/)(?<!npm package `)(?<!npx )(?<!npm publish )kimi-plugin-cc(?!` on npm)/g,
    to: "k3-plugin-cc",
  },
  {
    name: "command display names",
    from: /(?<![\w-])Kimi (?=(?:Ask|Review|Challenge|Rescue|Pursue|Swarm|Session)\b)/g,
    to: "K3 ",
  },
  { name: "command display name template", from: /`Kimi \$\{/g, to: "`K3 ${" },
  // The plugin's review gate, a feature of ours. "Kimi review" alone stays: it
  // says that Kimi (the model) reviews.
  { name: "review gate", from: /(?<![\w-])Kimi (?=review gate\b)/g, to: "K3 " },
]);

// Upstream files kept verbatim, upstream's names included, under a fork note:
// they describe upstream's own npm releases, where only upstream's names are
// true. `apply` leaves them alone. Paths relative to the root being mapped.
export const KEEP_VERBATIM = Object.freeze(["docs/registry-releases.md"]);

export function applyIdentityMap(text) {
  let out = text;
  for (const rule of IDENTITY_RULES) out = out.replace(rule.from, rule.to);
  return out;
}

// Files that differ from upstream for a reason other than the identity map.
// Keys are paths in THIS repository. The compiled counterparts of a runtime
// file (dist/**.js and plugins/k3-codex/dist/**.js) follow their source.
export const DECLARED_DIVERGENT = Object.freeze({
  // Behaviour: Windows compatibility (NOTICE kind 1).
  "runtime/hooks/install-paths.ts": "Windows: hook command quoting, path normalisation (NOTICE 1)",
  "runtime/commands/setup.ts": "Windows shell probe (NOTICE 1); brand migration of the hook block and data directory (NOTICE 6)",
  "tests/runtime/install-paths.test.ts": "tests of the Windows changes (NOTICE 1)",
  // Behaviour: reliability fix (NOTICE kind 5).
  "runtime/job-store.ts": "busy_timeout before WAL (NOTICE 5)",
  "runtime/jobs.ts": "the wait keeps polling past a busy store (NOTICE 5)",
  "runtime/commands/repair-sessions.ts": "busy_timeout on the read-only connection (NOTICE 5)",
  // Behaviour: brand migration and self-recognition (NOTICE kind 6).
  "runtime/plugin-data.ts": "recognises this fork's install layout (plugin k3), not upstream's (NOTICE 6)",
  "runtime/paths.ts": "data directory k3-plugin-cc with the legacy directory as fallback (NOTICE 6)",
  "runtime/hooks/legacy-brand.ts": "added: finds this fork's pre-0.6 hook blocks so setup can migrate them (NOTICE 6)",
  "runtime/legacy-names.ts": "added: reports the old variables and moves the old data directory (NOTICE 6)",
  "tests/runtime/legacy-brand.test.ts": "added: tests of the brand migration (NOTICE 6)",
  "tests/runtime/plugin-data.test.ts": "tests of the fork's install layout (NOTICE 6)",
  "tests/runtime/plugin-data-installed.test.ts": "tests of the fork's install layout (NOTICE 6)",
  // Version, identity metadata and packaging (NOTICE kinds 2 and 4).
  "runtime/version.ts": "fork version string",
  "package.json": "private, not on npm, points to this repository (NOTICE 4)",
  ".github/workflows/ci.yml": "CI also on staging/** (NOTICE 4)",
  ".claude-plugin/plugin.json": "fork description",
  ".claude-plugin/marketplace.json": "fork description",
  ".agents/plugins/marketplace.json": "fork display name",
  "plugins/k3-codex/.codex-plugin/plugin.json": "fork description (generated from scripts/surface-registry.ts)",
  "scripts/surface-registry.ts": "fork descriptions, links and pinned manifest hashes",
  "tests/runtime/codex-surfaces.test.ts": "plugin and marketplace names are bare words the map does not touch",
  // Additions (NOTICE kind 3).
  "NOTICE": "added: attribution and modification notice",
  "scripts/identity-map.mjs": "added: this file",
  "scripts/promote-to-main.mjs": "added: maintainer script (NOTICE 3)",
  "tests/scripts/promote-to-main.test.js": "added (NOTICE 3)",
  "tests/scripts/identity-map.test.js": "added (NOTICE 3)",
  "tests/scripts/brand-residue.test.js": "added: fails when an upstream name reappears (NOTICE 3)",
  "tests/runtime/job-store-busy-open.test.ts": "added (NOTICE 5)",
  "tests/helpers/hold-exclusive-lock.ts": "added (NOTICE 5)",
  "tests/helpers/open-job-store-node.mjs": "added (NOTICE 5)",
  "tests/manual/enforcement-matrix.mjs": "added (NOTICE 3)",
  "tests/manual/shell-probe-discrimination.mjs": "added (NOTICE 3)",
  // Documentation written or rewritten for the fork.
  "README.md": "fork documentation",
  "CHANGELOG.md": "fork entries; upstream entries kept as history, with upstream names",
  "AGENTS.md": "fork maintainer notes",
  "SECURITY.md": "fork reporting address",
  "ROADMAP-TO-GA.md": "fork note",
  "docs/registry-releases.md": "fork note on top of upstream's page, kept verbatim (KEEP_VERBATIM)",
});

// Upstream files this fork deliberately does not carry.
export const DECLARED_REMOVED = Object.freeze({
  ".github/workflows/publish.yml": "this fork is not published to npm (NOTICE 4)",
});

const COMPILED = [
  [/^dist\/(.+)\.js$/, "runtime/$1.ts"],
  [/^plugins\/k3-codex\/dist\/(.+)\.js$/, "runtime/$1.ts"],
];

export function declaredReason(repoPath) {
  if (DECLARED_DIVERGENT[repoPath]) return DECLARED_DIVERGENT[repoPath];
  for (const [re, to] of COMPILED) {
    if (re.test(repoPath)) {
      const source = repoPath.replace(re, to);
      if (DECLARED_DIVERGENT[source]) return `${DECLARED_DIVERGENT[source]} (compiled)`;
    }
  }
  return undefined;
}

function isText(buffer) {
  return !buffer.includes(0);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
}

// verify: returns { identical, problems } where problems lists undeclared
// divergences, stale declarations and undeclared additions or removals. Our
// side is the working tree (tracked and untracked, ignored files excluded), so
// it can run before a commit.
export function verify(repo, upstreamRef) {
  const upstreamFiles = git(repo, ["ls-tree", "-r", "--name-only", upstreamRef]).toString("utf8").split("\n").filter(Boolean);
  const listed = git(repo, ["ls-files", "--cached", "--others", "--exclude-standard"]).toString("utf8").split("\n").filter(Boolean);
  const headFiles = new Set(listed.filter((file) => existsSync(path.join(repo, file))));
  const problems = [];
  const seen = new Set();
  let identical = 0;
  for (const upstreamPath of upstreamFiles) {
    const ours = applyIdentityMap(upstreamPath);
    seen.add(ours);
    if (!headFiles.has(ours)) {
      if (!DECLARED_REMOVED[upstreamPath]) problems.push(`removed without a declaration: ${upstreamPath}`);
      continue;
    }
    const upstreamBytes = git(repo, ["show", `${upstreamRef}:${upstreamPath}`]);
    const headBytes = readFileSync(path.join(repo, ours));
    const expected = isText(upstreamBytes) ? Buffer.from(applyIdentityMap(upstreamBytes.toString("utf8")), "utf8") : upstreamBytes;
    const same = Buffer.compare(expected, headBytes) === 0;
    const reason = declaredReason(ours);
    if (same) {
      identical += 1;
      if (reason) problems.push(`declared divergent but identical after the map (stale declaration): ${ours}`);
    } else if (!reason) {
      problems.push(`differs from upstream after the map, and is not declared: ${ours}`);
    }
  }
  for (const ours of headFiles) {
    if (seen.has(ours)) continue;
    if (!declaredReason(ours)) problems.push(`added without a declaration: ${ours}`);
  }
  for (const declared of Object.keys(DECLARED_DIVERGENT)) {
    if (!headFiles.has(declared)) problems.push(`declared but not in this tree (stale declaration): ${declared}`);
  }
  return { identical, problems };
}

// Collects files and the directories BELOW each target (a target itself is
// never renamed: the caller chose that path).
function walk(target, files, dirs, isTarget) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const base = path.basename(target);
    if (base === ".git" || base === "node_modules") return;
    if (!isTarget) dirs.push(target);
    for (const entry of readdirSync(target)) walk(path.join(target, entry), files, dirs, false);
    return;
  }
  if (stat.isFile()) files.push(target);
}

// apply: rewrites contents, then renames the files and directories whose name
// the map changes, deepest first so a renamed directory never strands a child.
export function apply(targets) {
  const files = [];
  const dirs = [];
  for (const target of targets) walk(target, files, dirs, true);
  let rewritten = 0;
  let kept = 0;
  for (const file of files) {
    const slashed = path.resolve(file).replace(/\\/g, "/");
    if (KEEP_VERBATIM.some((keep) => slashed.endsWith(`/${keep}`))) {
      kept += 1;
      continue;
    }
    const bytes = readFileSync(file);
    if (!isText(bytes)) continue;
    const before = bytes.toString("utf8");
    const after = applyIdentityMap(before);
    if (after !== before) {
      writeFileSync(file, after, "utf8");
      rewritten += 1;
    }
  }
  let renamed = 0;
  const depth = (p) => path.resolve(p).split(path.sep).length;
  for (const entry of [...files, ...dirs].sort((a, b) => depth(b) - depth(a))) {
    const base = path.basename(entry);
    const mapped = applyIdentityMap(base);
    if (mapped !== base) {
      renameSync(entry, path.join(path.dirname(entry), mapped));
      renamed += 1;
    }
  }
  return { files: files.length, rewritten, renamed, kept };
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "apply" && rest.length > 0) {
    const result = apply(rest);
    console.log(
      `identity-map apply: ${result.files} files read, ${result.rewritten} rewritten, ${result.renamed} renamed, ` +
        `${result.kept} kept verbatim (${KEEP_VERBATIM.join(", ")}).`,
    );
    return 0;
  }
  if (mode === "verify" && rest.length === 1) {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { identical, problems } = verify(repo, rest[0]);
    console.log(`identity-map verify against ${rest[0]}: ${identical} files identical after the map.`);
    for (const problem of problems) console.log(`  ${problem}`);
    if (problems.length > 0) {
      console.log(`${problems.length} problem(s). Declare real divergences in DECLARED_DIVERGENT with the reason, or fix the map.`);
      return 1;
    }
    console.log("Every other difference is declared, with its reason.");
    return 0;
  }
  console.error("usage: node scripts/identity-map.mjs apply <file-or-dir>... | verify <upstream-ref>");
  return 2;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (invokedDirectly()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`identity-map: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
