export class RuntimeError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, stage: string, options?: ErrorOptions & { details?: Record<string, unknown> }) {
    super(message, options);
    this.name = "RuntimeError";
    this.code = code;
    this.stage = stage;
    this.details = options?.details ?? {};
  }
}

/**
 * BRILIA fork (review 0.7.0, finding 6): a waited background job ended `failed` or
 * `cancelled`. The failure artifact is still the output (the companion prints it on
 * stdout), but the process must exit non-zero like the foreground path, or a caller
 * that keys on the exit code would start the next job.
 */
export class TerminalJobFailure extends RuntimeError {
  readonly artifact: string;

  constructor(code: string, message: string, stage: string, artifact: string) {
    super(code, message, stage);
    this.name = "TerminalJobFailure";
    this.artifact = artifact;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof RuntimeError) {
    const base = `[${error.code}] [${error.stage}] ${error.message}`;
    // Serialize structured context so an LLM caller can act on it. Without
    // this, `details` existed only in the SQLite job row — reachable via
    // `result <jobId> --json` for BACKGROUND jobs, but simply lost for
    // foreground ones (review/challenge/ask), whose only output is this
    // string. v1.9.0 needs `drift_axis` to reach the caller on every path, so
    // it is rendered here as one deterministic JSON line. (Kimi's pre-release
    // review caught that the agents were told to branch on a field no channel
    // actually carried.)
    const details = error.details;
    if (details !== undefined && Object.keys(details).length > 0) {
      try {
        return `${base}\ndetails: ${JSON.stringify(details)}`;
      } catch {
        // A non-serializable value must never suppress the error itself.
        return base;
      }
    }
    return base;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
