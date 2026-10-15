// MODIFIED BY BRILIA (unofficial fork of linxule/kimi-plugin-cc, Apache-2.0).
// One change, on every platform: waitForTerminalJob retries a busy job store until
// its deadline instead of failing the whole wait. See NOTICE and README.md.
// Section 4(b) of the License requires this notice.
import { createHash } from "node:crypto";

import { RuntimeError } from "./errors.js";
import type { JobRecord, JobStore } from "./job-store.js";
import type { PluginPaths } from "./paths.js";
import { renderTerminalJobArtifact, writeArtifact } from "./render.js";
import type { JobError } from "./types.js";

export function digestPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function normalizeJobError(error: unknown): JobError {
  if (error instanceof RuntimeError) {
    const normalized: JobError = {
      code: error.code,
      message: error.message,
      stage: error.stage,
    };
    if (Object.keys(error.details).length > 0) {
      normalized.details = error.details;
    }
    return normalized;
  }

  if (error instanceof Error) {
    return {
      code: "UNEXPECTED_ERROR",
      message: error.message,
      stage: "runtime",
    };
  }

  return {
    code: "UNEXPECTED_ERROR",
    message: String(error),
    stage: "runtime",
  };
}

export async function markJobFailed(
  store: JobStore,
  paths: PluginPaths,
  job: JobRecord,
  error: unknown,
  summary = "Job failed.",
  options?: { phase?: string | null },
): Promise<JobRecord> {
  const normalized = normalizeJobError(error);
  const phase = options?.phase;
  const artifactJob = {
    ...job,
    status: "failed" as const,
    summary,
    error: normalized,
    final_output_path: null,
    pid: null,
    kimi_pid: null,
    ...(phase !== undefined ? { phase } : {}),
  };
  const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));

  return (
    store.markFailed(job.job_id, {
      summary,
      error: normalized,
      final_output_path: artifactPath,
      ...(phase !== undefined ? { phase } : {}),
    }) ?? artifactJob
  );
}

export async function markJobCancelled(
  store: JobStore,
  paths: PluginPaths,
  job: JobRecord,
  summary: string,
  error?: unknown,
  options?: { phase?: string | null },
): Promise<JobRecord> {
  const normalized = error ? normalizeJobError(error) : null;
  const phase = options?.phase;
  const artifactJob = {
    ...job,
    status: "cancelled" as const,
    summary,
    error: normalized,
    final_output_path: null,
    pid: null,
    kimi_pid: null,
    ...(phase !== undefined ? { phase } : {}),
  };
  const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));

  return (
    store.markCancelled(job.job_id, {
      summary,
      error: normalized,
      final_output_path: artifactPath,
      ...(phase !== undefined ? { phase } : {}),
    }) ?? artifactJob
  );
}

/**
 * BRILIA fork (2026-10-15 incident): one model job at a time, REFUSE never queue.
 *
 * Three read-only analysis jobs ran in parallel and ended together on the same
 * Kimi 5-hour usage limit. The quota is call volume in a rolling window, so
 * parallel jobs burn it together, and Kimi's community guidelines describe the
 * subscription as personal interactive use and say enforcement may include
 * limiting concurrent access. Call this AFTER sweepStaleJobs (a dead job must
 * not block) and BEFORE creating the new job. The Stop-hook review gate does not
 * call it. `--allow-concurrent` skips the refusal for that one call.
 */
export function assertNoModelJobRunning(
  store: JobStore,
  commandType: string,
  allowConcurrent: boolean | undefined,
): void {
  if (allowConcurrent) {
    return;
  }
  const running = store.listRunningJobs();
  if (running.length === 0) {
    return;
  }
  const list = running
    .map((job) => `${job.job_id} (${job.command_type}, started ${job.created_at})`)
    .join("; ");
  throw new RuntimeError(
    `${commandType.toUpperCase()}_JOB_ALREADY_RUNNING`,
    `Not starting ${commandType}: ${running.length === 1 ? "another Kimi model job is" : `${running.length} other Kimi model jobs are`} already running: ${list}. ` +
      "Why: the Kimi subscription quota is call volume in a rolling 5-hour window, so parallel jobs burn it together, " +
      "and Kimi's community guidelines describe the subscription as personal interactive use and say enforcement may include limiting concurrent access. " +
      "This plugin refuses instead of queueing: nothing was started or scheduled. " +
      "Follow the running job with /k3:status <job-id>, wait for it and read /k3:result <job-id>, " +
      "or pass --allow-concurrent to override this refusal for this one call.",
    `${commandType}.concurrency`,
    { details: { running_job_ids: running.map((job) => job.job_id) } },
  );
}

export async function sweepStaleJobs(store: JobStore, paths: PluginPaths): Promise<void> {
  for (const job of store.listRunningJobsWithProcessHints()) {
    if (!isStaleEnoughToSweep(job)) {
      continue;
    }

    const companionMissing = job.pid !== null && !isPidAlive(job.pid);
    const kimiMissing = job.kimi_pid !== null && !isPidAlive(job.kimi_pid);

    if (job.background) {
      if (!companionMissing && !kimiMissing) {
        continue;
      }

      terminateRecordedProcesses(job);
      await markJobFailed(
        store,
        paths,
        job,
        new RuntimeError(
          companionMissing ? "WORKER_DISAPPEARED" : "KIMI_PROCESS_DISAPPEARED",
          companionMissing
            ? `Background worker pid ${job.pid} is no longer running.`
            : `Kimi pid ${job.kimi_pid} is no longer running while background worker pid ${job.pid} is still recorded.`,
          "jobs.sweep",
        ),
        companionMissing
          ? "Background worker disappeared before reporting a terminal state."
          : "Kimi process disappeared before reporting a terminal state.",
        job.command_type === "ask" || job.command_type === "rescue" ? { phase: "failed" } : undefined,
      );
      continue;
    }

    if (!companionMissing && !kimiMissing) {
      continue;
    }

    // Sweep-vs-live-companion race fix: if the foreground companion pid is
    // still alive, the companion process is microseconds-to-seconds away
    // from writing its own terminal state. SIGTERMing it here would kill
    // its render path mid-flight (and from a sibling shell's read-only
    // /k3:status, no less). Skip — let the companion finish on its own.
    if (!companionMissing && job.pid !== null) {
      continue;
    }

    terminateRecordedProcesses(job);
    await markJobFailed(
      store,
      paths,
      job,
      new RuntimeError(
        "FOREGROUND_PROCESS_DISAPPEARED",
        describeMissingForegroundProcess(job, companionMissing, kimiMissing),
        "jobs.sweep",
      ),
      "Foreground Kimi job disappeared before reporting a terminal state.",
      job.command_type === "ask" || job.command_type === "rescue" ? { phase: "failed" } : undefined,
    );
  }
}

const STALE_SWEEP_GRACE_MS = 15_000;

function isStaleEnoughToSweep(job: JobRecord): boolean {
  const updatedAt = Date.parse(job.updated_at);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS;
}

function describeMissingForegroundProcess(
  job: JobRecord,
  companionMissing: boolean,
  kimiMissing: boolean,
): string {
  if (companionMissing && kimiMissing) {
    return `Foreground companion pid ${job.pid} and Kimi pid ${job.kimi_pid} are no longer running.`;
  }
  if (companionMissing) {
    return `Foreground companion pid ${job.pid} is no longer running.`;
  }
  return `Kimi pid ${job.kimi_pid} is no longer running.`;
}

function terminateRecordedProcesses(job: JobRecord): void {
  const pids = new Set<number>();
  if (job.pid !== null) pids.add(job.pid);
  if (job.kimi_pid !== null) pids.add(job.kimi_pid);

  for (const pid of pids) {
    if (!isPidAlive(pid)) {
      continue;
    }
    killPid(pid, "SIGTERM");
    // SIGKILL escalation: if the process ignores SIGTERM (stuck Kimi child,
    // uninterruptible sleep, signal mask), force-kill after 2s. The job is
    // already determined stale at this point, so leaving a survivor running
    // would just orphan resources. Timer is unref'd so it doesn't keep the
    // process alive.
    const timer = setTimeout(() => {
      if (isPidAlive(pid)) {
        killPid(pid, "SIGKILL");
      }
    }, 2_000);
    timer.unref();
  }
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: process already gone. EPERM: pid was likely reused by an
    // unrelated process we don't own — silently skip.
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: no such process — definitively dead.
    // EPERM: process exists but we can't signal it. We treat this as "dead
    // for our purposes" because it most likely means the pid was reused by
    // an unrelated higher-privilege process. The companion stores its own
    // pid in v0.2.2+; under normal usage we should always have permission
    // to signal our own descendants. Returning true here lets stale jobs
    // hide forever (the sweeper relies on isPidAlive=false to flip them to
    // failed). signalJobProcesses and killPid already swallow EPERM
    // consistently — this brings the read path in line with the write path.
    if (code === "ESRCH" || code === "EPERM") {
      return false;
    }
    return true;
  }
}

export async function waitForTerminalJob(
  storeFactory: () => JobStore,
  jobId: string,
  timeoutMs = 60_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // BRILIA fork: a busy database is a reason to poll again, not to fail. The
    // detached worker writes the same file this loop reads; JobStore already
    // waits up to its busy_timeout, and contention longer than that is retried
    // here until the wait's own deadline instead of aborting the whole --wait.
    let store: JobStore;
    try {
      store = storeFactory();
    } catch (error) {
      if (!isJobStoreBusy(error)) throw error;
      await sleep(200);
      continue;
    }
    try {
      const job = store.getJob(jobId);
      if (job && job.status !== "running") {
        return job;
      }
    } catch (error) {
      if (!isJobStoreBusy(error)) throw error;
    } finally {
      store.close();
    }

    await sleep(200);
  }

  throw new RuntimeError(
    "JOB_WAIT_TIMEOUT",
    // BRILIA fork (2026-10-15): the old text said the worker "may" still be running,
    // and a caller loop took the timeout for the end of the job and started the
    // next one in parallel. The job is STILL RUNNING: say so, and say what not to do.
    `Stopped waiting after ${timeoutMs}ms, but job ${jobId} is STILL RUNNING; the wait ended, the job did not. Do not start another model job now: it would run in parallel with this one and burn the same Kimi quota. Use /k3:status ${jobId} to follow it and /k3:result ${jobId} once it completes.`,
    "jobs.wait",
  );
}

// BRILIA fork: JobStore translates SQLITE_BUSY into RuntimeError JOB_STORE_BUSY on
// open; a raw driver error can still surface from a query, so both are matched.
export function isJobStoreBusy(error: unknown): boolean {
  if (error instanceof RuntimeError && error.code === "JOB_STORE_BUSY") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
