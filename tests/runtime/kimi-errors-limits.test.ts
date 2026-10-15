import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { classifyManagedCommandFailure, summarizeKimiAvailabilityWarning } from "../../runtime/kimi-errors.js";

// Verbatim strings from https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
// (checked 2026-10-15) and from the 2026-10-15 incident.
const QUOTA_5H =
  "403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
const QUOTA_WEEKLY = "You've reached your weekly (7-day) usage limit.";
const QUOTA_MONTHLY = "You've reached your monthly usage limit for this billing cycle.";
const QUOTA_OLD_FORM = "403 You've reached your daily usage limit.";
const CONCURRENCY = "You've reached your concurrent request limit";
const PLAN_K3 = "401 Your current subscription does not have access to k3";
const PLAN_CODE = "403 Your current subscription does not have access to Kimi Code right now";
const CONTEXT_SIZE = "total message size 2200000 exceeds limit 2097152";
const CONTEXT_TOKENS = "Your request exceeded model token limit: 262144 (requested: 300000)";
const CONTEXT_256K = "this model supports only 256K context";

const TRUST_WARNING = [
  "Warning: this folder is not trusted; skipped 4 project-level MCP servers.",
  "Warning: this folder is not trusted; skipped project-level hooks.",
].join("\n");

const EPERM_STACK = [
  "Error: EPERM: operation not permitted, rename 'C:\\Users\\x\\.kimi-code\\tmp.json'",
  "    at async Object.rename (node:internal/fs/promises:783:10)",
  "    at async persist (file:///C:/kimi/dist/index.js:100:5) {",
  "  errno: -4048,",
  "  code: 'EPERM',",
  "  syscall: 'rename'",
  "}",
].join("\n");

function nonzeroExit(stderrTail: string): RuntimeError {
  return new RuntimeError(
    "CLI_NONZERO_EXIT",
    `kimi subprocess exited with code 1:\n${stderrTail}`,
    "ask.runtime",
  );
}

function classify(stderrTail: string, command: "ask" | "review" | "rescue" | "review_gate" = "ask"): RuntimeError {
  const out = classifyManagedCommandFailure(nonzeroExit(stderrTail), command, "job-1");
  expect(out).toBeInstanceOf(RuntimeError);
  return out as RuntimeError;
}

describe("provider limits get their own classification", () => {
  test("5-hour limit: quota_exhausted, says which limit, call volume not context, setup does not fix it", () => {
    const err = classify(`${TRUST_WARNING}\nprovider.auth_error: ${QUOTA_5H}`);
    expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
    expect(err.message).toContain("5-hour rolling window");
    expect(err.message).toContain("call volume");
    expect(err.message).toContain("NOT the context window");
    expect(err.message).toContain("/k3:setup` does not fix it");
    expect(err.message).toContain("kimi-code/k3-256k");
    expect(err.message).toContain("one at a time");
    expect(err.message).toContain("a retry starts from zero");
    expect(err.message).not.toContain("Run `/k3:setup` to verify local Kimi health");
    expect(err.details?.limit).toBe("5-hour");
    expect(err.details?.availability).toBe("quota_exhausted");
    expect(err.details?.cause_code).toBe("CLI_NONZERO_EXIT");
    expect(String(err.details?.cause_message)).toContain("5-hour usage limit");
  });

  test("the real 2026-10-15 stderr, with the EPERM stack trace in front, is still quota_exhausted", () => {
    const err = classify(`${TRUST_WARNING}\n${EPERM_STACK}\nprovider.auth_error: ${QUOTA_5H}`);
    expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
  });

  test("weekly and billing-cycle limits name their own window", () => {
    const weekly = classify(QUOTA_WEEKLY, "review");
    expect(weekly.code).toBe("REVIEW_KIMI_QUOTA_EXHAUSTED");
    expect(weekly.message).toContain("weekly (7-day)");
    expect(weekly.details?.limit).toBe("weekly");
    const monthly = classify(QUOTA_MONTHLY, "rescue");
    expect(monthly.code).toBe("RESCUE_KIMI_QUOTA_EXHAUSTED");
    expect(monthly.message).toContain("billing cycle");
    expect(monthly.details?.limit).toBe("billing-cycle");
  });

  test("the older 'You've reached your ... usage limit' form is a quota too", () => {
    const err = classify(QUOTA_OLD_FORM);
    expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
    expect(err.details?.limit).toBe("unspecified");
  });

  test("a quota failure with a recoverable session gives the exact resume command", () => {
    const err = classifyManagedCommandFailure(nonzeroExit(QUOTA_5H), "ask", "job-9", {
      resumeCommand: '/k3:ask --resume job-9 "continue"',
    }) as RuntimeError;
    expect(err.code).toBe("ASK_KIMI_QUOTA_EXHAUSTED");
    expect(err.message).toContain('/k3:ask --resume job-9 "continue"');
    expect(err.message).not.toContain("a retry starts from zero");
  });

  test("concurrent request limit: concurrency_limited, risk control, not quota", () => {
    const err = classify(`403 ${CONCURRENCY}`);
    expect(err.code).toBe("ASK_KIMI_CONCURRENCY_LIMITED");
    expect(err.message).toContain("risk control");
    expect(err.message).toContain("not quota");
    expect(err.message).toContain("one job at a time");
    expect(err.message).toContain("appeal");
  });

  test("plan errors: k3 suggests kimi-for-coding; 'Kimi Code right now' is also a plan error", () => {
    const k3 = classify(PLAN_K3);
    expect(k3.code).toBe("ASK_KIMI_PLAN_UNAVAILABLE");
    expect(k3.message).toContain("kimi-for-coding");
    const code = classify(`${TRUST_WARNING}\n${PLAN_CODE}`);
    expect(code.code).toBe("ASK_KIMI_PLAN_UNAVAILABLE");
    expect(code.message).toContain("subscription");
  });

  test("context errors: all three verbatim forms, k3-256k is fixed at 256K", () => {
    for (const text of [CONTEXT_SIZE, CONTEXT_TOKENS, CONTEXT_256K]) {
      const err = classify(`400 ${text}`);
      expect(err.code).toBe("ASK_KIMI_CONTEXT_EXCEEDED");
      expect(err.message).toContain("narrow the scope or split the work");
      expect(err.message).toContain("fixed at 256K");
    }
  });

  test("an unrelated non-zero exit still maps to STARTUP_FAILED", () => {
    const err = classify("Segmentation fault (core dumped)");
    expect(err.code).toBe("ASK_KIMI_STARTUP_FAILED");
    expect(err.message).toContain("/k3:setup");
  });

  test("auth.login_required keeps winning over everything else", () => {
    const err = classify('auth.login_required: OAuth provider "managed:kimi-code" requires login');
    expect(err.code).toBe("ASK_KIMI_AUTH_UNAVAILABLE");
  });

  test("the review gate stays fail-open: every limit kind is a warning that allows stop", () => {
    for (const text of [QUOTA_5H, CONCURRENCY, PLAN_K3, CONTEXT_SIZE]) {
      const warning = summarizeKimiAvailabilityWarning(nonzeroExit(text), "review_gate");
      expect(warning).not.toBeNull();
      expect(warning).toContain("allowing stop");
    }
    expect(summarizeKimiAvailabilityWarning(nonzeroExit(QUOTA_5H), "review_gate")).toContain("usage limit");
  });
});
