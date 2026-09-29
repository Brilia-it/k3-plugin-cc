// BRILIA fork: test helper for tests/runtime/legacy-brand.test.ts.
// Holds the WRITE lock of an existing job store (BEGIN IMMEDIATE, the lock a
// command takes to record a job) from a separate process for a fixed time, so
// the test can run setup's data-directory move while another process writes.
// Unlike hold-exclusive-lock.ts it leaves the journal mode alone: the store is
// in WAL mode, as in real use.
// Writes <markerPath> once the lock is held, and <markerPath>.release with the
// time (ms since epoch) taken just BEFORE the lock is released. With
// <keepOpenMs>, the connection stays open that long after the release, as a
// command that keeps its store open after recording its job.
// Usage: bun tests/helpers/hold-write-lock.ts <dbPath> <markerPath> <holdMs> [keepOpenMs]
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [dbPath, markerPath, holdMsArg, keepOpenArg] = process.argv.slice(2);
if (!dbPath || !markerPath || !holdMsArg) {
  console.error("usage: hold-write-lock.ts <dbPath> <markerPath> <holdMs> [keepOpenMs]");
  process.exit(2);
}
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
writeFileSync(markerPath, String(Date.now()));
Bun.sleepSync(Number(holdMsArg));
writeFileSync(`${markerPath}.release`, String(Date.now()));
db.exec("COMMIT");
if (keepOpenArg) Bun.sleepSync(Number(keepOpenArg));
db.close();
