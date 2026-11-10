// BRILIA fork (k3-plugin-cc), added in 2.5.6-brilia.0.1.0. Not an upstream file.
//
// 2026-10-15 incident: three read-only ask jobs stopped on Kimi's 5-hour usage limit
// after reading a lot of material. Their job rows had kimi_session_id = null although
// kimi had created the sessions, so the work done before the refusal could not be
// resumed: a retry started from zero.
//
// Upstream keeps a session id on a FAILED job only on a budget timeout
// (captureTimeoutPartialOutput in commands/cli-helpers.ts). A non-zero exit, which is
// how a usage limit ends, throws CLI_NONZERO_EXIT before the announced id is stored.
// This module keeps it on that branch too, with the same two sources and the same
// provenance upstream already records (kimi_session_id_source, upstream 2.2.0):
//
//   - "announced": the id kimi itself announced for THIS child (stdout meta record on
//     native v2, stderr "To resume this session" on legacy). Stored as is.
//   - "recovered_session_dir": only when nothing was announced, on native v2 with an
//     observed engine, through upstream's own recoverSessionIdFromStore, which binds a
//     session to this spawn by cwd, time window AND the digest of the exact prompt,
//     and stored with upstream's claimRecoveredSessionId.
//
// In 0.7.0 this fork instead offered, in the quota message only, an UNVERIFIED
// candidate read from kimi's session_index.jsonl (runtime/kimi-session-recovery.ts).
// Upstream's prompt-digest proof is stronger than that hint, so that file is not
// carried onto 2.5.6.
//
// Never throws: failing here must not hide the original failure.
import type { CliClientResult } from "./cli-client.js";
import type { JobRecord, JobStore } from "./job-store.js";
import { resolveKimiHome } from "./kimi-home.js";
import { recoverSessionIdFromStore } from "./session-recovery.js";

export interface KeptFailedSession {
  sessionId: string | null;
  source: JobRecord["kimi_session_id_source"];
}

const NONE: KeptFailedSession = { sessionId: null, source: null };

export async function keepFailedJobSession(
  store: JobStore,
  job: JobRecord,
  result: CliClientResult,
  env: NodeJS.ProcessEnv,
): Promise<KeptFailedSession> {
  if (job.kimi_session_id !== null) {
    return { sessionId: job.kimi_session_id, source: job.kimi_session_id_source };
  }
  try {
    const announced = result.sessionId;
    if (announced !== undefined && announced.length > 0) {
      // Never persist an empty id: NULL represents a missing session id.
      const updated = store.updateRunningJob(job.job_id, {
        kimi_session_id: announced,
        kimi_session_id_source: "announced",
      });
      return updated?.kimi_session_id === announced ? { sessionId: announced, source: "announced" } : NONE;
    }
    if (job.intended_engine === "native-v2" && result.observedEngine !== null) {
      const recovered = await recoverSessionIdFromStore({
        kimiHome: resolveKimiHome(env, job.cwd),
        cwd: job.cwd,
        spawnedAt: result.spawnedAt,
        settledAt: result.settledAt,
        promptDigest: job.prompt_digest,
        store,
        jobId: job.job_id,
      });
      if (recovered.sessionId) {
        const updated = store.claimRecoveredSessionId(job.job_id, recovered.sessionId);
        if (updated?.kimi_session_id === recovered.sessionId) {
          return { sessionId: recovered.sessionId, source: "recovered_session_dir" };
        }
      }
    }
  } catch {
    // The original failure matters more than the session metadata.
  }
  return NONE;
}
