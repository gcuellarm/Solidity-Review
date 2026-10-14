import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLcov } from "../src/parsers/lcov.js";
import { runForgeCoverage } from "../src/runners/coverage.js";
import type { ProcessResult, ProcessRunner } from "../src/types.js";

const execution = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  command: "/tools/forge",
  args: [],
  cwd: "/project",
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 3,
  termination: "exit",
  ...overrides,
});

describe("parseLcov", () => {
  it("calculates lines and functions, keeps uncovered locations, and does not invent branches", async () => {
    const lcov = await readFile(new URL("./fixtures/coverage/partial.lcov", import.meta.url), "utf8");
    const coverage = parseLcov(lcov, "/project", "/project/src");

    expect(coverage.files).toHaveLength(1);
    expect(coverage.files[0]).toMatchObject({
      path: "src/Example.sol",
      lines: { covered: 2, total: 3 },
      functions: { covered: 1, total: 1 },
      branches: null,
      uncoveredLines: [3],
    });
    expect(coverage.totals).toMatchObject({
      lines: { covered: 2, total: 3 },
      functions: { covered: 1, total: 1 },
      branches: null,
    });
    expect(coverage.excluded).toEqual(["test/Example.t.sol"]);
  });

  it("rejects unreadable LCOV instead of reporting zero coverage", () => {
    expect(() => parseLcov("not-lcov", "/project", "/project/src")).toThrow(/LCOV/i);
  });

  it("includes branches only when LCOV provides them", () => {
    const coverage = parseLcov([
      "SF:/project/src/Branch.sol",
      "DA:2,1",
      "BRDA:2,0,0,1",
      "BRDA:2,0,1,-",
      "end_of_record",
    ].join("\n"), "/project", "/project/src");
    expect(coverage.totals.branches).toEqual({ covered: 1, total: 2 });
  });
});

describe("runForgeCoverage", () => {
  it("stores LCOV in the run directory and returns partial metrics", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "solidity-review-coverage-"));
    const reportPath = path.join(output, "artifacts", "coverage.lcov");
    const sample = await readFile(new URL("./fixtures/coverage/partial.lcov", import.meta.url), "utf8");
    const runner = vi.fn<ProcessRunner>(async (options) => {
      await writeFile(reportPath, sample, { flag: "w" });
      return execution({ args: options.args, cwd: options.cwd });
    });

    const phase = await runForgeCoverage("/project", "/tools/forge", "/project/src", reportPath, { runner });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: "/tools/forge",
      cwd: "/project",
      args: ["coverage", "--report", "lcov", "--report-file", reportPath, "--exclude-tests"],
    }));
    expect(phase).toMatchObject({ status: "completed", reportPath, summary: { totals: { lines: { covered: 2, total: 3 }, branches: null } } });
  });

  it("distinguishes failure and timeout without inventing metrics", async () => {
    const failed = vi.fn<ProcessRunner>().mockResolvedValue(execution({ exitCode: 1, stderr: "coverage failed" }));
    const failedPhase = await runForgeCoverage("/project", "/tools/forge", "/project/src", "/tmp/missing.lcov", { runner: failed });
    expect(failedPhase.status).toBe("failed");
    expect(failedPhase.summary).toBeUndefined();

    const timeout = vi.fn<ProcessRunner>().mockResolvedValue(execution({ exitCode: null, termination: "timeout" }));
    const timeoutPhase = await runForgeCoverage("/project", "/tools/forge", "/project/src", "/tmp/missing.lcov", { runner: timeout });
    expect(timeoutPhase.status).toBe("inconclusive");
    expect(timeoutPhase.summary).toBeUndefined();
  });
});
