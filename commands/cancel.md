---
description: Cancel an active plugin-managed Kimi job for the current repository.
argument-hint: "[<job-id>]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `cancel`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh cancel <args>`

Cancellation uses the recorded companion and Kimi process ids, so it can cancel foreground jobs launched by detached agent runs as well as background ask/rescue jobs.

The job id is optional and normally omitted: with no argument the companion cancels the latest **running** job for this repository. Job ids are raw UUIDs that a run does not print at launch, so pass one only if you already have it from a completed report. With several runs in flight, the no-id form takes the most recent — confirm which one is meant first.

Prefer this over interrupting a run with Esc. An interrupt gives the companion ~1.35s before SIGKILL, which is shorter than its own teardown plus patch capture, so it can kill a write-swarm mid-settlement and lose the captured patch; this command signals from a separate process that is not racing that deadline.

Return the companion stdout verbatim.
