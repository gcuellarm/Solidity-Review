import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { ProcessOptions, ProcessResult, ProcessTermination } from "../types.js";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const startedAt = performance.now();
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      shell: false,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let termination: ProcessTermination = "exit";
    let reason: string | undefined;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (nextTermination: ProcessTermination, nextReason: string): void => {
      if (termination !== "exit") return;
      termination = nextTermination;
      reason = nextReason;
      if (child.pid !== undefined && platform() !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
          forceKillTimer = setTimeout(() => {
            try { process.kill(-(child.pid as number), "SIGKILL"); } catch { /* Already terminated. */ }
          }, 1_000);
          return;
        } catch {
          // The process may have exited between the check and the signal.
        }
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxBufferBytes) {
        terminate("output-limit", `process output exceeded the ${maxBufferBytes}-byte limit`);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    const timer = setTimeout(() => terminate("timeout", `timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    const cancel = (): void => terminate("cancelled", "execution cancelled");
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted === true) cancel();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", cancel);
      const base = {
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        exitCode: termination === "exit" ? exitCode : null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Math.round(performance.now() - startedAt),
        termination,
      };
      resolve(reason === undefined ? base : { ...base, reason });
    };

    child.once("error", (error) => {
      termination = "error";
      reason = error.message;
      finish(null);
    });
    child.once("close", finish);
  });
}
