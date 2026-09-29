// MODIFIED BY BRILIA (unofficial fork of linxule/kimi-plugin-cc, Apache-2.0).
// One change: the data directory is named `k3-plugin-cc`. A pre-0.6 install
// kept its jobs, logs, artifacts and config in `kimi-plugin-cc`; while only
// that directory exists it stays in use, so nothing is lost before /k3:setup
// moves it (runtime/legacy-names.ts), and it is never recreated once moved.
// See NOTICE and README.md.
// Section 4(b) of the License requires this notice.
import { constants, existsSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "./errors.js";
import { resolvePluginDataRoot } from "./plugin-data.js";

/** The data directory under the plugin's data root, since 0.6.0. */
export const DATA_DIR_NAME = "k3-plugin-cc";
/** Its name before 0.6.0 (upstream's). Read as a fallback, never created. */
export const LEGACY_DATA_DIR_NAME = "kimi-plugin-cc";

export interface PluginPaths {
  claudePluginData: string;
  pluginRoot: string;
  stateDbPath: string;
  logsDir: string;
  artifactsDir: string;
  /**
   * Ephemeral git worktrees for write-swarm (v1.4). Lives under the plugin's own
   * data dir — NEVER inside a user repo — so a throwaway worktree is isolated from
   * the user's checkout and the `git worktree add` target is always outside the
   * repo. Each run gets a `swarm-write-<jobId>` subdir; the patch is captured then
   * the dir is removed. A startup sweep reaps orphans left by a hard kill.
   */
  worktreesDir: string;
  configPath: string;
  /**
   * BRILIA fork: true when `pluginRoot` is the pre-0.6 directory, in use because
   * the new one does not exist yet.
   */
  usingLegacyDataDir?: boolean;
}

export function resolvePluginPaths(env: NodeJS.ProcessEnv): PluginPaths {
  const claudePluginData = resolvePluginDataRoot(env);

  const current = path.join(claudePluginData, DATA_DIR_NAME);
  const legacy = path.join(claudePluginData, LEGACY_DATA_DIR_NAME);
  const usingLegacyDataDir = !existsSync(current) && existsSync(legacy);
  const pluginRoot = usingLegacyDataDir ? legacy : current;

  return {
    claudePluginData,
    pluginRoot,
    stateDbPath: path.join(pluginRoot, "state.db"),
    logsDir: path.join(pluginRoot, "logs"),
    artifactsDir: path.join(pluginRoot, "artifacts"),
    worktreesDir: path.join(pluginRoot, "worktrees"),
    configPath: path.join(pluginRoot, "config.json"),
    usingLegacyDataDir,
  };
}

function dataDirMoved(paths: PluginPaths): RuntimeError {
  return new RuntimeError(
    "PLUGIN_DATA_MOVED",
    `The data directory ${paths.pluginRoot} was moved to ${path.join(
      paths.claudePluginData,
      DATA_DIR_NAME,
    )} while this command was starting. Run the command again.`,
    "paths",
  );
}

export async function ensurePluginPaths(paths: PluginPaths): Promise<void> {
  if (paths.usingLegacyDataDir === true) {
    // The pre-0.6 directory is used only while it exists, and is never
    // created: if setup moves it while this command starts, recreating it
    // would split the state in two. So only its subdirectories are created,
    // one level at a time (no recursive mkdir, which would bring the parent
    // back): if the parent is gone that fails, and the command stops. No
    // separate existence check first: it would only reopen the same window.
    for (const dir of [paths.logsDir, paths.artifactsDir]) {
      try {
        await mkdir(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (code === "ENOENT") throw dataDirMoved(paths);
        throw error;
      }
    }
  } else {
    await mkdir(paths.pluginRoot, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
  }

  await access(paths.pluginRoot, constants.R_OK | constants.W_OK);
  await access(paths.logsDir, constants.R_OK | constants.W_OK);
  await access(paths.artifactsDir, constants.R_OK | constants.W_OK);
  // worktreesDir is created lazily by the write-swarm path (not every command
  // needs it), so it is intentionally NOT required here.
}
