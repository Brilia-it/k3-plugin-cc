// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.7.0. Not an upstream file.
//
// 2026-10-15 incident: three read-only ask jobs stopped on Kimi's 5-hour usage limit
// after reading a lot of material. Their job rows had kimi_session_id = null, although
// kimi had created the sessions on disk, so the work could not be resumed once the
// window rolled over: a retry started from zero.
//
// Two causes are handled here and in the commands' failure path:
//   1. kimi may announce the session id (stdout meta record on native v2, stderr
//      "To resume this session" on legacy) and exit non-zero afterwards. The commands
//      used to throw on the exit code BEFORE persisting the announced id. They now
//      persist it first (that is the commands' part, not this file).
//   2. If kimi announced nothing, the id is recovered from kimi's own session index,
//      conservatively, and only then.
//
// Safety rules of the index recovery (nothing else is ever read from kimi's home):
//   - only `<kimi home>/session_index.jsonl` is read, never a session directory,
//     never credentials or config.toml; the home comes from resolveKimiHome;
//   - only the `sessionId` and `workDir` fields of each line are looked at;
//   - an id is accepted ONLY if exactly one entry appeared between the snapshot taken
//     before the spawn and the one taken after the failure, and its workDir equals the
//     job's cwd (separators and, on Windows paths, case normalised);
//   - zero or several candidates leave the id null (a parallel interactive kimi in the
//     same folder makes it ambiguous, and guessing would resume someone else's session).
import { open, stat } from "node:fs/promises";
import path from "node:path";

import { resolveKimiHome } from "./kimi-home.js";

const SESSION_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_LINE_MAX_BYTES = 1024 * 1024;

export interface SessionIndexSnapshot {
  /** False when the index could not be read at all (missing, too large, unreadable). */
  readable: boolean;
  /** sessionId -> normalised workDir, for every well-formed line. */
  entries: Map<string, string>;
}

export type SessionRecoveryOutcome =
  | { sessionId: string; source: "announced" | "index" }
  | { sessionId: null; reason: "no-baseline" | "index-unreadable" | "none-new" | "ambiguous" };

/** Normalise a folder path for comparison: separators, trailing slash, and case for Windows-style paths. */
export function normalizeWorkDir(input: string): string {
  let value = input.trim().replaceAll("\\", "/");
  const windowsStyle = /^[a-zA-Z]:\//.test(value) || value.startsWith("//");
  value = path.posix.normalize(value);
  while (value.length > 1 && value.endsWith("/")) {
    value = value.slice(0, -1);
  }
  return windowsStyle || process.platform === "win32" ? value.toLowerCase() : value;
}

function isSafeSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\p{Cc}]/u.test(value)
  );
}

export async function snapshotSessionIndex(env: NodeJS.ProcessEnv, cwd: string): Promise<SessionIndexSnapshot> {
  const indexPath = path.join(resolveKimiHome(env, cwd), "session_index.jsonl");
  const entries = new Map<string, string>();
  let text: string;
  try {
    const info = await stat(indexPath);
    if (!info.isFile() || info.size > SESSION_INDEX_MAX_BYTES) {
      return { readable: false, entries };
    }
    const handle = await open(indexPath, "r");
    try {
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A missing index is a normal state before kimi has ever created a session.
    return { readable: (error as NodeJS.ErrnoException).code === "ENOENT", entries };
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || Buffer.byteLength(trimmed, "utf8") > SESSION_INDEX_LINE_MAX_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const candidate = parsed as { sessionId?: unknown; workDir?: unknown };
    if (!isSafeSessionId(candidate.sessionId) || typeof candidate.workDir !== "string") continue;
    entries.set(candidate.sessionId, normalizeWorkDir(candidate.workDir));
  }
  return { readable: true, entries };
}

/**
 * Pick the session this job created, or null. `before` is the snapshot taken just
 * before the spawn; the snapshot after the failure is taken here.
 */
export async function recoverSessionFromIndex(
  before: SessionIndexSnapshot | null,
  env: NodeJS.ProcessEnv,
  jobCwd: string,
): Promise<SessionRecoveryOutcome> {
  if (before === null) return { sessionId: null, reason: "no-baseline" };
  if (!before.readable) return { sessionId: null, reason: "index-unreadable" };
  const after = await snapshotSessionIndex(env, jobCwd);
  if (!after.readable) return { sessionId: null, reason: "index-unreadable" };
  const wanted = normalizeWorkDir(jobCwd);
  const candidates: string[] = [];
  for (const [sessionId, workDir] of after.entries) {
    if (before.entries.has(sessionId)) continue;
    if (workDir === wanted) candidates.push(sessionId);
  }
  if (candidates.length === 1) return { sessionId: candidates[0]!, source: "index" };
  return { sessionId: null, reason: candidates.length === 0 ? "none-new" : "ambiguous" };
}

/**
 * Decide the kimi session id a FAILED job should keep: the announced one if kimi
 * announced one, else the index recovery. Pure policy; the caller persists it.
 */
export async function resolveFailedJobSession(options: {
  announcedSessionId: string | undefined;
  baseline: SessionIndexSnapshot | null;
  env: NodeJS.ProcessEnv;
  jobCwd: string;
}): Promise<SessionRecoveryOutcome> {
  if (options.announcedSessionId !== undefined && isSafeSessionId(options.announcedSessionId)) {
    return { sessionId: options.announcedSessionId, source: "announced" };
  }
  return recoverSessionFromIndex(options.baseline, options.env, options.jobCwd);
}
