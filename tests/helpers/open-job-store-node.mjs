// BRILIA fork: test helper for tests/runtime/job-store-busy-open.test.ts.
// Opens a JobStore from the COMPILED runtime under plain Node, i.e. through
// node:sqlite, the driver the installed plugin actually uses (bun:sqlite only
// runs under the test runner). Prints one JSON line: ok, code, start, end.
// Usage: node tests/helpers/open-job-store-node.mjs <distDir> <pluginDataRoot>
import path from "node:path";
import { pathToFileURL } from "node:url";

const [distDir, dataRoot] = process.argv.slice(2);
const { JobStore } = await import(pathToFileURL(path.join(distDir, "job-store.js")).href);
const { resolvePluginPaths } = await import(pathToFileURL(path.join(distDir, "paths.js")).href);
const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: dataRoot });
const start = Date.now();
try {
  new JobStore(paths).close();
  console.log(JSON.stringify({ ok: true, code: null, start, end: Date.now() }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? String(error), start, end: Date.now() }));
}
