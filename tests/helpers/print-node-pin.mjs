// Test helper: report how a REAL spawned child resolves the node token it
// would pin into the managed hook command.
//
// Exists because the v1.9.0 argv0 fix rests on an OS-level premise —
// "spawn() reports argv[0] verbatim, without resolving symlinks" — that an
// in-process unit test can only assume, never prove. This helper is spawned as
// an actual child process so the assertion is made against real kernel
// behavior.
//
// Imports from `dist/` (not `runtime/`) deliberately: it needs no TS loader,
// and it makes the check cover the COMPILED artifact that ships to users, which
// is what a background worker actually loads in production.
import { buildHookShellCommand } from "../../dist/hooks/install-paths.js";

// Optional argv[2]: the hook script path to build the command for. Callers that
// need a command they can write into a real config.toml pass the true script
// path; the pure argv0 assertions use the default placeholder.
const hookScript = process.argv[2] ?? "/x/dist/hooks/approval-hook.js";

process.stdout.write(
  JSON.stringify({
    argv0: process.argv0,
    execPath: process.execPath,
    // The canonical command this child would verify against — the exact value
    // that must agree with what `/kimi:setup` pinned, or every background
    // rescue/ask refuses forever.
    canonical: buildHookShellCommand(hookScript, {}),
  }),
);
