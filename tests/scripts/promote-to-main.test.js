// BRILIA fork: tests for scripts/promote-to-main.mjs, the maintainer gate that
// moves main. Pure logic plus one real git repository in a temp dir; no
// network, no GitHub API, no push. Written as .js because the script is plain
// Node ESM and the TypeScript project does not allowJs.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CI_DEFINING_PATHSPECS,
  PromoteError,
  firstUnacceptedFailedAttempt,
  isStagingBranch,
  parseArgs,
  repoFromRemoteUrl,
  reviewFlagMatches,
  sameScript,
} from "../../scripts/promote-to-main.mjs";

const SHA = "35d14f16f90072f5b04915e9d2810373cf2a3ba4";

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof PromoteError) return error.exitCode;
    throw error;
  }
  return 0;
}

describe("parseArgs", () => {
  test("accepts the documented forms", () => {
    const o = parseArgs(["staging/x", "--dry-run", `--ci-change-reviewed=${SHA}`, "--accept-failed-attempts=123", "--remote", "brilia"]);
    expect(o).toEqual({ branch: "staging/x", dryRun: true, ciReviewed: SHA, acceptFailedAttempts: "123", remote: "brilia" });
  });
  test("a mistyped flag is a usage error, never a silent real push", () => {
    expect(codeOf(() => parseArgs(["staging/x", "--dryrun"]))).toBe(2);
    expect(codeOf(() => parseArgs(["staging/x", "-n"]))).toBe(2);
    expect(codeOf(() => parseArgs(["staging/x", "--remote=brilia"]))).toBe(2);
  });
  test("missing or flag-looking option values are usage errors", () => {
    expect(codeOf(() => parseArgs(["staging/x", "--remote"]))).toBe(2);
    expect(codeOf(() => parseArgs(["staging/x", "--remote", "--dry-run"]))).toBe(2);
  });
  test("one source branch only, and it must be staging/...", () => {
    expect(codeOf(() => parseArgs(["staging/a", "staging/b"]))).toBe(2);
    expect(codeOf(() => parseArgs([]))).toBe(2);
    expect(codeOf(() => parseArgs(["main"]))).toBe(1);
    expect(codeOf(() => parseArgs(["staging/../main"]))).toBe(1);
  });
  test("the review flag needs the full 40-character SHA", () => {
    expect(codeOf(() => parseArgs(["staging/x", "--ci-change-reviewed=35d14f1"]))).toBe(2);
    expect(codeOf(() => parseArgs(["staging/x", "--ci-change-reviewed=zz"]))).toBe(2);
  });
});

describe("helpers", () => {
  test("isStagingBranch", () => {
    expect(isStagingBranch("staging/2.0.7-brilia.0.5.1")).toBe(true);
    for (const bad of ["main", "staging/", "staging/a..b", "staging/x.lock", "stagingx/y", "staging/a b"]) {
      expect(isStagingBranch(bad)).toBe(false);
    }
  });
  test("reviewFlagMatches is exact equality with a full SHA", () => {
    expect(reviewFlagMatches(SHA, SHA)).toBe(true);
    expect(reviewFlagMatches(SHA.slice(0, 12), SHA)).toBe(false);
    expect(reviewFlagMatches(null, SHA)).toBe(false);
    expect(reviewFlagMatches(SHA.replace(/^3/, "4"), SHA)).toBe(false);
  });
  test("sameScript ignores CRLF and nothing else", () => {
    expect(sameScript(Buffer.from("a\r\nb\r\n"), Buffer.from("a\nb\n"))).toBe(true);
    expect(sameScript(Buffer.from("a\nb\n"), Buffer.from("a\nc\n"))).toBe(false);
    expect(sameScript(Buffer.from("a\nb"), Buffer.from("a\nb\n"))).toBe(false);
  });
  test("repoFromRemoteUrl", () => {
    expect(repoFromRemoteUrl("https://github.com/Brilia-it/k3-plugin-cc.git")).toBe("Brilia-it/k3-plugin-cc");
    expect(repoFromRemoteUrl("git@github.com:Brilia-it/k3-plugin-cc.git")).toBe("Brilia-it/k3-plugin-cc");
    expect(repoFromRemoteUrl("https://gitlab.com/a/b.git")).toBe(null);
  });
  test("a green latest attempt does not hide a failed earlier one", () => {
    const attempts = [
      { run_attempt: 1, conclusion: "failure" },
      { run_attempt: 2, conclusion: "failure" },
      { run_attempt: 3, conclusion: "success" },
    ];
    expect(firstUnacceptedFailedAttempt(36433783375, attempts, null)?.run_attempt).toBe(1);
    expect(firstUnacceptedFailedAttempt(36433783375, attempts, "36433783375")).toBe(null);
    expect(firstUnacceptedFailedAttempt(1, [{ run_attempt: 1, conclusion: "success" }], null)).toBe(null);
  });
});

describe("CI_DEFINING_PATHSPECS against a real git repository", () => {
  test("catches every CI-defining file, including any root tsconfig*.json, and nothing else", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "promote-pathspec-"));
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid");
      git("config", "user.name", "t");
      git("config", "core.autocrlf", "false");
      writeFileSync(path.join(dir, "README.md"), "x\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      const files = {
        ".github/workflows/ci.yml": true,
        "package.json": true,
        "bun.lock": true,
        "bunfig.toml": true,
        "tsconfig.json": true,
        "tsconfig.build.json": true,
        "tsconfig.anything.json": true,
        "scripts/promote-to-main.mjs": true,
        "scripts/other.ts": true,
        "runtime/job-store.ts": false,
        "runtime/tsconfig.json": false,
        "tests/runtime/x.test.ts": false,
        "README.md": false,
      };
      for (const rel of Object.keys(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), `changed ${rel}\n`);
      }
      git("add", "-A");
      git("commit", "-q", "-m", "change");
      const touched = new Set(git("diff", "--name-only", base, "HEAD", "--", ...CI_DEFINING_PATHSPECS).split("\n").filter(Boolean));
      for (const [rel, expected] of Object.entries(files)) {
        expect([rel, touched.has(rel)]).toEqual([rel, expected]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
