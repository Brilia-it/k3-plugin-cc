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
