/*
 * Modified by BRILIA (2026-11) from linxule/kimi-plugin-cc v2.5.6 (commit a9585a1),
 * licensed under the Apache License 2.0. Changes in this file: the version string
 * carries this fork's own numbering, <upstream version>-brilia.<our version>.
 * See NOTICE and CHANGELOG.md.
 */
// Single source of truth for the plugin version that the runtime reports
// in setup output and managed-block markers. Keep this in sync with
// package.json, .claude-plugin/plugin.json, .claude-plugin/marketplace.json,
// and AGENTS.md on every release. A future improvement would read this from
// package.json at build time, but that adds a build-step dependency we
// don't want yet.
export const K3_PLUGIN_CC_VERSION = "2.5.6-brilia.0.1.0";
