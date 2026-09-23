# Claude Code commands

These Markdown files route Claude Code commands through `scripts/companion.sh` to the Node runtime. They also describe supported flags and model-selection rules. Codex uses the generated skills in `plugins/k3-codex/skills/`.

| File | Purpose |
| --- | --- |
| `setup.md` | Install or check hooks, list models, guide provider setup, and manage the review gate |
| `ask.md` | Answer repository questions without write tools |
| `review.md` | Review code changes and return prose |
| `challenge.md` | Critique a design or approach and return prose |
| `rescue.md` | Make workspace changes, with background and resume support |
| `pursue.md` | Run an experimental goal with a finite time budget |
| `swarm.md` | Run a read-only parallel review, or use `--write` to return an unapplied patch |
| `status.md`, `result.md`, `cancel.md`, `replay.md` | Follow, stop, or replay stored jobs |

After editing a command, update its hash in `CLAUDE_SURFACE_HASHES` in `scripts/surface-registry.ts`. Run `bun run generate:surfaces` and `bun run check` before considering the change complete.
