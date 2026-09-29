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
//           result with the working tree. A file must come out byte for byte
//           identical unless it is declared in DECLARED_DIVERGENT with the
//           reason. What that proves, and what it does not: every difference
//           from upstream is either the map or a declared file. It does NOT
//           prove the map right (a rule that renames too much or too little is
//           applied the same way to both sides), and it does not look inside a
//           declared file. tests/scripts/brand-residue.test.js covers the first
//           gap for upstream's names; review covers the rest.
//
// A rule renames a TOKEN wherever it appears, so a sentence that names
// upstream's ids ("upstream keeps kimi-marketplace") comes out false. So the
// map never touches prose that has to spell them: README.md, CHANGELOG.md and
// NOTICE at the root are this fork's own text, and `apply` leaves upstream's
// version of them as it is (MERGED_BY_HAND): a person reads upstream's change
// and writes it into ours. The lines of ours that spell upstream's ids are
// pinned one by one in the residue test. In every other file the rule is
// right: there upstream's marketplace, commands and variables are the ones
// that become ours.
//
// Never run `apply` on this repository's own tree: the code that migrates a
// pre-0.6 install (runtime/hooks/legacy-brand.ts, runtime/legacy-names.ts,
// runtime/paths.ts, runtime/commands/setup.ts) spells upstream's names on
// purpose, and the map would rewrite them into ours. It happened once while
// 0.6.0 was being built; tests/scripts/brand-residue.test.js and
// tests/runtime/legacy-brand.test.ts both fail when it does.
//
// Usage:
//   node scripts/identity-map.mjs apply [--dry-run] <file-or-dir>...
//   node scripts/identity-map.mjs verify <upstream-ref>
//
// `apply` treats as text only a file that decodes as strict UTF-8 without NUL
// bytes; anything else is left byte for byte. It refuses, before writing
// anything, when a rename would land on a path that already exists.
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
  // The plugin directory inside an install path: .../<marketplace>/kimi/<version>/.
  // Runs after the marketplace rule, so it sees the marketplace already renamed.
  { name: "plugin directory in install paths", from: /(?<=brilia-k3-marketplace[/\\])kimi(?=[/\\])/g, to: "k3" },
  // The same layout written with the documentation's placeholder.
  { name: "plugin directory after <marketplace>", from: /(?<=<marketplace>[/\\])kimi(?=[/\\])/g, to: "k3" },
  { name: "Claude data id with <marketplace>", from: /(?<![\w-])kimi-<marketplace>/g, to: "k3-<marketplace>" },
  { name: "Codex data id with <marketplace>", from: /<marketplace>-kimi(?![\w-])/g, to: "<marketplace>-k3" },
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

// This fork's own prose at the root: `apply` leaves upstream's version of these
// files as it is, and a person merges its changes by hand (see the top of this
// file). Paths relative to the root being mapped, matched exactly: a
// README.md deeper in the tree is mapped as usual.
export const MERGED_BY_HAND = Object.freeze(["README.md", "CHANGELOG.md", "NOTICE"]);

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
  "tests/scripts/brand-residue.pins.json": "added: the lines allowed to keep an upstream name (NOTICE 6)",
  "tests/runtime/job-store-busy-open.test.ts": "added (NOTICE 5)",
  "tests/helpers/hold-exclusive-lock.ts": "added (NOTICE 5)",
  "tests/helpers/open-job-store-node.mjs": "added (NOTICE 5)",
  "tests/helpers/hold-write-lock.ts": "added (NOTICE 6)",
  "tests/manual/coexistence-smoke.mjs": "added (NOTICE 3)",
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

export function declaredReason(repoPath, declared = DECLARED_DIVERGENT) {
  if (declared[repoPath]) return declared[repoPath];
  for (const [re, to] of COMPILED) {
    if (re.test(repoPath)) {
      const source = repoPath.replace(re, to);
      if (declared[source]) return `${declared[source]} (compiled)`;
    }
  }
  return undefined;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

// The text of a file, or null when it is not text: a NUL byte, or bytes that
// are not valid UTF-8 (decoding those loosely and writing them back would
// replace them and corrupt the file).
export function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return STRICT_UTF8.decode(buffer);
  } catch {
    return null;
  }
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
}

// verify: returns { identical, problems } where problems lists undeclared
// divergences, stale declarations and undeclared additions or removals. Our
// side is the working tree (tracked and untracked, ignored files excluded), so
// it can run before a commit. `declared` and `removed` default to this
// repository's lists; tests pass their own.
export function verify(repo, upstreamRef, { declared = DECLARED_DIVERGENT, removed = DECLARED_REMOVED } = {}) {
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
      if (!removed[upstreamPath]) problems.push(`removed without a declaration: ${upstreamPath}`);
      continue;
    }
    const upstreamBytes = git(repo, ["show", `${upstreamRef}:${upstreamPath}`]);
    const headBytes = readFileSync(path.join(repo, ours));
    const text = decodeText(upstreamBytes);
    const expected = text === null ? upstreamBytes : Buffer.from(applyIdentityMap(text), "utf8");
    const same = Buffer.compare(expected, headBytes) === 0;
    const reason = declaredReason(ours, declared);
    if (same) {
      identical += 1;
      if (reason) problems.push(`declared divergent but identical after the map (stale declaration): ${ours}`);
    } else if (!reason) {
      problems.push(`differs from upstream after the map, and is not declared: ${ours}`);
    }
  }
  for (const ours of headFiles) {
    if (seen.has(ours)) continue;
    if (!declaredReason(ours, declared)) problems.push(`added without a declaration: ${ours}`);
  }
  for (const file of Object.keys(declared)) {
    if (!headFiles.has(file)) problems.push(`declared but not in this tree (stale declaration): ${file}`);
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
// Every rename is checked BEFORE anything is written: if a destination already
// exists (on disk, or as the destination of another rename), nothing changes.
// With `dryRun`, it only reports what it would do.
export function apply(targets, { dryRun = false } = {}) {
  const files = [];
  const dirs = [];
  // Each file's path relative to the target it was found under, with forward
  // slashes: what KEEP_VERBATIM and MERGED_BY_HAND are matched against.
  const relativeOf = new Map();
  for (const target of targets) {
    const before = files.length;
    walk(target, files, dirs, true);
    const isDir = lstatSync(target).isDirectory();
    for (const file of files.slice(before)) {
      relativeOf.set(file, (isDir ? path.relative(target, file) : path.basename(file)).replace(/\\/g, "/"));
    }
  }
  const notMapped = new Set([...KEEP_VERBATIM, ...MERGED_BY_HAND]);

  const depth = (p) => path.resolve(p).split(path.sep).length;
  const renames = [];
  for (const entry of [...files, ...dirs].sort((a, b) => depth(b) - depth(a))) {
    const base = path.basename(entry);
    const mapped = applyIdentityMap(base);
    if (mapped !== base) renames.push([entry, path.join(path.dirname(entry), mapped)]);
  }
  // Destinations are checked as they will be when each rename runs: parents are
  // renamed after their children, so the destination's directory is the source's.
  const collisions = [];
  const claimed = new Set();
  for (const [, to] of renames) {
    const key = process.platform === "win32" ? to.toLowerCase() : to;
    if (existsSync(to) || claimed.has(key)) collisions.push(to);
    claimed.add(key);
  }
  if (collisions.length > 0) {
    throw new Error(`refusing to rename onto existing paths, nothing was changed: ${collisions.join(", ")}`);
  }

  let rewritten = 0;
  let kept = 0;
  let binary = 0;
  for (const file of files) {
    if (notMapped.has(relativeOf.get(file))) {
      kept += 1;
      continue;
    }
    const before = decodeText(readFileSync(file));
    if (before === null) {
      binary += 1;
      continue;
    }
    const after = applyIdentityMap(before);
    if (after !== before) {
      if (!dryRun) writeFileSync(file, after, "utf8");
      rewritten += 1;
    }
  }
  if (!dryRun) for (const [from, to] of renames) renameSync(from, to);
  return { files: files.length, rewritten, renamed: renames.length, kept, binary, dryRun, renames };
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "apply") {
    const dryRun = rest[0] === "--dry-run";
    const targets = dryRun ? rest.slice(1) : rest;
    if (targets.length === 0 || targets.some((t) => t.startsWith("--"))) {
      console.error("usage: node scripts/identity-map.mjs apply [--dry-run] <file-or-dir>...");
      return 2;
    }
    const result = apply(targets, { dryRun });
    if (dryRun) for (const [from, to] of result.renames) console.log(`  would rename ${from} -> ${to}`);
    console.log(
      `identity-map apply${dryRun ? " (dry run, nothing written)" : ""}: ${result.files} files read, ` +
        `${result.rewritten} ${dryRun ? "would be rewritten" : "rewritten"}, ${result.renamed} ` +
        `${dryRun ? "would be renamed" : "renamed"}, ${result.binary} left as binary, ${result.kept} not mapped ` +
        `(${[...KEEP_VERBATIM, ...MERGED_BY_HAND].join(", ")}).` +
        (result.kept > 0 ? ` Merge upstream's changes to ${MERGED_BY_HAND.join(", ")} by hand.` : ""),
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
  console.error("usage: node scripts/identity-map.mjs apply [--dry-run] <file-or-dir>... | verify <upstream-ref>");
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
