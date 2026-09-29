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
//     using it. Setup moves it to the new name when no job is running, and
//     rewrites the absolute paths the job store kept for past jobs.
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { JobStore } from "./job-store.js";
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, resolvePluginPaths } from "./paths.js";
import { resolvePluginDataRoot } from "./plugin-data.js";
export const LEGACY_ENV_PREFIX = "KIMI_PLUGIN_CC_";
const CURRENT_ENV_PREFIX = "K3_PLUGIN_CC_";
/** Names of the old-style variables set in `env`, sorted. */
export function legacyEnvNames(env) {
    return Object.keys(env)
        .filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && env[name] !== undefined)
        .sort();
}
export function collectLegacyEnvWarnings(env, warnings) {
    const names = legacyEnvNames(env);
    if (names.length === 0)
        return;
    const renamed = names.map((name) => `${name} -> ${CURRENT_ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`);
    warnings.push(`These variables are set but k3-plugin-cc no longer reads them (since 0.6.0 its names start with ` +
        `${CURRENT_ENV_PREFIX}): ${renamed.join(", ")}. If they were meant for this plugin, rename them. ` +
        `If they belong to the upstream kimi plugin, which still uses those names, ignore this note.`);
}
/**
 * Move `<data root>/kimi-plugin-cc` to `<data root>/k3-plugin-cc`, only when the
 * new one does not exist and no job is marked running (a running job's worker
 * would keep writing under the old path). Never merges two directories and
 * never throws: whatever happens, the plugin keeps working on the directory
 * runtime/paths.ts resolves.
 */
export async function migrateLegacyDataDir(env) {
    let root;
    try {
        root = resolvePluginDataRoot(env);
    }
    catch {
        // No resolvable data root: every command that needs one reports it itself.
        return { status: "none" };
    }
    const legacy = path.join(root, LEGACY_DATA_DIR_NAME);
    const current = path.join(root, DATA_DIR_NAME);
    if (!existsSync(legacy))
        return { status: "none" };
    if (existsSync(current))
        return { status: "both-exist", legacy, current };
    const paths = resolvePluginPaths(env);
    if (existsSync(paths.stateDbPath)) {
        let running;
        try {
            const store = new JobStore(paths);
            try {
                running = store.countRunningJobs();
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            return { status: "failed", legacy, current, reason: `could not read the job store: ${messageOf(error)}` };
        }
        if (running > 0)
            return { status: "jobs-running", legacy, running };
    }
    try {
        await rename(legacy, current);
    }
    catch (error) {
        return { status: "failed", legacy, current, reason: messageOf(error) };
    }
    const moved = resolvePluginPaths(env);
    if (existsSync(moved.stateDbPath)) {
        try {
            const store = new JobStore(moved);
            try {
                store.rebaseStoredPaths(legacy + path.sep, current + path.sep);
            }
            finally {
                store.close();
            }
        }
        catch (error) {
            return {
                status: "failed",
                legacy,
                current,
                reason: `moved, but the paths stored for past jobs still point to the old directory ` +
                    `(${messageOf(error)}); /k3:result and /k3:replay may not find their files`,
            };
        }
    }
    return { status: "migrated", from: legacy, to: current };
}
export function describeDataDirMigration(result) {
    switch (result.status) {
        case "none":
            return null;
        case "migrated":
            return `Moved the data directory from ${result.from} to ${result.to} (its pre-0.6 name). Jobs, logs, artifacts and settings came with it.`;
        case "both-exist":
            return `The pre-0.6 data directory ${result.legacy} was left in place because ${result.current} already exists. Nothing was merged; K3 uses ${result.current}.`;
        case "jobs-running":
            return `K3 still uses its pre-0.6 data directory ${result.legacy}: ${result.running} job(s) are marked running, so it was not moved. Wait for them to finish, or run /k3:status (it settles jobs whose process is gone) or /k3:cancel, then run /k3:setup again.`;
        case "failed":
            return `Could not move the pre-0.6 data directory ${result.legacy} to ${result.current}: ${result.reason}. K3 keeps working on the directory it finds; run /k3:setup again later.`;
    }
}
/** For setup --check: says so when K3 still runs on the pre-0.6 directory. */
export function describeLegacyDataDirInUse(env) {
    let paths;
    try {
        paths = resolvePluginPaths(env);
    }
    catch {
        return null;
    }
    if (paths.usingLegacyDataDir !== true)
        return null;
    return `K3 is using its pre-0.6 data directory ${paths.pluginRoot}. /k3:setup moves it to ${path.join(paths.claudePluginData, DATA_DIR_NAME)} when no job is running.`;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
