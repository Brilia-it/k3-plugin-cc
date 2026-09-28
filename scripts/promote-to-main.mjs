#!/usr/bin/env node
// BRILIA fork: promote a CI-verified staging commit to main.
//
// WHY THIS EXISTS
//
// The `main` ruleset requires a green `check` from GitHub Actions on a commit
// before main may point at it. That rule alone certifies "some Actions job named
// `check` passed on this SHA", not "this repository's CI passed on it":
//
//   - on a push, the workflow that runs is the one INSIDE the pushed commit, so
//     a commit that weakens ci.yml certifies itself;
//   - a pull request from an external fork runs a workflow the contributor wrote,
//     and its green `check` lands on the PR's head SHA.
//
// This script is the procedure that closes those gaps, executed rather than
// remembered. It moves main only when ALL of these hold, and refuses otherwise:
//
//   1. the source is a `staging/...` branch on the remote;
//   2. main is an ancestor of it (fast-forward only, never a rewrite);
//   3. every check run named `check` on that SHA belongs to a completed,
//      successful run of .github/workflows/ci.yml triggered by a PUSH to that
//      same staging branch (so no PR run, no other workflow);
//   4. the commits being promoted do not touch .github/, unless the operator
//      passes --workflow-change-reviewed after reading that diff.
//
// Usage:
//   node scripts/promote-to-main.mjs staging/<name> [--dry-run]
//        [--workflow-change-reviewed] [--remote brilia] [--repo Brilia-it/k3-plugin-cc]
//
// Exit codes: 0 promoted (or already there, or dry-run OK), 1 refused, 2 usage/tool error.

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const branch = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--remote" && argv[argv.indexOf(a) - 1] !== "--repo");
const remote = option("--remote", "brilia");
const repo = option("--repo", "Brilia-it/k3-plugin-cc");
const dryRun = flag("--dry-run");
const workflowReviewed = flag("--workflow-change-reviewed");

function die(code, message) {
  console.error(`promote-to-main: ${message}`);
  process.exit(code);
}
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    die(2, `${cmd} ${args.join(" ")} failed: ${(error.stderr || error.message || "").toString().trim()}`);
  }
}
const gitOk = (args) => {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ghJson = (path) => JSON.parse(run("gh", ["api", path]));

if (!branch) die(2, "usage: node scripts/promote-to-main.mjs staging/<name> [--dry-run] [--workflow-change-reviewed]");
if (!/^staging\/[A-Za-z0-9._\/-]+$/.test(branch)) die(1, `refused: source must be a staging/... branch, got "${branch}"`);

// 1-2. Fresh refs from the remote, fast-forward only.
run("git", ["fetch", remote, `+refs/heads/main:refs/remotes/${remote}/main`, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
const sha = run("git", ["rev-parse", `refs/remotes/${remote}/${branch}`]);
const mainSha = run("git", ["rev-parse", `refs/remotes/${remote}/main`]);
if (sha === mainSha) {
  console.log(`main is already at ${sha.slice(0, 7)}; nothing to promote.`);
  process.exit(0);
}
if (!gitOk(["merge-base", "--is-ancestor", mainSha, sha])) {
  die(1, `refused: main (${mainSha.slice(0, 7)}) is not an ancestor of ${branch} (${sha.slice(0, 7)}); only fast-forwards are promoted`);
}

// 3. Provenance of every `check` on this SHA.
const runs = ghJson(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`).workflow_runs ?? [];
const qualifying = runs.filter(
  (r) => r.path === ".github/workflows/ci.yml" && r.event === "push" && r.head_branch === branch &&
    r.status === "completed" && r.conclusion === "success",
);
if (qualifying.length === 0) {
  const seen = runs.map((r) => `${r.path} ${r.event} ${r.head_branch} ${r.status}/${r.conclusion}`).join("; ") || "none";
  die(1, `refused: no successful push run of .github/workflows/ci.yml on ${branch} for ${sha.slice(0, 7)} (runs seen: ${seen})`);
}
const okSuites = new Set(qualifying.map((r) => r.check_suite_id));
const checks = (ghJson(`repos/${repo}/commits/${sha}/check-runs?check_name=check&per_page=100`).check_runs ?? []);
if (checks.length === 0) die(1, `refused: no check run named "check" on ${sha.slice(0, 7)}`);
for (const c of checks) {
  if (c.app?.slug !== "github-actions") die(1, `refused: a "check" on ${sha.slice(0, 7)} comes from app "${c.app?.slug}", not github-actions`);
  if (!okSuites.has(c.check_suite?.id)) die(1, `refused: a "check" on ${sha.slice(0, 7)} (suite ${c.check_suite?.id}) does not belong to a qualifying ci.yml push run`);
  if (c.conclusion !== "success") die(1, `refused: a "check" on ${sha.slice(0, 7)} concluded "${c.conclusion}"`);
}

// 4. Workflow changes need a human who read them.
const touched = run("git", ["diff", "--name-only", mainSha, sha, "--", ".github/"]);
if (touched && !workflowReviewed) {
  die(1, `refused: the commits being promoted change CI itself, and a workflow change certifies itself on push.\n` +
    `Read the diff (git diff ${mainSha.slice(0, 7)} ${sha.slice(0, 7)} -- .github/), then re-run with --workflow-change-reviewed.\n` +
    `Changed: ${touched.split("\n").join(", ")}`);
}

console.log(`OK: ${branch} ${sha.slice(0, 7)} fast-forwards main ${mainSha.slice(0, 7)}; ${checks.length} check run(s) from ci.yml push run(s) ${qualifying.map((r) => r.id).join(", ")}.`);
if (touched) console.log(`Workflow changes acknowledged as reviewed: ${touched.split("\n").join(", ")}`);
if (dryRun) {
  console.log("Dry run: main not moved.");
  process.exit(0);
}
run("git", ["push", remote, `${sha}:refs/heads/main`]);
const after = run("git", ["ls-remote", remote, "refs/heads/main"]).split(/\s+/)[0];
if (after !== sha) die(2, `push reported success but remote main is ${after}, expected ${sha}`);
console.log(`Promoted: main is now ${sha.slice(0, 7)}.`);
