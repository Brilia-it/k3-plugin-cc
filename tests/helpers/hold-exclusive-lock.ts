// BRILIA fork: test helper for tests/runtime/job-store-busy-open.test.ts.
// Holds an EXCLUSIVE lock on a SQLite file for a fixed time, from a separate
// process, so the test can open a JobStore while the database is genuinely busy.
// Writes <markerPath> once the lock is held, and <markerPath>.release with the
// time (ms since epoch) taken just BEFORE the lock is released, so the test can
// prove its open started while locked and finished only after the release.
// Usage: bun tests/helpers/hold-exclusive-lock.ts <dbPath> <markerPath> <holdMs>
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [dbPath, markerPath, holdMsArg] = process.argv.slice(2);
if (!dbPath || !markerPath || !holdMsArg) {
  console.error("usage: hold-exclusive-lock.ts <dbPath> <markerPath> <holdMs>");
  process.exit(2);
}
const db = new Database(dbPath);
// Rollback-journal mode: an EXCLUSIVE transaction here blocks every other
// connection, readers included, which is the contention the test needs.
db.exec("PRAGMA journal_mode = DELETE");
db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)");
db.exec("BEGIN EXCLUSIVE");
db.exec("INSERT INTO lock_probe (id) VALUES (1)");
writeFileSync(markerPath, String(Date.now()));
Bun.sleepSync(Number(holdMsArg));
writeFileSync(`${markerPath}.release`, String(Date.now()));
db.exec("COMMIT");
db.close();
