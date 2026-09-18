# Session visibility and native titles

Plugin-created sessions live in Kimi Code's local session store and can appear in both Kimi Code Desktop and Node's `kimi web`. Keep Web available: the migration away from the old Python CLI does not retire Node Web.

After a user-command run settles, the plugin fills missing prompt-preview metadata and notifies the shared index. This addresses the native-v2 headless path leaving `lastPrompt` absent, which causes Desktop/Web to hide a completed session as empty. The preview comes from the submitted prompt or task objective, is redacted using Kimi's credential-pattern rules, and is limited to 4,000 characters. It is a local display preview, not a new model prompt.

## Native generated titles

New native-v2 sessions receive a readable fallback such as `Kimi Review: ...`. The fallback is marked **replaceable**, so native title generation can replace it. Existing manual titles and already-generated titles remain unchanged. Older plugin titles marked custom are also preserved because they cannot always be distinguished from a human rename.

In Kimi Code Desktop 1.0.1, open the session's **Rename** control and select **Gen Title** to generate a title from its conversation. Native automatic generation also runs after an eligible turn finishes in Desktop. Merely opening an already-completed plugin session does not trigger it. Kimi's native generator uses its managed login; unavailable authentication or backend errors can leave the fallback in place.

The plugin does not silently call the native title-generation endpoint. That endpoint resumes the session, activates agent services and fires session-start hooks; it is not a metadata-only API. Selecting Gen Title in Desktop is a deliberate native-app action. The plugin makes no extra title-generation provider calls and does not read OAuth credentials.

## Repair existing sessions

Use the companion bundled with the updated plugin (or a freshly built checkout). Run while the target Kimi sessions are idle:

```sh
scripts/companion.sh repair-sessions
scripts/companion.sh repair-sessions --apply
```

The first command previews changes in the current repository; the second applies them. Add `--all` to cover repositories in that host's plugin job store. Claude Code and Codex have separate stores, so run against each relevant host. For a checkout repairing an existing host, select its data parent explicitly with `KIMI_PLUGIN_CC_DATA`; do not point it at the inner `kimi-plugin-cc` directory.

The command reports JSON status counts and job/session IDs, without prompt bodies. It only considers completed, proven native-v2 user-command sessions and excludes sessions with a running job in that store. It recovers the original prompt from a bounded invocation-log prefix and verifies its digest against the job record. It leaves job records, logs, journals, titles and existing nonempty previews unchanged. No model is invoked.

`unavailable-verified-prompt` means the source log is missing, unsafe, too large at its start, or does not match the recorded invocation. It is skipped rather than guessed from an answer summary. `state-changed` means a concurrent metadata change was detected: retry when idle. `index-failed` means metadata was saved but index notification failed: fix the directory problem and retry; an unchanged session is still re-indexed on apply.

The index may need its next reconciliation and the UI may need a list refresh before repaired sessions appear. A native session already loaded in another process may hold older in-memory metadata. Repair is not coordinated by a cross-process native lock; keep target sessions idle and reload their view afterward.

Write-swarm sessions belong to their temporary worktree, which is removed after patch capture. Their global history can be visible while an original-project filter omits them. The repair does not rewrite their cwd or change their execution provenance.
