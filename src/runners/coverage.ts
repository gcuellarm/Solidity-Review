import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseLcov } from "../parsers/lcov.js";
import type { CoveragePhase, ProcessOptions, ProcessRunner } from "../types.js";
import { runProcess } from "./process.js";

type CoverageRunnerOptions = {
  runner?: ProcessRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function runForgeCoverage(
  projectRoot: string,
  forgePath: string,
  sourceRoot: string,
  reportPath: string,
  options: CoverageRunnerOptions = {},
): Promise<CoveragePhase> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await rm(reportPath, { force: true });
  const args = ["coverage", "--report", "lcov", "--report-file", reportPath, "--exclude-tests"] as const;
  const base: ProcessOptions = {
    command: forgePath,
    args,
    cwd: projectRoot,
    timeoutMs: options.timeoutMs ?? 180_000,
  };
  const processOptions = options.signal === undefined ? base : { ...base, signal: options.signal };
  const execution = await (options.runner ?? runProcess)(processOptions);

  if (execution.termination !== "exit") {
    return { status: "inconclusive", execution, reportPath, reason: execution.reason ?? "forge coverage did not finish" };
  }
  if (execution.exitCode !== 0) {
    return { status: "failed", execution, reportPath, reason: "forge coverage failed" };
  }

  try {
    const contents = await readFile(reportPath, "utf8");
    const summary = parseLcov(contents, projectRoot, sourceRoot);
    return { status: "completed", execution, reportPath, summary };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "inconclusive", execution, reportPath, reason: `could not read or parse LCOV: ${detail}` };
  }
}
