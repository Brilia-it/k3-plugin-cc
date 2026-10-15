// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.7.0. Not an upstream file.
//
// 2026-10-15 incident: three read-only ask jobs stopped on Kimi's 5-hour usage limit
// after reading a lot of material. Their job rows had kimi_session_id = null, although
// kimi had created the sessions on disk.
//
// Review 0.7.0 (finding 1): a session found in kimi's session index is NOT evidence that
// this job's child created it. An interactive kimi in the same folder, another plugin job,
// or an index rebuild produce the same single "new entry". So an indexed id is never
// stored on the job row, never used for --resume and never used for lineage. It is only
// offered to a human as an UNVERIFIED candidate in the quota message.
//
// What is persisted is only what kimi itself ANNOUNCED for this child (stdout meta record
// on native v2, stderr "To resume this session" on legacy); that is done by the commands
// (see keepFailedJobSession in commands/cli-helpers.ts).
//
// This module is read-only and reads one file, `<kimi home>/session_index.jsonl`
// (home from resolveKimiHome); nothing else in kimi's home, no session directory.
// A candidate is offered ONLY if:
//   - the baseline (before the spawn) and the later snapshot were both read COMPLETELY:
//     a malformed, oversized or unsafe line, or an unreadable file, means no candidate;
//   - exactly one entry is new and its workDir equals the job's cwd (separators and, on
//     Windows paths, case normalised).
import { open, stat } from "node:fs/promises";
import path from "node:path";

import { resolveKimiHome } from "./kimi-home.js";

const SESSION_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_LINE_MAX_BYTES = 1024 * 1024;
const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface SessionIndexSnapshot {
  /** True only when the whole index was read and every line was well formed. */
  complete: boolean;
  /** sessionId -> normalised workDir, for every well-formed line. */
  entries: Map<string, string>;
}

export type SessionCandidateOutcome =
  | { candidate: string }
  | { candidate: null; reason: "no-baseline" | "incomplete-index" | "none-new" | "ambiguous" };

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

export async function snapshotSessionIndex(env: NodeJS.ProcessEnv, cwd: string): Promise<SessionIndexSnapshot> {
  const indexPath = path.join(resolveKimiHome(env, cwd), "session_index.jsonl");
  const entries = new Map<string, string>();
  let text: string;
  try {
    const info = await stat(indexPath);
    if (!info.isFile() || info.size > SESSION_INDEX_MAX_BYTES) {
      return { complete: false, entries };
    }
    const handle = await open(indexPath, "r");
    try {
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A missing index is a normal state before kimi has ever created a session.
    return { complete: (error as NodeJS.ErrnoException).code === "ENOENT", entries };
  }

  let complete = true;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, "utf8") > SESSION_INDEX_LINE_MAX_BYTES) {
      complete = false;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      complete = false;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      complete = false;
      continue;
    }
    const entry = parsed as { sessionId?: unknown; workDir?: unknown };
    if (typeof entry.sessionId !== "string" || !CANDIDATE_ID_RE.test(entry.sessionId) || typeof entry.workDir !== "string") {
      complete = false;
      continue;
    }
    entries.set(entry.sessionId, normalizeWorkDir(entry.workDir));
  }
  return { complete, entries };
}

/**
 * The one session that appeared in the index for the job's folder since `before`, as a
 * hint for a human. NEVER proof of ownership; callers must not store or resume it.
 */
export async function findUnverifiedSessionCandidate(
  before: SessionIndexSnapshot | null,
  env: NodeJS.ProcessEnv,
  jobCwd: string,
): Promise<SessionCandidateOutcome> {
  if (before === null) return { candidate: null, reason: "no-baseline" };
  if (!before.complete) return { candidate: null, reason: "incomplete-index" };
  const after = await snapshotSessionIndex(env, jobCwd);
  if (!after.complete) return { candidate: null, reason: "incomplete-index" };
  const wanted = normalizeWorkDir(jobCwd);
  const fresh: string[] = [];
  for (const [sessionId, workDir] of after.entries) {
    if (!before.entries.has(sessionId) && workDir === wanted) fresh.push(sessionId);
  }
  if (fresh.length === 1) return { candidate: fresh[0]! };
  return { candidate: null, reason: fresh.length === 0 ? "none-new" : "ambiguous" };
}
