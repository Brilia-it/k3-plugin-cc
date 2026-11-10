// MODIFIED BY BRILIA (unofficial fork of linxule/kimi-plugin-cc, Apache-2.0).
// One change, on every platform: the worker passes its launcher's pid on, so it
// can claim the job row by compare-and-set. See NOTICE and README.md.
// Section 4(b) of the License requires this notice.
import { RuntimeError } from "../errors.js";
import type { CommandContext } from "../types.js";
import { executeRescueJob } from "./rescue.js";
import { executeAskJob } from "./ask.js";

export async function runWorker(argv: string[], context: CommandContext): Promise<void> {
  const [kind, jobId] = argv;
  // BRILIA fork: the launcher that spawned this worker; the row is still owned by it
  // until the worker claims it by compare-and-set.
  const launcherPidRaw = Number(context.env.K3_PLUGIN_CC_LAUNCHER_PID);
  const launcherPid = Number.isInteger(launcherPidRaw) && launcherPidRaw > 0 ? launcherPidRaw : undefined;

  if (!jobId || (kind !== "rescue" && kind !== "ask")) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      "worker expects the form: worker rescue <job-id> or worker ask <job-id>.",
      "worker",
    );
  }

  if (kind === "rescue") {
    const encodedPrompt = context.env.K3_PLUGIN_CC_RESCUE_PROMPT_B64;
    if (!encodedPrompt) {
      throw new RuntimeError("MISSING_RESCUE_PROMPT", "Background rescue prompt is missing.", "worker");
    }
    const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
    const reusedSession = context.env.K3_PLUGIN_CC_RESCUE_REUSED_SESSION === "1";
    await executeRescueJob(jobId, prompt, context, { workerPid: process.pid, launcherPid, reusedSession });
    return;
  }

  const encodedPrompt = context.env.K3_PLUGIN_CC_ASK_PROMPT_B64;
  if (!encodedPrompt) {
    throw new RuntimeError("MISSING_ASK_PROMPT", "Background ask prompt is missing.", "worker");
  }
  const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
  await executeAskJob(jobId, prompt, context, { workerPid: process.pid, launcherPid });
}
