#!/usr/bin/env node

import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runForgeChecks } from "./runners/forge.js";
import { runForgeCoverage } from "./runners/coverage.js";
import type { CoverageMetric, CoveragePhase, ForgeAnalysis, TestPhase } from "./types.js";

const execFileAsync = promisify(execFile);

type FoundryConfig = {
  src?: unknown;
  test?: unknown;
};

export type CliDependencies = {
  findExecutable(name: "forge" | "slither"): Promise<string | undefined>;
  readToolVersion(executable: string): Promise<string>;
  readFoundryConfig(projectRoot: string, forgePath: string): Promise<FoundryConfig>;
  runForgeAnalysis(projectRoot: string, forgePath: string): Promise<ForgeAnalysis>;
  runCoverageAnalysis(projectRoot: string, forgePath: string, sourceRoot: string, reportPath: string): Promise<CoveragePhase>;
};

type CliIo = {
  out(text: string): void;
  err(text: string): void;
};

const HELP = `Solidity Review

Usage:
  solidity-review analyze <path> --out <directory>
  solidity-review --help

Validates that the path is a Foundry project and that Forge and Slither are available.
This tool does not perform a security audit or guarantee that the project is secure.`;

async function findExecutable(name: "forge" | "slither"): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching through PATH.
    }
  }

  return undefined;
}

async function readFoundryConfig(projectRoot: string, forgePath: string): Promise<FoundryConfig> {
  try {
    const { stdout } = await execFileAsync(forgePath, ["config", "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      killSignal: "SIGTERM",
      maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(stdout) as FoundryConfig;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail);
  }
}

async function readToolVersion(executable: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    killSignal: "SIGTERM",
    maxBuffer: 1024 * 1024,
  });
  const version = `${stdout}\n${stderr}`.trim();
  if (version.length === 0) {
    throw new Error("the tool returned no version information");
  }
  return version;
}

const defaultDependencies: CliDependencies = {
  findExecutable,
  readToolVersion,
  readFoundryConfig,
  runForgeAnalysis: runForgeChecks,
  runCoverageAnalysis: runForgeCoverage,
};
const defaultIo: CliIo = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

function fail(io: CliIo, message: string): 2 {
  io.err(`Error: ${message}`);
  return 2;
}

function configuredPath(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
}

function testSummary(phase: TestPhase): string {
  if (phase.summary === undefined) {
    return `Tests: ${phase.status} (${phase.reason ?? "no results"})`;
  }
  const { total, passed, failed, skipped } = phase.summary;
  return `Tests: ${phase.status}; total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped}`;
}

function metricSummary(metric: CoverageMetric | null): string {
  return metric === null ? "unavailable" : `${metric.covered}/${metric.total}`;
}

function coverageSummary(phase: CoveragePhase): string {
  if (phase.summary === undefined) {
    return `Coverage: ${phase.status} (${phase.reason ?? "no results"})`;
  }
  const { totals, excluded } = phase.summary;
  return [
    `Coverage: ${phase.status}`,
    `lines=${metricSummary(totals.lines)}`,
    `functions=${metricSummary(totals.functions)}`,
    `branches=${metricSummary(totals.branches)}`,
    `excluded=${excluded.length}`,
    `LCOV=${phase.reportPath}`,
  ].join("; ");
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
  io: CliIo = defaultIo,
): Promise<number> {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    io.out(HELP);
    return 0;
  }

  if (args[0] !== "analyze") {
    return fail(io, `unknown command "${args[0]}". Use --help to see the syntax.`);
  }

  const projectArgument = args[1];
  if (projectArgument === undefined || projectArgument.startsWith("-")) {
    return fail(io, "missing Foundry project <path>.");
  }

  const outIndex = args.indexOf("--out");
  const outputArgument = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outputArgument === undefined || outputArgument.startsWith("-")) {
    return fail(io, "missing --out <directory>.");
  }

  const expectedLength = 4;
  if (args.length !== expectedLength || outIndex !== 2) {
    return fail(io, "unrecognized arguments. Use: analyze <path> --out <directory>.");
  }

  const projectRoot = path.resolve(projectArgument);
  const outputDirectory = path.resolve(outputArgument);

  try {
    const projectStats = await stat(projectRoot);
    if (!projectStats.isDirectory()) {
      return fail(io, `the project path is not a directory: ${projectRoot}`);
    }
  } catch {
    return fail(io, `the project path does not exist: ${projectRoot}`);
  }

  const foundryFile = path.join(projectRoot, "foundry.toml");
  try {
    const foundryStats = await stat(foundryFile);
    if (!foundryStats.isFile()) {
      return fail(io, `foundry.toml is not a file: ${foundryFile}`);
    }
  } catch {
    return fail(io, `foundry.toml was not found in ${projectRoot}; this does not appear to be a compatible Foundry project.`);
  }

  const discoveredForgePath = await dependencies.findExecutable("forge");
  if (discoveredForgePath === undefined) {
    return fail(io, "forge was not found in PATH. Install Foundry and verify `forge --version`.");
  }
  const forgePath = path.resolve(discoveredForgePath);

  const discoveredSlitherPath = await dependencies.findExecutable("slither");
  if (discoveredSlitherPath === undefined) {
    return fail(io, "slither was not found in PATH. Install it in an isolated environment and verify `slither --version`.");
  }
  const slitherPath = path.resolve(discoveredSlitherPath);

  let forgeVersion: string;
  try {
    forgeVersion = await dependencies.readToolVersion(forgePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `could not run forge --version (${forgePath}): ${detail}`);
  }

  let slitherVersion: string;
  try {
    slitherVersion = await dependencies.readToolVersion(slitherPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `could not run slither --version (${slitherPath}): ${detail}`);
  }

  let config: FoundryConfig;
  try {
    config = await dependencies.readFoundryConfig(projectRoot, forgePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `could not run forge config --json to read the effective configuration: ${detail}`);
  }

  const sourceDirectory = path.resolve(projectRoot, configuredPath(config.src, "src"));
  const testDirectory = path.resolve(projectRoot, configuredPath(config.test, "test"));

  for (const [label, directory] of [["source", sourceDirectory], ["tests", testDirectory]] as const) {
    try {
      const directoryStats = await stat(directory);
      if (!directoryStats.isDirectory()) {
        return fail(io, `the effective ${label} path is not a directory: ${directory}`);
      }
    } catch {
      return fail(io, `the effective ${label} path does not exist: ${directory}`);
    }
  }

  try {
    const outputStats = await stat(outputDirectory);
    if (!outputStats.isDirectory()) {
      return fail(io, `the output path is not a directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(io, `could not use output directory ${outputDirectory}: ${detail}`);
    }
    try {
      await mkdir(outputDirectory, { recursive: true });
    } catch (creationError) {
      const detail = creationError instanceof Error ? creationError.message : String(creationError);
      return fail(io, `could not create output directory ${outputDirectory}: ${detail}`);
    }
  }

  let analysis: ForgeAnalysis;
  try {
    analysis = await dependencies.runForgeAnalysis(projectRoot, forgePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `could not start Forge execution: ${detail}`);
  }

  const buildLine = `Build: ${analysis.build.status}; duration=${analysis.build.execution.durationMs}ms`;
  const testsLine = testSummary(analysis.tests);
  if (analysis.build.status !== "completed") {
    return fail(io, `${buildLine}. ${analysis.build.reason ?? "no details"}\n${testsLine}`);
  }

  const coverageReportPath = path.join(outputDirectory, "artifacts", "coverage.lcov");
  let coverage: CoveragePhase;
  try {
    coverage = await dependencies.runCoverageAnalysis(projectRoot, forgePath, sourceDirectory, coverageReportPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `could not start forge coverage: ${detail}`);
  }
  const coverageLine = coverageSummary(coverage);
  if (coverage.status !== "completed") {
    return fail(io, `${buildLine}\n${testsLine}\n${coverageLine}`);
  }
  if (analysis.tests.status !== "completed") {
    return fail(io, `${buildLine}\n${testsLine}\n${coverageLine}`);
  }
  if (analysis.tests.outcome === "failed") {
    io.err(`${buildLine}\n${testsLine}\n${coverageLine}\nPolicy violation: failed tests.`);
    return 1;
  }
  if (analysis.tests.outcome === "zero-tests") {
    io.err(`${buildLine}\n${testsLine}\n${coverageLine}\nPolicy violation: zero tests executed.`);
    return 1;
  }

  io.out([
    "Valid Foundry project.",
    `Project: ${projectRoot}`,
    `Sources: ${sourceDirectory}`,
    `Tests: ${testDirectory}`,
    `Output: ${outputDirectory}`,
    `Forge: ${forgePath} — ${forgeVersion}`,
    `Slither: ${slitherPath} — ${slitherVersion}`,
    buildLine,
    testsLine,
    coverageLine,
  ].join("\n"));
  return 0;
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
