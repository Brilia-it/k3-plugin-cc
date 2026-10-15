// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.7.0. Not an upstream file.
//
// One model job at a time, REFUSE never queue (2026-10-15 incident: three jobs ran in
// parallel and burnt one Kimi 5-hour window together).
//
// Scope, stated plainly: this looks at ONE job store, that is one data directory. It
// does not see Codex or Claude Code running against another data directory, nor a
// native interactive `kimi`.
//
// Review 0.7.0:
//   - which rows count (finding 2): a running row with a pid or kimi_pid counts, the
//     sweeper handles dead ones; a running row with NEITHER (a job still starting)
//     counts only within a startup grace, otherwise it is an orphan that can never be
//     swept or cancelled and must not block forever ("stale, not counted"); review-gate
//     rows never count;
//   - atomic admission (finding 3): the early check in the commands is only a fast path;
//     the final check runs inside the same write-locked transaction as the row insert
//     (JobStore.createJob with an `admission` argument).
import { RuntimeError } from "./errors.js";
/** A running row with no pid and no kimi_pid blocks only this long after its last sign of life. */
export const STARTUP_GRACE_MS = 120_000;
export function partitionRunningJobs(running, nowMs = Date.now()) {
    const blocking = [];
    const stale = [];
    for (const job of running) {
        if (job.command_type === "review_gate") {
            continue;
        }
        if (job.pid !== null || job.kimi_pid !== null) {
            blocking.push(job);
            continue;
        }
        const lastSeen = Math.max(Date.parse(job.created_at) || 0, Date.parse(job.updated_at) || 0);
        if (nowMs - lastSeen <= STARTUP_GRACE_MS) {
            blocking.push(job);
        }
        else {
            stale.push(job);
        }
    }
    return { blocking, stale };
}
export function buildAlreadyRunningError(commandType, blocking, stale) {
    const list = blocking.map((job) => `${job.job_id} (${job.command_type}, started ${job.created_at})`).join("; ");
    const staleNote = stale.length > 0
        ? ` Also marked running but with no process and older than ${STARTUP_GRACE_MS / 1000} s: ${stale
            .map((job) => `${job.job_id} (stale, not counted)`)
            .join("; ")}.`
        : "";
    return new RuntimeError(`${commandType.toUpperCase()}_JOB_ALREADY_RUNNING`, `Not starting ${commandType}: ${blocking.length === 1 ? "another Kimi model job is" : `${blocking.length} other Kimi model jobs are`} already running: ${list}.${staleNote} ` +
        "Why: the Kimi subscription quota is call volume in a rolling 5-hour window, so parallel jobs burn it together, " +
        "and Kimi's community guidelines describe the subscription as personal interactive use and say enforcement may include limiting concurrent access. " +
        "This plugin refuses instead of queueing: nothing was started or scheduled. " +
        "Follow the running job with /k3:status <job-id>, wait for it and read /k3:result <job-id>, " +
        "or pass --allow-concurrent to override this refusal for this one call. " +
        "Scope: this only sees jobs in this plugin data directory, not Codex, another data directory, or a native interactive kimi.", `${commandType}.concurrency`, { details: { running_job_ids: blocking.map((job) => job.job_id), stale_job_ids: stale.map((job) => job.job_id) } });
}
/** Throws when a counted job is running. Used for the early fast check and inside the insert transaction. */
export function assertNoModelJobRunning(store, commandType, allowConcurrent, nowMs = Date.now(), exceptJobId) {
    if (allowConcurrent) {
        return;
    }
    const { blocking, stale } = partitionRunningJobs(store.listRunningJobs().filter((job) => job.job_id !== exceptJobId), nowMs);
    if (blocking.length === 0) {
        return;
    }
    throw buildAlreadyRunningError(commandType, blocking, stale);
}
