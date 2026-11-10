// BRILIA fork: regression tests for opening the job store while another process
// holds the database, and for `--wait` riding out that contention.
//
// `--background --wait` polls by constructing a NEW JobStore on every tick
// (jobs.ts waitForTerminalJob), concurrently with the detached worker writing
// the same file. The constructor used to set `journal_mode = WAL` BEFORE
// `busy_timeout`, so that first pragma ran with SQLite's default timeout of 0
// and failed at once with SQLITE_BUSY whenever the other side held a lock: the
// wait threw JOB_STORE_BUSY and the parent printed nothing. That is the
// intermittent CI failure of "a background ask completes" and "a REAL spawned
// background worker verifies the hook" seen on 2026-09-28.
//
// The contention is made deterministic: a child process holds an EXCLUSIVE lock
// and records when it acquired it and when it started releasing it. The test
// proves the open STARTED while the lock was held and FINISHED only after the
// release began, i.e. it waited on the busy handler rather than slipping in
// after the fact. It runs twice: in-process under the test runner (bun:sqlite)
// and from the compiled runtime under plain Node (node:sqlite), which is what
// the installed plugin uses. On the old pragma order both fail with
// JOB_STORE_BUSY (checked before the fix).
import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { RuntimeError } from "../../runtime/errors.js";
import type { JobRecord, JobStore as JobStoreType } from "../../runtime/job-store.js";
import { JobStore } from "../../runtime/job-store.js";
import { waitForTerminalJob } from "../../runtime/jobs.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const HOLDER = path.resolve(import.meta.dir, "../helpers/hold-exclusive-lock.ts");
const NODE_OPENER = path.resolve(import.meta.dir, "../helpers/open-job-store-node.mjs");
const DIST = path.resolve(import.meta.dir, "../../dist");
const HOLD_MS = 1500;

async function withLockHeld(
  name: string,
  openWhileLocked: (root: string) => Promise<{ ok: boolean; code: string | null; start: number; end: number }>,
): Promise<void> {
  const root = await createTestPluginDataRoot(name);
  let holderExit: Promise<number | null> = Promise.resolve(null);
  try {
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: root });
    await ensurePluginPaths(paths);
    const marker = path.join(root, "lock-held");

    const holder = spawn(process.execPath, [HOLDER, paths.stateDbPath, marker, String(HOLD_MS)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let holderStderr = "";
    holder.stderr?.on("data", (chunk) => {
      holderStderr += String(chunk);
    });
    holderExit = new Promise<number | null>((resolve) => holder.on("exit", resolve));

    const waitStart = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - waitStart > 10_000) throw new Error(`lock holder never started: ${holderStderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(holder.exitCode).toBe(null); // still holding right before we open

    const result = await openWhileLocked(root);

    expect(await holderExit).toBe(0);
    const releaseStart = Number(readFileSync(`${marker}.release`, "utf8"));
    // Opened while the lock was held, and returned only after the release began:
    // it waited on the busy handler. Anything else is not the case under test.
    expect(result.code ?? "opened").toBe("opened");
    expect(result.ok).toBe(true);
    expect(result.start).toBeLessThan(releaseStart);
    expect(result.end).toBeGreaterThanOrEqual(releaseStart);
    expect(result.end - result.start).toBeLessThan(5000); // within busy_timeout
  } finally {
    // On Windows the holder's open handle blocks deletion: let it exit first.
    await holderExit;
    await cleanupTestPath(root);
  }
}

function hasNodeSqlite(): boolean {
  try {
    execFileSync("node", ["-e", "require('node:sqlite')"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("JobStore open under contention", () => {
  test("bun:sqlite: waits for a lock held by another process instead of failing with SQLITE_BUSY", async () => {
    await withLockHeld("job-store-busy-open-bun", async (root) => {
      const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: root });
      const start = Date.now();
      try {
        new JobStore(paths).close();
        return { ok: true, code: null, start, end: Date.now() };
      } catch (error) {
        return { ok: false, code: String((error as { code?: string }).code ?? error), start, end: Date.now() };
      }
    });
  });

  test("node:sqlite, compiled runtime: the same wait under plain Node", async () => {
    if (!existsSync(path.join(DIST, "job-store.js"))) throw new Error("dist/ is not built: run `bun run build` first");
    if (!hasNodeSqlite()) throw new Error("`node` with node:sqlite (Node >= 22.5) is required for this test");
    await withLockHeld("job-store-busy-open-node", async (root) => {
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn("node", [NODE_OPENER, DIST, root], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += String(c)));
        child.stderr.on("data", (c) => (stderr += String(c)));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`node opener exited ${code}: ${stderr}`))));
      });
      const line = out.trim().split("\n").pop() ?? "";
      return JSON.parse(line);
    });
  });
});

describe("waitForTerminalJob under contention", () => {
  const done = { job_id: "j1", status: "completed" } as unknown as JobRecord;

  test("a busy store is polled again instead of failing the wait", async () => {
    let calls = 0;
    const factory = (): JobStoreType => {
      calls += 1;
      if (calls <= 2) throw new RuntimeError("JOB_STORE_BUSY", "database is locked", "test");
      return { getJob: () => done, close: () => {} } as unknown as JobStoreType;
    };
    const job = await waitForTerminalJob(factory, "j1", 10_000);
    expect(job.status).toBe("completed");
    expect(calls).toBe(3);
  });

  test("a busy query is polled again too", async () => {
    let calls = 0;
    const factory = (): JobStoreType => {
      calls += 1;
      return {
        getJob: () => {
          if (calls === 1) throw new Error("SQLiteError: database is locked");
          return done;
        },
        close: () => {},
      } as unknown as JobStoreType;
    };
    const job = await waitForTerminalJob(factory, "j1", 10_000);
    expect(job.status).toBe("completed");
    expect(calls).toBe(2);
  });

  test("any other error still fails the wait", async () => {
    const factory = (): JobStoreType => {
      throw new RuntimeError("JOB_STORE_CORRUPT", "not a database", "test");
    };
    await expect(waitForTerminalJob(factory, "j1", 10_000)).rejects.toThrow("not a database");
  });
});
