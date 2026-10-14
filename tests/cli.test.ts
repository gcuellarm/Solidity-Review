import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";
import type { CoveragePhase, ForgeAnalysis } from "../src/types.js";

const capture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) } };
};

const successfulAnalysis = (): ForgeAnalysis => ({
  build: {
    status: "completed",
    execution: { command: "/tools/forge", args: ["build"], cwd: "/project", exitCode: 0, stdout: "", stderr: "", durationMs: 1, termination: "exit" },
  },
  tests: {
    status: "completed",
    outcome: "passed",
    execution: { command: "/tools/forge", args: ["test", "--json"], cwd: "/project", exitCode: 0, stdout: "{}", stderr: "", durationMs: 1, termination: "exit" },
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, failures: [] },
  },
});

const successfulCoverage = (): CoveragePhase => ({
  status: "completed",
  execution: { command: "/tools/forge", args: ["coverage"], cwd: "/project", exitCode: 0, stdout: "", stderr: "", durationMs: 2, termination: "exit" },
  reportPath: "/reports/artifacts/coverage.lcov",
  summary: {
    files: [{ path: "contracts/Example.sol", lines: { covered: 2, total: 3 }, functions: null, branches: null, uncoveredLines: [3] }],
    totals: { lines: { covered: 2, total: 3 }, functions: null, branches: null },
    excluded: ["spec/Example.t.sol"],
  },
});

const tools = (missing?: "forge" | "slither"): CliDependencies => ({
  findExecutable: async (name) => name === missing ? undefined : `tools/${name}`,
  readToolVersion: async (executable) => `${path.basename(executable)} 1.2.3`,
  readFoundryConfig: async () => ({ src: "contracts", test: "spec" }),
  runForgeAnalysis: async () => successfulAnalysis(),
  runCoverageAnalysis: async () => successfulCoverage(),
});

const project = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
  await writeFile(path.join(root, "foundry.toml"), "[profile.default]\nsrc='contracts'\ntest='spec'\n");
  await mkdir(path.join(root, "contracts"));
  await mkdir(path.join(root, "spec"));
  return root;
};

describe("CLI", () => {
  it("shows help", async () => {
    const output = capture();
    expect(await runCli(["--help"], tools(), output.io)).toBe(0);
    expect(output.stdout.join("\n")).toContain("analyze <path> --out <directory>");
  });

  it("does not let --help hide invalid arguments", async () => {
    const output = capture();
    expect(await runCli(["comando-inventado", "--help"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("unknown command");
  });

  it("rejects a missing path with a specific error", async () => {
    const output = capture();
    expect(await runCli(["analyze", "/path/that/does/not/exist", "--out", "reports"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("does not exist");
  });

  it("rejects a directory that is not a Foundry project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    const output = capture();
    expect(await runCli(["analyze", root, "--out", "reports"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("foundry.toml");
  });

  it("resolves absolute paths and uses effective source/test paths", async () => {
    const root = await project();
    const output = capture();
    const outputArgument = path.relative(process.cwd(), path.join(root, "relative-report"));
    expect(await runCli(["analyze", root, "--out", outputArgument], tools(), output.io)).toBe(0);
    const text = output.stdout.join("\n");
    expect(text).toContain(path.join(root, "contracts"));
    expect(text).toContain(path.join(root, "spec"));
    expect(text).toContain(path.resolve(outputArgument));
    expect(text).toContain("forge 1.2.3");
    expect(text).toContain(path.resolve("tools/forge"));
    expect((await stat(path.resolve(outputArgument))).isDirectory()).toBe(true);
  });

  it.each(["forge", "slither"] as const)("reports specifically when %s is missing", async (tool) => {
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    await writeFile(path.join(root, "foundry.toml"), "[profile.default]\n");
    const output = capture();
    expect(await runCli(["analyze", root, "--out", "reports"], tools(tool), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain(`${tool} was not found`);
  });

  it("rejects incomplete arguments", async () => {
    const output = capture();
    expect(await runCli(["analyze", "."], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("--out");
  });

  it("rejects an existing output path that is not a directory", async () => {
    const root = await project();
    const outputFile = path.join(root, "report-file");
    await writeFile(outputFile, "x");
    const output = capture();
    expect(await runCli(["analyze", root, "--out", outputFile], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("output");
    expect(output.stderr.join("\n")).toContain("not a directory");
  });

  it.each(["contracts", "spec"])("rejects missing effective %s directory", async (missingDirectory) => {
    const root = await project();
    await rm(path.join(root, missingDirectory), { recursive: true });
    const output = capture();
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("does not exist");
    expect(output.stderr.join("\n")).toContain(path.join(root, missingDirectory));
  });

  it("reports when a tool --version command fails", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readToolVersion = async () => { throw new Error("timeout"); };
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("forge --version");
    expect(output.stderr.join("\n")).toContain("timeout");
  });

  it("reports specifically when forge config --json fails or hangs", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readFoundryConfig = async () => { throw new Error("timeout"); };
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("forge config --json");
    expect(output.stderr.join("\n")).toContain("timeout");
  });

  it("returns 2 and skips tests when the build fails", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.runForgeAnalysis = async () => ({
      build: {
        status: "failed",
        reason: "forge build failed",
        execution: { command: "/tools/forge", args: ["build"], cwd: root, exitCode: 1, stdout: "", stderr: "Compiler error", durationMs: 2, termination: "exit" },
      },
      tests: { status: "skipped", outcome: "not-run", reason: "skipped because the build failed" },
    });
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("Build: failed");
    expect(output.stderr.join("\n")).toContain("Tests: skipped");
  });

  it.each([
    ["failed", 1, "failed tests"],
    ["zero-tests", 0, "zero tests"],
  ] as const)("returns 1 for %s", async (outcome, failed, expectedMessage) => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.runForgeAnalysis = async () => ({
      build: successfulAnalysis().build,
      tests: {
        status: "completed",
        outcome,
        execution: successfulAnalysis().tests.execution,
        summary: { total: failed, passed: 0, failed, skipped: 0, failures: [] },
      },
    });
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(1);
    expect(output.stderr.join("\n")).toContain(expectedMessage);
  });

  it("returns 2 when coverage is inconclusive", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.runCoverageAnalysis = async () => ({
      status: "inconclusive",
      reason: "could not parse LCOV",
      reportPath: path.join(root, "reports", "artifacts", "coverage.lcov"),
      execution: { command: "/tools/forge", args: ["coverage"], cwd: root, exitCode: 0, stdout: "", stderr: "", durationMs: 2, termination: "exit" },
    });
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("Coverage: inconclusive");
  });
});
