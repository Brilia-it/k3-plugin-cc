import { KIMI_PLUGIN_CC_VERSION } from "../runtime/version.js";

export const PLUGIN_NAME = "k3";
export const MARKETPLACE_NAME = "brilia-k3-marketplace";
// Single source of truth: the Codex manifest/marketplace version derives from the
// runtime version, so a release bump in runtime/version.ts propagates here without
// a second edit. The codex-surfaces test asserts PLUGIN_VERSION === package.json.
export const PLUGIN_VERSION = KIMI_PLUGIN_CC_VERSION;

// The Codex plugin is a SELF-CONTAINED subfolder so its root has no overlap with the
// Claude Code plugin root (the repo root). Claude Code auto-discovers a top-level
// skills/ dir by convention; keeping the Codex skills out of the repo root is what
// stops them leaking into the Claude Code surface. Codex copies this root to its
// install cache, so the subfolder also bundles the runtime it needs (see
// generate-surfaces.ts). One constant so the location is one-line-changeable.
export const CODEX_PLUGIN_SUBDIR = "plugins/k3-codex";

export interface ClaudeSurfaceHash {
  path: string;
  sha256: string;
}

export interface CodexSkillSpec {
  name: string;
  title: string;
  description: string;
  displayName: string;
  shortDescription: string;
  defaultPrompt: string;
  command: string;
  argumentSummary: string;
  implicit: boolean;
  guidance: readonly string[];
}

export const CLAUDE_SURFACE_HASHES: readonly ClaudeSurfaceHash[] = [
  { path: ".claude-plugin/plugin.json", sha256: "7f7994f59c7018586a1eb0d40533523059ea88906303bf0823a5ca68f95ad6c9" },
  { path: ".claude-plugin/marketplace.json", sha256: "a412738423c39ededccacef48c44fe6c482a094d1e9e12641a683259677512bb" },
  { path: "commands/README.md", sha256: "f996a084f8c7762c2405c3990443cff49d96003416da8fead8fd875a0f50fd23" },
  { path: "commands/ask.md", sha256: "5ffcd405b1f905f400c00520d210afc6dbf35cae3a0b07c6189866fa639bf778" },
  { path: "commands/cancel.md", sha256: "4d1c1e9d0534fac113fea18e2c8993d99f3ada1335186f66cd995a45f1057db4" },
  { path: "commands/challenge.md", sha256: "7131e086e84cbfcdfb6580b6b156480b21aec9e0ae5e2ebeb4e35c8c3ed76ef0" },
  { path: "commands/pursue.md", sha256: "66ef05900edd25f2cdb94b60c6ac9e35d4c9b86abddfda2f428fac0adb37d80a" },
  { path: "commands/replay.md", sha256: "84e46faa17b032f43dccb37190e461d1da3f807226f3814a9e5cd302afcf12e3" },
  { path: "commands/rescue.md", sha256: "7708b9d2a48a25e260d1b711472d32c5a2b772b1e7bbdbd6279f55af75abf130" },
  { path: "commands/result.md", sha256: "d5ae361ea6c95f139e4bf1d2f23cb69e14c23c9e0e2b6e8084274e8245016db5" },
  { path: "commands/review.md", sha256: "2a5103029d91bd1f204979e8a52a9726ecfb171bcdc0b273be155ec7ced7c243" },
  { path: "commands/setup.md", sha256: "17e0e2c274f3cc4cb36780ea62c078bb1bbeeee81bfd1b0c8e0594f7e7f4fc8c" },
  { path: "commands/status.md", sha256: "0171276cd08b9fe62893f62523c164f35b1a4df98cb7b04f14f62fc33fbc8cbc" },
  { path: "commands/swarm.md", sha256: "1b2bf73f5d4cc4faed1c72898577d4d1cb6537d86441d5a6e13e1e33eca3ee46" },
  { path: "agents/k3-ask.md", sha256: "e6d8a76c50796ace9e4b112852320baa509f689ad9f64b6686277c788bd77c50" },
  { path: "agents/k3-challenge.md", sha256: "48c6cd295ef7bceeb9b38658e88d9b0d333f880dd1571bf09a78e4af44b30c25" },
  { path: "agents/k3-pursue.md", sha256: "f908fb7c4b2918e4505258f4764bc2c9ec9a75ed43be7572a5ed5401d4b9277f" },
  { path: "agents/k3-rescue.md", sha256: "72276792d6c706a5d654fac70fc7c03ef2263798f038298760fe7b53adcaf736" },
  { path: "agents/k3-review.md", sha256: "7ff72a700a86d3e3e362a51c5c46df98313507448672fd969e603051d2cca2ca" },
  { path: "agents/k3-swarm-write.md", sha256: "01ece81eca55c856b09ca56b6c591f5b62e6eee4d06f338ea8f9106c397634c0" },
  { path: "agents/k3-swarm.md", sha256: "05ec5929b00da57cee525d9a208040b681dfd152da9622f0153981f0760ed644" },
];

export const CODEX_PLUGIN_MANIFEST = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Codex plugin that delegates review, challenge, ask, rescue, pursue, and swarm workflows to the local kimi-code CLI through the kimi-plugin-cc companion runtime.",
  author: {
    name: "linxule",
  },
  homepage: "https://github.com/linxule/kimi-plugin-cc",
  repository: "https://github.com/linxule/kimi-plugin-cc",
  license: "Apache-2.0",
  keywords: ["kimi", "kimi-code", "review", "code-review", "delegation", "multi-model"],
  skills: "./skills/",
  interface: {
    displayName: "K3",
    shortDescription: "Delegate repo work to local kimi-code",
    longDescription:
      "Shell-only Codex packaging for kimi-plugin-cc. It exposes Codex skills that call the existing companion runtime and local kimi-code subprocess, while preserving the Claude Code plugin surface.",
    developerName: "linxule",
    category: "Developer Tools",
    capabilities: ["Code Review", "Local Shell", "Write"],
    websiteURL: "https://github.com/linxule/kimi-plugin-cc",
    defaultPrompt: [
      "Use $k3-review to review my current diff.",
      "Use $k3-ask to explain this repository flow.",
      "Use $k3-rescue to delegate a bounded fix.",
    ],
    brandColor: "#0F766E",
  },
} as const;

export const CODEX_MARKETPLACE = {
  name: MARKETPLACE_NAME,
  interface: {
    displayName: "K3 Marketplace (BRILIA)",
  },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: {
        source: "local",
        path: "./plugins/k3-codex",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    },
  ],
} as const;

export const CODEX_SKILLS: readonly CodexSkillSpec[] = [
  {
    name: "k3-ask",
    title: "Kimi Ask",
    displayName: "Kimi Ask",
    shortDescription: "Ask Kimi a read-only repo question",
    defaultPrompt: "Use $k3-ask to explain the current repository flow.",
    implicit: true,
    command: "ask",
    argumentSummary: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>",
    description:
      "Ask Kimi a read-only free-form question about the current repository. Use for prose explanations, flow tracing, module comparisons, or conceptual reasoning where Codex should delegate the answer to local kimi-code rather than perform implementation.",
    guidance: [
      "Preserve the user's question and supplied flags exactly; use `-r` only for explicit resume intent unless `--fresh` is requested.",
      "Choose `--background` for broad or long-running questions and return the job id that the companion prints.",
      "If the companion reports ASK_HOOK_NOT_INSTALLED, tell the user to run Claude Code /k3:setup or Codex $k3-setup, then retry; do not suggest the skip env.",
      "Return companion stdout verbatim; do not summarize or re-voice Kimi's prose.",
    ],
  },
  {
    name: "k3-review",
    title: "Kimi Review",
    displayName: "Kimi Review",
    shortDescription: "Run Kimi read-only code review",
    defaultPrompt: "Use $k3-review to review the current working tree.",
    implicit: true,
    command: "review",
    argumentSummary: "[--base <ref>] [-m <model>] [extra prose]",
    description:
      "Run an independent read-only Kimi review over the current working tree or a branch diff. Use when the user wants a second reviewer for defects, regressions, or implementation risks, not edits.",
    guidance: [
      "Forward `--base <ref>`, `-m`/`--model <name>`, and any trailing focus text only.",
      "Do not invent file/path flags; review's payload is the git diff plus optional focus text.",
      "If the companion reports REVIEW_HOOK_NOT_INSTALLED, tell the user to run Claude Code /k3:setup or Codex $k3-setup, then retry; do not suggest the skip env.",
      "Return companion stdout verbatim and leave any fixes to a separate user request.",
    ],
  },
  {
    name: "k3-challenge",
    title: "Kimi Challenge",
    displayName: "Kimi Challenge",
    shortDescription: "Challenge a design or approach",
    defaultPrompt: "Use $k3-challenge to stress-test this approach.",
    implicit: true,
    command: "task challenge",
    argumentSummary: "[--base <ref>] [-m <model>] [extra prose]",
    description:
      "Run a read-only adversarial Kimi challenge review that questions assumptions, design choices, and tradeoffs. Use when the user wants pushback on whether the approach is right, not a defect-only review.",
    guidance: [
      "Preserve the user's adversarial framing as trailing focus text.",
      "Do not pass background/wait flags; the runtime rejects them for challenge.",
      "If the companion reports CHALLENGE_HOOK_NOT_INSTALLED, tell the user to run Claude Code /k3:setup or Codex $k3-setup, then retry; do not suggest the skip env.",
      "Return companion stdout verbatim without softening the challenge framing.",
    ],
  },
  {
    name: "k3-rescue",
    title: "Kimi Rescue",
    displayName: "Kimi Rescue",
    shortDescription: "Delegate a bounded Kimi fix",
    defaultPrompt: "Use $k3-rescue to delegate this bounded implementation task.",
    implicit: false,
    command: "task rescue",
    argumentSummary: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>",
    description:
      "Delegate a bounded write-capable investigation or implementation task to Kimi through the companion runtime. Use only when explicitly invoked or when the user clearly asks to hand off a substantial fix to Kimi.",
    guidance: [
      "Preserve the task text and constraints with minimal reframing.",
      "Use background mode for long-running investigations and report the job id for status/result/cancel.",
      "Do not inspect or edit the repository yourself as part of the skill; the companion result is the source of truth.",
    ],
  },
  {
    name: "k3-pursue",
    title: "Kimi Pursue",
    displayName: "Kimi Pursue",
    shortDescription: "Run autonomous Kimi goal mode",
    defaultPrompt: "Use $k3-pursue to let Kimi pursue this objective with a budget.",
    implicit: false,
    command: "task pursue",
    argumentSummary: "[--budget <30m|1h>] [--turns <N>] [-m <model>] <objective>",
    description:
      "Run Kimi's autonomous goal mode for an explicitly requested hands-off multi-turn objective. This is write-capable and budget-bounded; use only when the user explicitly asks Kimi to pursue an objective autonomously.",
    guidance: [
      "Require explicit hands-off autonomy intent; single bounded fixes belong to `k3-rescue`.",
      "Always keep a finite `--budget` — it is the sole hard bound on the loop. The runtime rejects `--background`, but detaching your own shell call is expected: a goal loop routinely outlives a foreground timeout, and the hook, allowlist, and budget do not depend on a human watching. Cancel with `companion.sh cancel` (no id — it targets the latest running job for the repo); note that a cancel stops further work but does not roll back edits already made to the real tree.",
      "Surface terminal goal statuses exactly as the companion reports them.",
    ],
  },
  {
    name: "k3-swarm",
    title: "Kimi Swarm",
    displayName: "Kimi Swarm",
    shortDescription: "Fan out Kimi read-only review",
    defaultPrompt: "Use $k3-swarm to fan out a read-only review across these targets.",
    implicit: false,
    command: "task swarm",
    argumentSummary: "[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>",
    description:
      "Run a read-only parallel Kimi review fan-out across many independent targets. Use only for explicit broad fan-out requests where one subagent per target is the point.",
    guidance: [
      "Require many independent review targets plus explicit fan-out intent.",
      "Pass finite budget and concurrency bounds; default to foreground unless the user explicitly asks to detach.",
      "If the companion reports SWARM_HOOK_NOT_INSTALLED, tell the user to run Claude Code /k3:setup or Codex $k3-setup, then retry.",
      "Return the consolidated companion report verbatim.",
    ],
  },
  {
    name: "k3-swarm-write",
    title: "Kimi Swarm Write",
    displayName: "Kimi Swarm Write",
    shortDescription: "Fan out patch-only Kimi edits",
    defaultPrompt: "Use $k3-swarm-write to fan out these disjoint edits into a patch.",
    implicit: false,
    command: "task swarm --write",
    argumentSummary: "[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>",
    description:
      "Run a write-capable Kimi swarm that edits many disjoint targets in a throwaway worktree and returns a reviewable patch. Use only for explicit parallel edit fan-out requests; the plugin never applies or commits the patch.",
    guidance: [
      "Require both many disjoint write targets and explicit parallel fan-out intent.",
      "Keep `--max-concurrency` conservative, normally 1, unless the user explicitly asks to widen it.",
      "The runtime rejects `--background`, but detaching your own shell call is expected: a fan-out routinely outlives a foreground timeout, and the run is patch-only and worktree-confined. Keep `--budget` and `--max-concurrency` finite. To stop a run, use `companion.sh cancel` with NO id — it targets the latest running job for the repo, and no UUID crosses you or the user (a detached run prints nothing at launch; the id first arrives with the final report). Prefer that over an interrupt: an interrupt gives the companion only ~1.35s before SIGKILL, less than its teardown plus `git diff --binary` patch capture, so interrupting can lose the patch.",
      "If the companion reports SWARM_HOOK_NOT_INSTALLED, tell the user to run Claude Code /k3:setup or Codex $k3-setup, then retry.",
      "Return the patch path and companion output verbatim; do not apply the patch unless the user separately asks.",
    ],
  },
  {
    name: "kimi-setup",
    title: "Kimi Setup",
    displayName: "Kimi Setup",
    shortDescription: "Install or check Kimi hooks",
    defaultPrompt: "Use $k3-setup to check the local Kimi companion setup.",
    implicit: false,
    command: "setup",
    argumentSummary:
      "[--check | --uninstall [--all] | --enable-review-gate | --disable-review-gate]",
    description:
      "Verify local Kimi companion readiness and manage the kimi-code PreToolUse hook plus optional review gate state. Use when explicitly requested to install, check, enable, disable, or uninstall the integration. Codex and Claude Code share one ~/.kimi-code/config.toml but each own a host-scoped block, so $k3-setup here does not disturb Claude Code's /k3:setup (and vice-versa).",
    guidance: [
      "Run setup from the user's workspace so the companion records the intended workspace cwd.",
      "Use `--check` for read-only verification and `--uninstall` only when explicitly requested. `--uninstall` removes only this host's block; `--uninstall --all` removes every host's block from the shared config.",
      "Setup validates the complete shared TOML and every configured hook under a serialized lock. If it reports invalid foreign config, surface that failure; do not bypass it or claim the managed block is safe in isolation.",
      "Report setup stdout verbatim because it contains hook and probe status.",
    ],
  },
  {
    name: "kimi-status",
    title: "Kimi Status",
    displayName: "Kimi Status",
    shortDescription: "Show Kimi job status",
    defaultPrompt: "Use $k3-status to show the latest Kimi job status.",
    implicit: false,
    command: "status",
    argumentSummary: "[<job-id>] [--type <review|challenge|rescue|review_gate|ask>]",
    description:
      "Show the latest or selected plugin-managed Kimi job for the current repository. Use when the user explicitly asks for Kimi job status or progress.",
    guidance: [
      "Preserve any job id or `--type` filter.",
      "Return companion stdout verbatim; it is the persisted job state.",
    ],
  },
  {
    name: "kimi-result",
    title: "Kimi Result",
    displayName: "Kimi Result",
    shortDescription: "Return a Kimi job result",
    defaultPrompt: "Use $k3-result to return the latest Kimi job result.",
    implicit: false,
    command: "result",
    argumentSummary: "[<job-id>] [--type <review|challenge|rescue|review_gate|ask>] [--json]",
    description:
      "Return the stored rendered result for the latest or selected terminal Kimi job. Use when the user explicitly asks for a Kimi job result or artifact body.",
    guidance: [
      "Preserve any job id, `--type`, and `--json` flag.",
      "Return companion stdout verbatim; `--json` is the structured automation surface.",
    ],
  },
  {
    name: "kimi-cancel",
    title: "Kimi Cancel",
    displayName: "Kimi Cancel",
    shortDescription: "Cancel an active Kimi job",
    defaultPrompt: "Use $k3-cancel to cancel this active Kimi job.",
    implicit: false,
    command: "cancel",
    argumentSummary: "[<job-id>]",
    description:
      "Cancel an active plugin-managed Kimi job for the current repository. Use only when the user explicitly asks to cancel a Kimi run.",
    guidance: [
      "Pass the requested job id when supplied; otherwise let the companion choose the latest active job for this repository.",
      "Return companion stdout verbatim so the user sees the cancellation state.",
    ],
  },
  {
    name: "kimi-replay",
    title: "Kimi Replay",
    displayName: "Kimi Replay",
    shortDescription: "Replay a Kimi event log",
    defaultPrompt: "Use $k3-replay to re-render this Kimi job event log.",
    implicit: false,
    command: "replay",
    argumentSummary: "<job-id>",
    description:
      "Re-render a stored event log for a completed plugin-managed Kimi job. Use only when the user explicitly asks to replay a Kimi job.",
    guidance: [
      "Require a job id and pass it unchanged.",
      "Return companion stdout verbatim because replay output is the diagnostic artifact.",
    ],
  },
];
