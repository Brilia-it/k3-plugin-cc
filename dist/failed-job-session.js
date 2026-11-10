import { resolveKimiHome } from "./kimi-home.js";
import { recoverSessionIdFromStore } from "./session-recovery.js";
const NONE = { sessionId: null, source: null };
export async function keepFailedJobSession(store, job, result, env) {
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
    }
    catch {
        // The original failure matters more than the session metadata.
    }
    return NONE;
}
