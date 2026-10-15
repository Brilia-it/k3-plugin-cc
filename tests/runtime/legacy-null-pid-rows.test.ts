import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { JobStore } from "../../runtime/job-store.js";
import { assertNoModelJobRunning } from "../../runtime/jobs.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

// Round 3 follow-up: a `running` non-review-gate row with NO pid and NO kimi_pid can only
// be a leftover of an older plugin version (0.7.0 rows are born with an owner pid). It can
// be neither swept nor cancelled, so opening the store reconciles it to failed.
function seed(db: Database, id: string, commandType: string, pid: number | null): void {
  db.query(
    `INSERT INTO jobs (job_id, repo_id, command_type, created_at, updated_at, cwd, background, pid, kimi_pid, status,
       agent_profile, prompt_digest, summary, stream_log_path)
     VALUES (?, 'repo-x', ?, '2026-04-14T10:00:00.000Z', '2026-04-14T10:00:00.000Z', '/tmp', 1, ?, NULL, 'running',
       'read-only', 'digest', 'Running.', '/tmp/x.jsonl')`,
  ).run(id, commandType, pid);
}

describe("legacy null-PID running rows are reconciled on open", () => {
  test("a null-pid ask row becomes failed (JOB_STORE_ORPHANED_ON_UPGRADE) and no longer blocks; review-gate and pid rows are untouched", async () => {
    const root = await createTestPluginDataRoot("legacy-null-pid");
    try {
      const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: root });
      await ensurePluginPaths(paths);
      new JobStore(paths).close();

      const db = new Database(paths.stateDbPath);
      seed(db, "legacy-ask", "ask", null);
      seed(db, "legacy-rescue", "rescue", null);
      seed(db, "gate-row", "review_gate", null);
      seed(db, "owned-row", "ask", process.pid);
      db.close();

      const store = new JobStore(paths);
      try {
        for (const id of ["legacy-ask", "legacy-rescue"]) {
          const row = store.getJob(id);
          expect(row?.status).toBe("failed");
          expect(row?.error?.code).toBe("JOB_STORE_ORPHANED_ON_UPGRADE");
          expect(row?.error?.message).toContain("older plugin version");
        }
        expect(store.getJob("gate-row")?.status).toBe("running");
        expect(store.getJob("owned-row")?.status).toBe("running");
        // The guard sees only the row that has an owner.
        expect(() => assertNoModelJobRunning(store, "ask", false)).toThrow(/owned-row/);
        store.markFailed("owned-row", { summary: "done", error: null });
        expect(() => assertNoModelJobRunning(store, "ask", false)).not.toThrow();
      } finally {
        store.close();
      }

      // Idempotent: opening again changes nothing further.
      const again = new JobStore(paths);
      try {
        expect(again.getJob("legacy-ask")?.status).toBe("failed");
        expect(again.getJob("gate-row")?.status).toBe("running");
      } finally {
        again.close();
      }
    } finally {
      await cleanupTestPath(root);
    }
  }, 30_000);
});
