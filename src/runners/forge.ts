import { parseForgeTestJson } from "../parsers/forge-test.js";
import type { BuildPhase, ForgeAnalysis, ProcessOptions, ProcessRunner, TestPhase } from "../types.js";
import { runProcess } from "./process.js";

type ForgeRunnerOptions = {
  runner?: ProcessRunner;
  buildTimeoutMs?: number;
  testTimeoutMs?: number;
  signal?: AbortSignal;
};

function processOptions(
  forgePath: string,
  args: readonly string[],
  projectRoot: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): ProcessOptions {
  const base = { command: forgePath, args, cwd: projectRoot, timeoutMs };
  return signal === undefined ? base : { ...base, signal };
}

export async function runForgeChecks(
  projectRoot: string,
  forgePath: string,
  options: ForgeRunnerOptions = {},
): Promise<ForgeAnalysis> {
  const runner = options.runner ?? runProcess;
  const buildExecution = await runner(processOptions(
    forgePath,
    ["build"],
    projectRoot,
    options.buildTimeoutMs ?? 120_000,
    options.signal,
  ));

  let build: BuildPhase;
  if (buildExecution.termination !== "exit") {
    build = { status: "inconclusive", execution: buildExecution, reason: buildExecution.reason ?? "the build did not finish" };
  } else if (buildExecution.exitCode !== 0) {
    build = { status: "failed", execution: buildExecution, reason: "forge build failed" };
  } else {
    build = { status: "completed", execution: buildExecution };
  }

  if (build.status !== "completed") {
    return {
      build,
      tests: { status: "skipped", outcome: "not-run", reason: "skipped because the build did not complete successfully" },
    };
  }

  const testExecution = await runner(processOptions(
    forgePath,
    ["test", "--json"],
    projectRoot,
    options.testTimeoutMs ?? 120_000,
    options.signal,
  ));

  if (testExecution.termination !== "exit") {
    return {
      build,
      tests: { status: "inconclusive", outcome: "not-run", execution: testExecution, reason: testExecution.reason ?? "the tests did not finish" },
    };
  }

  let tests: TestPhase;
  try {
    const summary = parseForgeTestJson(testExecution.stdout);
    const outcome = summary.total === 0 ? "zero-tests" : summary.failed > 0 ? "failed" : "passed";
    tests = { status: "completed", outcome, execution: testExecution, summary };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    tests = { status: "inconclusive", outcome: "not-run", execution: testExecution, reason: `could not parse forge test --json: ${detail}` };
  }

  return { build, tests };
}
