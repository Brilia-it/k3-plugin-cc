// BRILIA fork (k3-plugin-cc), added in 2.0.7-brilia.0.6.0. Not an upstream file.
//
// Before 0.6.0 this fork wrote its hook block into ~/.kimi-code/config.toml
// under upstream's marker, `kimi-plugin-cc-managed`. From 0.6.0 the marker is
// `k3-plugin-cc-managed`, so this plugin and the upstream kimi plugin can live in
// the same config without one rewriting the other's block.
//
// A block under the OLD marker is either ours (left by a pre-0.6 install of this
// fork) or upstream's (the kimi plugin, installed side by side). It is ours only
// when its hook command is this plugin's approval hook installed under this
// fork's tree: `isOurApprovalHookCommand`, which requires a
// `/brilia-k3-marketplace/` or `/k3-plugin-cc/` path segment. Ours: setup removes
// it and writes the new block. Anything else: left byte for byte.
//
// A block under the old marker is NEVER accepted as an installed hook. Its hook
// reads the pre-0.6 variables (KIMI_PLUGIN_CC_*), which this plugin no longer
// sets, so for a K3 session it would allow every tool call. The verifier knows
// only the new marker; this module exists to remove what the old one left.

import { parse as parseToml } from "../vendor/smol-toml/parse.js";
import { hostIdFromHookCommand, isOurApprovalHookCommand } from "./install-paths.js";
import { decodeManagedCommandLine } from "./managed-block.js";

export const LEGACY_MARKER_TAG = "kimi-plugin-cc-managed";

const LEGACY_BEGIN_RE =
  /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?(?:\s+\([^)]+\))?\s*===\s*$/;
const LEGACY_END_RE = /^#\s*===\s*END\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?\s*===\s*$/;
// Any marker of the CURRENT brand ends the look-ahead: a legacy BEGIN whose END
// would lie past a current block is not a well-formed legacy block.
const CURRENT_MARKER_RE = /^#\s*===\s*(?:BEGIN|END)\s+k3-plugin-cc-managed\b/;

const HOOKS_TABLE_RE = /^\[\[hooks\]\]\s*$/;
const EVENT_LINE_RE = /^event\s*=\s*"PreToolUse"\s*$/;
const TIMEOUT_LINE_RE = /^timeout\s*=\s*\d+\s*$/;

export interface LegacyBrandBlock {
  /** Line of the BEGIN marker (0-based). */
  beginLine: number;
  /** Line of the END marker (0-based, inclusive). */
  endLine: number;
  /** Host from the marker suffix, else from the command path; null if neither. */
  host: string | null;
  /** Decoded hook command, or null if the block has none. */
  command: string | null;
  /**
   * True when the block is this fork's own: its command is our approval hook
   * under our install tree AND its body holds nothing but what we write (one
   * `[[hooks]]` table with event/command/timeout, comments, blank lines). A body
   * with anything else is never ours to delete, whatever its command says.
   */
  ours: boolean;
}

function splitLines(contents: string): string[] {
  return contents.split("\n").map((line) => line.replace(/\r$/, ""));
}

/**
 * Scan the old marker. A BLOCK is a BEGIN followed by an END carrying the same
 * host suffix (or both none), with no other old or current marker between
 * them. Every old marker line that is not part of a block is a STRAY: reported,
 * never removed, because a lone comment line has no owner we can prove.
 *
 * `alsoOurs` is the command THIS install would write: a block running exactly
 * that command is ours whatever its path (a development checkout keeps one path
 * across versions), the same byte-exact ownership signal the orphan prune uses.
 */
export function scanLegacyBrand(
  contents: string,
  alsoOurs?: string,
): { blocks: LegacyBrandBlock[]; strayMarkers: string[] } {
  const lines = splitLines(contents);
  const blocks: LegacyBrandBlock[] = [];
  const strayMarkers: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmedAtI = lines[i]!.trim();
    const begin = LEGACY_BEGIN_RE.exec(trimmedAtI);
    if (begin === null) {
      if (LEGACY_END_RE.test(trimmedAtI)) strayMarkers.push(trimmedAtI);
      i += 1;
      continue;
    }
    const suffix = begin[1]?.toLowerCase() ?? null;
    let endLine = -1;
    let command: string | null = null;
    let hooksTables = 0;
    let event = false;
    let foreign = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j]!.trim();
      if (LEGACY_BEGIN_RE.test(trimmed) || CURRENT_MARKER_RE.test(trimmed)) break;
      const end = LEGACY_END_RE.exec(trimmed);
      if (end !== null) {
        // An END for another host does not close this BEGIN.
        if ((end[1]?.toLowerCase() ?? null) === suffix) endLine = j;
        break;
      }
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      if (HOOKS_TABLE_RE.test(trimmed)) {
        hooksTables += 1;
        continue;
      }
      // A key before the [[hooks]] header belongs to the table ABOVE the block:
      // removing it would change that table. Not ours to delete.
      if (hooksTables === 0) {
        foreign = true;
        continue;
      }
      if (EVENT_LINE_RE.test(trimmed)) {
        event = true;
        continue;
      }
      if (TIMEOUT_LINE_RE.test(trimmed)) continue;
      const decoded = decodeManagedCommandLine(trimmed);
      if (decoded !== null) {
        if (command !== null) foreign = true;
        command = decoded;
        continue;
      }
      foreign = true;
    }
    if (endLine === -1) {
      strayMarkers.push(trimmedAtI);
      i += 1;
      continue;
    }
    // In TOML the END comment does not end the [[hooks]] table: keys after it,
    // up to the next table header, still belong to it. If there are any, the
    // table is more than the block, and removing the block would hand those
    // keys to whatever table comes before it. Not ours to delete.
    for (let k = endLine + 1; k < lines.length; k += 1) {
      const trimmed = lines[k]!.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith("[")) foreign = true;
      break;
    }
    const host = suffix ?? (command !== null ? hostIdFromHookCommand(command) : null);
    const simpleBody = hooksTables === 1 && event && command !== null && !foreign;
    blocks.push({
      beginLine: i,
      endLine,
      host,
      command,
      ours: simpleBody && (command === alsoOurs || isOurApprovalHookCommand(command!)),
    });
    i = endLine + 1;
  }
  return { blocks, strayMarkers };
}

/** Every well-formed block under the old marker, in file order. */
export function findLegacyBrandBlocks(contents: string, alsoOurs?: string): LegacyBrandBlock[] {
  return scanLegacyBrand(contents, alsoOurs).blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date && b instanceof Date)) return false;
    try {
      return a.toISOString() === b.toISOString();
    } catch {
      return Object.is(a.getTime(), b.getTime());
    }
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!(isRecord(a) && isRecord(b))) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
  }
  return Object.is(a, b);
}

/**
 * The scan above reads lines, not TOML: text inside a multi-line string can
 * look exactly like a block. So a removal is accepted only if the parser
 * kimi-code itself uses (smol-toml) sees the same config before and after,
 * minus one `[[hooks]]` entry per removed block, running that block's command.
 * An unparsable file, a string that changed, a key that moved to another
 * table: then nothing is removed.
 */
export function removalChangesOnlyTheseHooks(before: string, after: string, commands: string[]): boolean {
  let parsedBefore: unknown;
  let parsedAfter: unknown;
  try {
    parsedBefore = parseToml(before);
    parsedAfter = parseToml(after);
  } catch {
    return false;
  }
  if (!isRecord(parsedBefore) || !isRecord(parsedAfter)) return false;
  const hooks = Array.isArray(parsedBefore.hooks) ? [...parsedBefore.hooks] : [];
  for (const command of commands) {
    const index = hooks.findIndex((hook) => isRecord(hook) && hook.command === command);
    if (index === -1) return false;
    hooks.splice(index, 1);
  }
  const expected: Record<string, unknown> = { ...parsedBefore };
  if (hooks.length === 0) delete expected.hooks;
  else expected.hooks = hooks;
  return sameValue(expected, parsedAfter);
}

/**
 * Remove this fork's own legacy blocks. With `host`, only the blocks of that
 * host (the other host migrates its own on its next setup, exactly like the
 * current marker's host scoping); without it, every one of ours (`--all`).
 * Blocks that are not ours are kept byte for byte and returned in `kept`.
 * If the parser does not confirm the removal (removalChangesOnlyTheseHooks),
 * nothing is removed and `unconfirmed` lists the blocks that stay.
 */
export function stripLegacyBrandBlocks(
  contents: string,
  lineEnding: "\n" | "\r\n",
  host?: string,
  alsoOurs?: string,
): {
  stripped: string;
  removed: LegacyBrandBlock[];
  kept: LegacyBrandBlock[];
  strayMarkers: string[];
  unconfirmed: LegacyBrandBlock[];
} {
  const { blocks, strayMarkers } = scanLegacyBrand(contents, alsoOurs);
  // A block running exactly this install's command is this host's own even if
  // a host-id override makes its path-derived host differ (as in the prune).
  const removed = blocks.filter(
    (b) => b.ours && (host === undefined || b.host === host || (alsoOurs !== undefined && b.command === alsoOurs)),
  );
  const kept = blocks.filter((b) => !removed.includes(b));
  if (removed.length === 0) return { stripped: contents, removed, kept, strayMarkers, unconfirmed: [] };

  const drop = new Set<number>();
  for (const block of removed) {
    for (let line = block.beginLine; line <= block.endLine; line += 1) drop.add(line);
  }
  // Collapse to 2 a run of >= 3 blank lines, but only a run where a block was
  // removed: elsewhere blank lines are the user's, and inside a multi-line
  // string they are part of its value.
  const collapsed: string[] = [];
  let blankRun = 0;
  let removalInRun = false;
  splitLines(contents).forEach((line, index) => {
    if (drop.has(index)) {
      removalInRun = true;
      return;
    }
    if (line.length === 0) {
      blankRun += 1;
      if (blankRun > 2 && removalInRun) return;
      collapsed.push(line);
      return;
    }
    blankRun = 0;
    removalInRun = false;
    collapsed.push(line);
  });
  const stripped = collapsed.join(lineEnding);
  if (!removalChangesOnlyTheseHooks(contents, stripped, removed.map((b) => b.command!))) {
    return { stripped: contents, removed: [], kept, strayMarkers, unconfirmed: removed };
  }
  return { stripped, removed, kept, strayMarkers, unconfirmed: [] };
}

/** Human-readable notes for setup's warnings. Empty when there is nothing to say. */
export function describeLegacyBrandBlocks(
  removed: LegacyBrandBlock[],
  kept: LegacyBrandBlock[],
  mode: "removed" | "found",
  strayMarkers: string[] = [],
  unconfirmed: LegacyBrandBlock[] = [],
): string[] {
  const notes: string[] = [];
  if (unconfirmed.length > 0) {
    notes.push(
      `Found ${unconfirmed.length} hook block(s) written by k3-plugin-cc before 0.6.0 under the old marker ` +
        `\`${LEGACY_MARKER_TAG}\` (lines ${unconfirmed.map((b) => b.beginLine + 1).join(", ")}), but removing them ` +
        `would change more of the config than those blocks (for example text inside a multi-line string), or the ` +
        `config does not parse. Left in place: remove them by hand. They no longer protect K3 sessions.`,
    );
  }
  if (removed.length > 0) {
    notes.push(
      mode === "removed"
        ? `Migrated ${removed.length} hook block(s) written by k3-plugin-cc before 0.6.0 under the old marker ` +
            `\`${LEGACY_MARKER_TAG}\`: removed, and replaced by the \`k3-plugin-cc-managed\` block.`
        : `Found ${removed.length} hook block(s) written by k3-plugin-cc before 0.6.0 under the old marker ` +
            `\`${LEGACY_MARKER_TAG}\`. They no longer protect K3 sessions; run /k3:setup to remove them.`,
    );
  }
  const otherHost = kept.filter((b) => b.ours);
  if (otherHost.length > 0) {
    notes.push(
      `${otherHost.length} pre-0.6 k3-plugin-cc block(s) of another host (${[
        ...new Set(otherHost.map((b) => b.host ?? "unknown")),
      ].join(", ")}) remain: each host migrates its own on its next setup.`,
    );
  }
  const foreign = kept.filter((b) => !b.ours);
  if (foreign.length > 0) {
    notes.push(
      `Left ${foreign.length} block(s) under the marker \`${LEGACY_MARKER_TAG}\` untouched: either their hook is ` +
        `not this plugin's (most likely the upstream kimi plugin, which uses that marker), or the block holds more ` +
        `than the hook table this plugin writes. Neither is removed automatically; they do not affect K3.`,
    );
  }
  if (strayMarkers.length > 0) {
    notes.push(
      `Found ${strayMarkers.length} line(s) with the marker \`${LEGACY_MARKER_TAG}\` that do not form a ` +
        `complete block: ${[...new Set(strayMarkers)].map((text) => JSON.stringify(text)).join(", ")}. Left in ` +
        `place: a comment line alone changes no hook, but check it by hand.`,
    );
  }
  return notes;
}
