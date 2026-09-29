// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.6.0. Not an upstream file.
//
// Up to 0.5.x this fork still used upstream's names in two places a user can
// meet: the environment variables it reads (KIMI_PLUGIN_CC_*) and its data
// directory (`kimi-plugin-cc`). From 0.6.0 they are K3_PLUGIN_CC_* and
// `k3-plugin-cc`. This module is setup's side of that change:
//
//   - variables: the old names are NOT read. Honouring them would let a value
//     set for the upstream kimi plugin (installed side by side, which reads
//     exactly those names) steer this one, including the hook-check bypass.
//     Setup says so out loud instead of ignoring them in silence.
//   - data directory: while only the old one exists, runtime/paths.ts keeps
//     using it. Setup renames it when no job is marked running, and leaves an
//     ALIAS under the old name pointing to the new one (a junction on Windows,
//     a directory symlink elsewhere). The alias is what makes the move safe
//     without a lock shared with every command: a command that resolved the old
//     path just before the rename keeps working through it. A later setup
//     removes the alias once no job is running. The paths the job store keeps
//     for past jobs are rewritten on every setup, so a rewrite that failed once
//     is simply done again.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rename, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";

import { JobStore } from "./job-store.js";
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, resolvePluginPaths, type PluginPaths } from "./paths.js";
import { resolvePluginDataRoot } from "./plugin-data.js";

export const LEGACY_ENV_PREFIX = "KIMI_PLUGIN_CC_";
const CURRENT_ENV_PREFIX = "K3_PLUGIN_CC_";

/** Names of the old-style variables set in `env`, sorted. */
export function legacyEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && env[name] !== undefined)
    .sort();
}

export function collectLegacyEnvWarnings(env: NodeJS.ProcessEnv, warnings: string[]): void {
  const names = legacyEnvNames(env);
  if (names.length === 0) return;
  const renamed = names.map((name) => `${name} -> ${CURRENT_ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`);
  warnings.push(
    `These variables are set but k3-plugin-cc no longer reads them (since 0.6.0 its names start with ` +
      `${CURRENT_ENV_PREFIX}): ${renamed.join(", ")}. If they were meant for this plugin, rename them. ` +
      `If they belong to the upstream kimi plugin, which still uses those names, ignore this note.`,
  );
}

export type DataDirMigration =
  | { status: "none"; rebased: number }
  | { status: "migrated"; from: string; to: string; rebased: number; alias: "kept" | "not-created"; aliasError?: string }
  | { status: "alias-removed"; alias: string; rebased: number }
  | { status: "alias-kept"; alias: string; running: number; rebased: number }
  | { status: "alias-foreign"; alias: string }
  | { status: "both-exist"; legacy: string; current: string }
  | { status: "jobs-running"; legacy: string; running: number }
  | { status: "failed"; legacy: string; current: string; reason: string };

type LegacyState = "absent" | "directory" | "alias-to-current" | "other";

function legacyState(legacy: string, current: string): LegacyState {
  let stat;
  try {
    stat = lstatSync(legacy);
  } catch {
    return "absent";
  }
  if (stat.isSymbolicLink()) {
    try {
      return realpathSync(legacy) === realpathSync(current) ? "alias-to-current" : "other";
    } catch {
      return "other"; // dangling, or pointing somewhere we cannot resolve
    }
  }
  return stat.isDirectory() ? "directory" : "other";
}

/**
 * Every spelling under which a 0.5.x install may have stored the old
 * directory: the root as resolved now, its real path, and the shared variables
 * that 0.5.x used verbatim (its install check never matched this fork, so it
 * always fell back to them).
 */
function legacyPrefixes(root: string, env: NodeJS.ProcessEnv): string[] {
  const roots = [root, env.CLAUDE_PLUGIN_DATA, env.PLUGIN_DATA].filter(
    (value): value is string => typeof value === "string" && path.isAbsolute(value),
  );
  try {
    roots.push(realpathSync(root));
  } catch {
    // An unresolvable root adds nothing.
  }
  return [...new Set(roots.map((r) => path.join(r, LEGACY_DATA_DIR_NAME)))];
}

/** The mapping handed to JobStore.rebaseStoredPaths. */
export function legacyPathMapper(prefixes: string[], current: string): (stored: string) => string | null {
  return (stored) => {
    for (const prefix of prefixes) {
      // path.relative follows the platform's rules: on Windows it ignores case
      // and accepts either separator, so C:\x and c:/x name the same directory.
      const relative = path.relative(prefix, stored);
      if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      return path.join(current, relative);
    }
    return null;
  };
}

function withStore<T>(paths: PluginPaths, run: (store: JobStore) => T): T | null {
  if (!existsSync(paths.stateDbPath)) return null;
  const store = new JobStore(paths);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

async function removeAlias(alias: string): Promise<void> {
  // Never a recursive removal: that would follow the alias into the real data.
  // On Windows a junction goes with rmdir; a POSIX symlink with unlink.
  try {
    await unlink(alias);
  } catch {
    await rmdir(alias);
  }
}

/**
 * Move `<data root>/kimi-plugin-cc` to `<data root>/k3-plugin-cc`, only when the
 * new one does not exist and no job is marked running. Never merges two
 * directories and never throws: whatever happens, the plugin keeps working on
 * the directory runtime/paths.ts resolves.
 */
export async function migrateLegacyDataDir(env: NodeJS.ProcessEnv): Promise<DataDirMigration> {
  let root: string;
  try {
    root = resolvePluginDataRoot(env);
  } catch {
    // No resolvable data root: every command that needs one reports it itself.
    return { status: "none", rebased: 0 };
  }
  const legacy = path.join(root, LEGACY_DATA_DIR_NAME);
  const current = path.join(root, DATA_DIR_NAME);
  const prefixes = legacyPrefixes(root, env);
  const state = legacyState(legacy, current);

  try {
    if (state === "other") return { status: "alias-foreign", alias: legacy };

    if (state === "absent" || state === "alias-to-current") {
      // Retry the path rewrite every time: idempotent, and the only way a
      // rewrite that failed on the run that moved the directory gets done.
      const paths = resolvePluginPaths(env);
      const rebased = existsSync(current) ? withStore(paths, (s) => s.rebaseStoredPaths(legacyPathMapper(prefixes, current))) ?? 0 : 0;
      if (state === "absent") return { status: "none", rebased };
      const running = withStore(paths, (s) => s.countRunningJobs()) ?? 0;
      if (running > 0) return { status: "alias-kept", alias: legacy, running, rebased };
      await removeAlias(legacy);
      return { status: "alias-removed", alias: legacy, rebased };
    }

    // A real legacy directory.
    if (existsSync(current)) return { status: "both-exist", legacy, current };
    const running = withStore(resolvePluginPaths(env), (s) => s.countRunningJobs()) ?? 0;
    if (running > 0) return { status: "jobs-running", legacy, running };
  } catch (error) {
    return { status: "failed", legacy, current, reason: messageOf(error) };
  }

  try {
    await rename(legacy, current);
  } catch (error) {
    // On Windows this is what an open handle inside the directory looks like.
    return { status: "failed", legacy, current, reason: messageOf(error) };
  }

  let aliasError: string | undefined;
  try {
    await symlink(current, legacy, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    aliasError = messageOf(error);
  }

  let rebased = 0;
  try {
    rebased = withStore(resolvePluginPaths(env), (s) => s.rebaseStoredPaths(legacyPathMapper(prefixes, current))) ?? 0;
  } catch (error) {
    return {
      status: "failed",
      legacy,
      current,
      reason:
        `moved, but the paths stored for past jobs were not rewritten yet (${messageOf(error)}); ` +
        `the next /k3:setup rewrites them`,
    };
  }
  return aliasError === undefined
    ? { status: "migrated", from: legacy, to: current, rebased, alias: "kept" }
    : { status: "migrated", from: legacy, to: current, rebased, alias: "not-created", aliasError };
}

export function describeDataDirMigration(result: DataDirMigration): string | null {
  switch (result.status) {
    case "none":
      return result.rebased > 0
        ? `Rewrote the stored paths of ${result.rebased} past job(s) that still pointed to the pre-0.6 data directory.`
        : null;
    case "migrated":
      return (
        `Moved the data directory from ${result.from} to ${result.to} (its pre-0.6 name). Jobs, logs, results ` +
        `and settings came with it; ${result.rebased} past job(s) had their stored paths rewritten. ` +
        (result.alias === "kept"
          ? `The old name stays as an alias to the new directory, so a command started during the move keeps ` +
            `working; the next /k3:setup removes it once no job is running.`
          : `The alias under the old name could not be created (${result.aliasError}): a K3 command that was ` +
            `starting during the move may fail once; run it again.`)
      );
    case "alias-removed":
      return `Removed ${result.alias}, the alias left by the move of the data directory.`;
    case "alias-kept":
      return `Kept ${result.alias}, the alias left by the move of the data directory: ${result.running} job(s) are marked running. The next /k3:setup removes it.`;
    case "alias-foreign":
      return `${result.alias} exists but is not the pre-0.6 data directory nor an alias to the current one. Left untouched; check it by hand.`;
    case "both-exist":
      return `The pre-0.6 data directory ${result.legacy} was left in place because ${result.current} already exists. Nothing was merged; K3 uses ${result.current}, and whatever is in the old one is not visible to it.`;
    case "jobs-running":
      return `K3 still uses its pre-0.6 data directory ${result.legacy}: ${result.running} job(s) are marked running, so it was not moved. Wait for them to finish, or run /k3:status (it settles jobs whose process is gone) or /k3:cancel, then run /k3:setup again.`;
    case "failed":
      return `Could not complete the move of the pre-0.6 data directory ${result.legacy} to ${result.current}: ${result.reason}. K3 keeps working on the directory it finds; run /k3:setup again later.`;
  }
}

/** For setup --check: what is still left of the pre-0.6 data directory. */
export function describeLegacyDataDirInUse(env: NodeJS.ProcessEnv): string | null {
  let paths: PluginPaths;
  try {
    paths = resolvePluginPaths(env);
  } catch {
    return null;
  }
  const legacy = path.join(paths.claudePluginData, LEGACY_DATA_DIR_NAME);
  const current = path.join(paths.claudePluginData, DATA_DIR_NAME);
  if (paths.usingLegacyDataDir === true) {
    return `K3 is using its pre-0.6 data directory ${paths.pluginRoot}. /k3:setup moves it to ${current} when no job is running.`;
  }
  switch (legacyState(legacy, current)) {
    case "alias-to-current":
      return `${legacy} is the alias left by the move of the data directory; /k3:setup removes it once no job is running.`;
    case "directory":
      return `The pre-0.6 data directory ${legacy} still exists next to ${current} and is not used. Nothing was merged; move or delete it by hand.`;
    case "other":
      return `${legacy} exists but is not the pre-0.6 data directory nor an alias to the current one; check it by hand.`;
    default:
      return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
