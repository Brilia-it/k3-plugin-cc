#!/usr/bin/env node
// BRILIA fork: promote a CI-verified staging commit to main.
//
// WHY THIS EXISTS
//
// The `main` ruleset requires a green `check` from GitHub Actions on a commit
// before main may point at it. That rule alone certifies "some Actions job named
// `check` passed on this SHA, in its latest attempt", not "this repository's CI
// passed on it":
//
//   - on a push, the workflow that runs is the one INSIDE the pushed commit, and
//     so are package.json scripts, test config and this script: a commit that
//     weakens any of them certifies itself;
//   - a pull request from an external fork runs a workflow the contributor wrote,
//     and its green `check` lands on the PR's head SHA;
//   - a re-run that goes green hides the failed attempts before it (on
//     2026-09-28 a commit was promoted on its third attempt, after two failures
//     that turned out to be a real race, not noise).
//
// This script is the procedure that narrows those gaps, executed rather than
// remembered. It moves main only when ALL of these hold, and refuses otherwise:
//
//   1. it is itself the copy on main (same content, line endings aside), so a
//      candidate commit cannot bring a weaker version of it; if main has no copy,
//      it refuses;
//   2. the source is a `staging/...` branch of the remote, and the GitHub
//      repository is the one that remote points to;
//   3. main is an ancestor of it (fast-forward only, never a rewrite);
//   4. every check run named `check` on that SHA belongs to a completed,
//      successful run of .github/workflows/ci.yml triggered by a PUSH to that
//      staging branch, and EVERY attempt of that run succeeded, not only the
//      last one (override: --accept-failed-attempts=<run id>, for a failure you
//      have understood);
//   5. the commits being promoted do not touch what defines CI (see
//      CI_DEFINING_PATHSPECS), unless --ci-change-reviewed=<full 40-char sha>
//      names exactly the commit whose diff you read.
//
// What it cannot do: stop someone with write access from pushing to main by
// hand. The ruleset allows any fast-forward with a green `check`; this script
// is the discipline on top of it, not a replacement for it.
//
// Usage:
//   node scripts/promote-to-main.mjs staging/<name> [--dry-run]
//        [--ci-change-reviewed=<sha>] [--accept-failed-attempts=<run id>]
//        [--remote <name>]
//
// Exit codes: 0 promoted, or already there and green, or dry run OK.
//             1 refused. 2 usage or tool error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Everything whose change alters what "CI passed" means. Git pathspecs.
export const CI_DEFINING_PATHSPECS = Object.freeze([
  ".github/",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  ":(glob)tsconfig*.json",
  "scripts/",
]);
export const SELF_PATH_IN_REPO = "scripts/promote-to-main.mjs";

export class PromoteError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}
const usage = (message) => new PromoteError(2, message);
const refuse = (message) => new PromoteError(1, `refused: ${message}`);

// ---------------------------------------------------------------- pure helpers (tested)

export function parseArgs(argv) {
  const opts = { branch: null, dryRun: false, ciReviewed: null, acceptFailedAttempts: null, remote: "brilia" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--ci-change-reviewed=")) opts.ciReviewed = a.slice("--ci-change-reviewed=".length);
    else if (a.startsWith("--accept-failed-attempts=")) opts.acceptFailedAttempts = a.slice("--accept-failed-attempts=".length);
    else if (a === "--remote") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) throw usage("--remote needs a remote name");
      opts.remote = v;
      i += 1;
    } else if (a.startsWith("-")) throw usage(`unknown option "${a}"`);
    else if (opts.branch !== null) throw usage(`one source branch only; got "${opts.branch}" and "${a}"`);
    else opts.branch = a;
  }
  if (!opts.branch) {
    throw usage("usage: node scripts/promote-to-main.mjs staging/<name> [--dry-run] [--ci-change-reviewed=<sha>] [--accept-failed-attempts=<run id>] [--remote <name>]");
  }
  if (opts.ciReviewed !== null && !/^[0-9a-f]{40}$/.test(opts.ciReviewed)) {
    throw usage("--ci-change-reviewed needs the full 40-character SHA of the commit whose diff you read");
  }
  if (opts.acceptFailedAttempts !== null && !/^[0-9]+$/.test(opts.acceptFailedAttempts)) {
    throw usage("--accept-failed-attempts needs a numeric run id");
  }
  if (!isStagingBranch(opts.branch)) throw refuse(`source must be a staging/... branch, got "${opts.branch}"`);
  return opts;
}

export function isStagingBranch(name) {
  return /^staging\/[A-Za-z0-9._\/-]+$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock");
}

// Same script, line endings aside: a CRLF checkout of the same commit is the
// same gatekeeper and must not be refused for it.
export function sameScript(running, onMain) {
  const norm = (b) => Buffer.from(b).toString("utf8").replace(/\r\n/g, "\n");
  return norm(running) === norm(onMain);
}

export function reviewFlagMatches(flag, sha) {
  return typeof flag === "string" && /^[0-9a-f]{40}$/.test(flag) && flag === sha;
}

export function repoFromRemoteUrl(url) {
  const m = String(url).trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Given a run's attempts (1..n, latest last), the first failed attempt that is
// not explicitly accepted, or null when every attempt succeeded.
export function firstUnacceptedFailedAttempt(runId, attempts, acceptedRunId) {
  if (String(runId) === acceptedRunId) return null;
  return attempts.find((a) => a.conclusion !== "success") ?? null;
}

// ---------------------------------------------------------------- effects

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw usage(`${cmd} ${args.join(" ")} failed: ${(error.stderr || error.message || "").toString().trim()}`);
  }
}
function runBuffer(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  const ghJson = (path) => JSON.parse(run("gh", ["api", path]));

  // 2. remote and repository
  const remotes = run("git", ["remote"]).split(/\s+/);
  if (!remotes.includes(opts.remote)) throw usage(`no git remote named "${opts.remote}" (have: ${remotes.join(", ")})`);
  const repo = repoFromRemoteUrl(run("git", ["remote", "get-url", "--push", opts.remote]));
  if (!repo) throw usage(`remote "${opts.remote}" does not point to a GitHub repository`);

  // 3. fresh refs
  run("git", ["fetch", opts.remote, `+refs/heads/main:refs/remotes/${opts.remote}/main`, `+refs/heads/${opts.branch}:refs/remotes/${opts.remote}/${opts.branch}`]);
  const sha = run("git", ["rev-parse", `refs/remotes/${opts.remote}/${opts.branch}`]);
  const mainSha = run("git", ["rev-parse", `refs/remotes/${opts.remote}/main`]);

  // 1. this script is main's copy
  const mainCopy = runBuffer("git", ["show", `${mainSha}:${SELF_PATH_IN_REPO}`]);
  if (mainCopy === null) throw refuse(`main (${mainSha.slice(0, 7)}) has no ${SELF_PATH_IN_REPO}; there is no gatekeeper to run`);
  if (!sameScript(readFileSync(fileURLToPath(import.meta.url)), mainCopy)) {
    throw refuse(`this script differs from the copy on main (${mainSha.slice(0, 7)}). A candidate commit must not bring its own gatekeeper.\n` +
      `Run main's copy: git show ${mainSha.slice(0, 7)}:${SELF_PATH_IN_REPO} > promote-main.mjs && node promote-main.mjs ${opts.branch} ...`);
  }

  // 4. CI provenance
  function greenCiRuns(targetSha, branch) {
    const runsResp = ghJson(`repos/${repo}/actions/runs?head_sha=${targetSha}&per_page=100`);
    const runs = runsResp.workflow_runs ?? [];
    if ((runsResp.total_count ?? runs.length) > runs.length) throw refuse(`more than ${runs.length} workflow runs on ${targetSha.slice(0, 7)}; not reading a partial list`);
    const qualifying = runs.filter(
      (r) => r.path === ".github/workflows/ci.yml" && r.event === "push" && r.head_branch === branch &&
        r.status === "completed" && r.conclusion === "success",
    );
    if (qualifying.length === 0) {
      const seen = runs.map((r) => `${r.path} ${r.event} ${r.head_branch} ${r.status}/${r.conclusion}`).join("; ") || "none";
      return { ok: false, why: `no successful push run of .github/workflows/ci.yml on ${branch} for ${targetSha.slice(0, 7)} (runs seen: ${seen})` };
    }
    for (const r of qualifying) {
      const attempts = [];
      for (let n = 1; n <= (r.run_attempt ?? 1); n += 1) attempts.push(ghJson(`repos/${repo}/actions/runs/${r.id}/attempts/${n}`));
      const bad = firstUnacceptedFailedAttempt(r.id, attempts, opts.acceptFailedAttempts);
      if (bad) {
        return { ok: false, why: `run ${r.id}: attempt ${bad.run_attempt} concluded "${bad.conclusion}" (latest: ${r.conclusion} on attempt ${r.run_attempt}). ` +
          `Find out why before promoting; if the failure is understood, pass --accept-failed-attempts=${r.id}` };
      }
    }
    return { ok: true, qualifying };
  }

  if (sha === mainSha) {
    const onMain = greenCiRuns(sha, "main");
    if (!onMain.ok) throw refuse(`main is already at ${sha.slice(0, 7)}, but its CI on main is not clean: ${onMain.why}`);
    console.log(`main is already at ${sha.slice(0, 7)} and its push CI on main is green; nothing to promote.`);
    return 0;
  }
  if (runBuffer("git", ["merge-base", "--is-ancestor", mainSha, sha]) === null) {
    throw refuse(`main (${mainSha.slice(0, 7)}) is not an ancestor of ${opts.branch} (${sha.slice(0, 7)}); only fast-forwards are promoted`);
  }
  const green = greenCiRuns(sha, opts.branch);
  if (!green.ok) throw refuse(green.why);
  const okSuites = new Set(green.qualifying.map((r) => r.check_suite_id));
  const checksResp = ghJson(`repos/${repo}/commits/${sha}/check-runs?check_name=check&filter=all&per_page=100`);
  const checks = checksResp.check_runs ?? [];
  if ((checksResp.total_count ?? checks.length) > checks.length) throw refuse(`more than ${checks.length} check runs on ${sha.slice(0, 7)}; not reading a partial list`);
  if (checks.length === 0) throw refuse(`no check run named "check" on ${sha.slice(0, 7)}`);
  for (const c of checks) {
    if (c.app?.slug !== "github-actions") throw refuse(`a "check" on ${sha.slice(0, 7)} comes from app "${c.app?.slug}", not github-actions`);
    if (!okSuites.has(c.check_suite?.id)) throw refuse(`a "check" on ${sha.slice(0, 7)} (suite ${c.check_suite?.id}, ${c.conclusion}) does not belong to a qualifying ci.yml push run on ${opts.branch}`);
  }

  // 5. changes to what defines CI
  const touched = run("git", ["diff", "--name-only", mainSha, sha, "--", ...CI_DEFINING_PATHSPECS]);
  if (touched && !reviewFlagMatches(opts.ciReviewed, sha)) {
    throw refuse(`the commits being promoted change what defines CI, and such a change certifies itself on push.\n` +
      `Read the diff (git diff ${mainSha.slice(0, 7)} ${sha.slice(0, 7)} -- ${CI_DEFINING_PATHSPECS.join(" ")}), ` +
      `then re-run with --ci-change-reviewed=${sha}.\n` +
      `Changed: ${touched.split("\n").join(", ")}`);
  }

  console.log(`OK: ${opts.branch} ${sha.slice(0, 7)} fast-forwards main ${mainSha.slice(0, 7)} on ${repo}; ` +
    `${checks.length} check run(s), all from ci.yml push run(s) ${green.qualifying.map((r) => r.id).join(", ")}, every attempt green.`);
  if (touched) console.log(`CI-defining changes reviewed at ${sha.slice(0, 12)}: ${touched.split("\n").join(", ")}`);
  if (opts.dryRun) {
    console.log("Dry run: main not moved.");
    return 0;
  }
  // Push the verified SHA, not the branch: a later push to staging cannot slip in.
  run("git", ["push", opts.remote, `${sha}:refs/heads/main`]);
  const after = run("git", ["ls-remote", opts.remote, "refs/heads/main"]).split(/\s+/)[0];
  if (after !== sha) throw usage(`push reported success but remote main is ${after}, expected ${sha}`);
  console.log(`Promoted: main is now ${sha.slice(0, 7)}. CI now runs on main as well: re-run this script with the ` +
    `same branch to verify main's own run once it completes.`);
  return 0;
}

// Run only when executed, not when imported by the tests. Compared as paths, and
// case-insensitively on Windows: a URL comparison can miss on drive-letter case
// and would make the script exit 0 having done nothing.
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
    if (error instanceof PromoteError) {
      console.error(`promote-to-main: ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      throw error;
    }
  }
}
