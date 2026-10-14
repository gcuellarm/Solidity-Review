import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseForgeTestJson } from "../src/parsers/forge-test.js";
import { runForgeChecks } from "../src/runners/forge.js";
import { runProcess } from "../src/runners/process.js";
import type { ProcessResult, ProcessRunner } from "../src/types.js";

const result = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  command: "/tools/forge",
  args: [],
  cwd: "/project",
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  termination: "exit",
  ...overrides,
});

const fixture = (name: string): string => readFileSync(
  new URL(`./fixtures/forge-test/${name}.json`, import.meta.url),
  "utf8",
);

describe("parseForgeTestJson", () => {
  it("counts passed, failed, and skipped tests", () => {
    const summary = parseForgeTestJson(fixture("failed"));

    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(summary.failures).toEqual([{ name: "testBad()", reason: "assertion failed" }]);
  });

  it("distinguishes valid output containing zero tests", () => {
    expect(parseForgeTestJson(fixture("zero-tests"))).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it("rejects JSON without the Forge results structure", () => {
    expect(() => parseForgeTestJson('{"arbitrary":true}')).toThrow(/structure/i);
  });
});

describe("runForgeChecks", () => {
  it("runs build before tests and summarizes a passing suite", async () => {
    const runner = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: JSON.stringify({ suite: { test_results: { "testOk()": { status: "Success" } } } }) }));

    const analysis = await runForgeChecks("/project", "/tools/forge", { runner });

    expect(runner.mock.calls.map((call) => call[0].args)).toEqual([["build"], ["test", "--json"]]);
    expect(analysis.build.status).toBe("completed");
    expect(analysis.tests).toMatchObject({ status: "completed", outcome: "passed", summary: { total: 1 } });
  });

  it("skips tests when the build fails", async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue(result({ exitCode: 1, stderr: "Compiler error" }));
    const analysis = await runForgeChecks("/project", "/tools/forge", { runner });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(analysis.build.status).toBe("failed");
    expect(analysis.tests).toMatchObject({ status: "skipped", outcome: "not-run" });
  });

  it("distinguishes failed tests, zero tests, and timeout", async () => {
    const failing = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ exitCode: 1, stdout: JSON.stringify({ suite: { test_results: { "testBad()": { status: "Failure" } } } }) }));
    expect((await runForgeChecks("/project", "/tools/forge", { runner: failing })).tests.outcome).toBe("failed");

    const empty = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: "{}" }));
    expect((await runForgeChecks("/project", "/tools/forge", { runner: empty })).tests.outcome).toBe("zero-tests");

    const timeout = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ exitCode: null, termination: "timeout" }));
    expect((await runForgeChecks("/project", "/tools/forge", { runner: timeout })).tests).toMatchObject({ status: "inconclusive", outcome: "not-run" });
  });
});

describe("runProcess", () => {
  it("captures stdout, stderr, and exit code without a shell", async () => {
    const execution = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });
    expect(execution).toMatchObject({ exitCode: 0, stdout: "out", stderr: "err", termination: "exit" });
  });

  it("marks a timeout and terminates the process", async () => {
    const execution = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      timeoutMs: 20,
    });
    expect(execution).toMatchObject({ exitCode: null, termination: "timeout" });
  });

  it("supports cancellation through AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const execution = await runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    expect(execution).toMatchObject({ exitCode: null, termination: "cancelled" });
  });
});
