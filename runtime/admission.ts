// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.7.0. Not an upstream file.
//
// One model job at a time, REFUSE never queue (2026-10-15 incident: three jobs ran in
// parallel and burnt one Kimi 5-hour window together).
//
// Scope, stated plainly: this looks at ONE job store, that is one data directory. It
// does not see Codex or Claude Code running against another data directory, nor a
// native interactive `kimi`.
//
// Review 0.7.0 and round 3:
//   - which rows count: EVERY running row except review-gate rows. There is no time-based
//     expiry. A row cannot strand the guard because it always has an owner pid: foreground
//     rows carry the command's pid, background rows start owned by the LAUNCHER and are
//     handed to the worker by compare-and-set (JobStore.claimRunningJobPid). The stale-job
//     sweep, which runs before every check, fails a row whose owner is dead, and
//     `/k3:cancel` can act on a starting row. A worker that loses the compare-and-set
//     (row swept or cancelled) makes no model call.
//   - atomic admission: the early check in the commands is only a fast path; the final
//     check runs inside the same write-locked transaction as the row insert
//     (JobStore.createJob with an `admission` argument).
import { RuntimeError } from "./errors.js";
import type { JobRecord, JobStore } from "./job-store.js";

export interface Admission {
  commandType: string;
  allowConcurrent?: boolean;
}

/** The running rows that block a new model job: every one except review-gate rows. */
export function blockingJobs(running: readonly JobRecord[]): JobRecord[] {
  return running.filter((job) => job.command_type !== "review_gate");
}

export function buildAlreadyRunningError(commandType: string, blocking: readonly JobRecord[]): RuntimeError {
  const describe = (job: JobRecord): string =>
    `${job.job_id} (${job.command_type}, started ${job.created_at}${
      job.pid === null && job.kimi_pid === null
        ? "; no recorded process, probably left by an older plugin version, so it cannot be swept or cancelled: --allow-concurrent ignores it"
        : ""
    })`;
  const list = blocking.map(describe).join("; ");
  return new RuntimeError(
    `${commandType.toUpperCase()}_JOB_ALREADY_RUNNING`,
    `Not starting ${commandType}: ${blocking.length === 1 ? "another Kimi model job is" : `${blocking.length} other Kimi model jobs are`} already running: ${list}. ` +
      "Why: the Kimi subscription quota is call volume in a rolling 5-hour window, so parallel jobs burn it together, " +
      "and Kimi's community guidelines describe the subscription as personal interactive use and say enforcement may include limiting concurrent access. " +
      "This plugin refuses instead of queueing: nothing was started or scheduled. " +
      "Follow the running job with /k3:status <job-id>, wait for it and read /k3:result <job-id>, " +
      "or pass --allow-concurrent to override this refusal for this one call. " +
      "Scope: this only sees jobs in this plugin data directory, not Codex, another data directory, or a native interactive kimi.",
    `${commandType}.concurrency`,
    { details: { running_job_ids: blocking.map((job) => job.job_id) } },
  );
}

/** Throws when a counted job is running. Used for the early fast check and inside the insert transaction. */
export function assertNoModelJobRunning(
  store: JobStore,
  commandType: string,
  allowConcurrent: boolean | undefined,
  exceptJobId?: string,
): void {
  if (allowConcurrent) {
    return;
  }
  const blocking = blockingJobs(store.listRunningJobs().filter((job) => job.job_id !== exceptJobId));
  if (blocking.length === 0) {
    return;
  }
  throw buildAlreadyRunningError(commandType, blocking);
}
