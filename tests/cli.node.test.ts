import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli, type CliDependencies } from "../src/cli.ts";

const capture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) } };
};

const tools = (missing?: "forge" | "slither"): CliDependencies => ({
  findExecutable: async (name) => name === missing ? undefined : `tools/${name}`,
  readToolVersion: async (executable) => `${path.basename(executable)} 1.2.3`,
  readFoundryConfig: async () => ({ src: "contracts", test: "spec" }),
  runForgeAnalysis: async () => ({
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
  }),
  runCoverageAnalysis: async () => ({
    status: "completed",
    execution: { command: "/tools/forge", args: ["coverage"], cwd: "/project", exitCode: 0, stdout: "", stderr: "", durationMs: 1, termination: "exit" },
    reportPath: "/reports/artifacts/coverage.lcov",
    summary: {
      files: [],
      totals: { lines: { covered: 1, total: 1 }, functions: null, branches: null },
      excluded: [],
    },
  }),
});

const project = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
  await writeFile(path.join(root, "foundry.toml"), "[profile.default]\nsrc='contracts'\ntest='spec'\n");
  await mkdir(path.join(root, "contracts"));
  await mkdir(path.join(root, "spec"));
  return root;
};

describe("CLI (reproducible local runner)", () => {
  it("shows help only for a valid invocation", async () => {
    const output = capture();
    assert.equal(await runCli(["--help"], tools(), output.io), 0);
    assert.match(output.stdout.join("\n"), /analyze <path> --out <directory>/);
    const invalid = capture();
    assert.equal(await runCli(["comando-inventado", "--help"], tools(), invalid.io), 2);
    assert.match(invalid.stderr.join("\n"), /unknown command/);
  });

  it("distinguishes a missing path from a non-Foundry project", async () => {
    const missing = capture();
    assert.equal(await runCli(["analyze", "/path/that/does/not/exist", "--out", "reports"], tools(), missing.io), 2);
    assert.match(missing.stderr.join("\n"), /does not exist/);
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    const incompatible = capture();
    assert.equal(await runCli(["analyze", root, "--out", "reports"], tools(), incompatible.io), 2);
    assert.match(incompatible.stderr.join("\n"), /foundry\.toml/);
  });

  it("resolves paths, creates output, normalizes executables, and shows versions", async () => {
    const root = await project();
    const outputArgument = path.relative(process.cwd(), path.join(root, "relative-report"));
    const output = capture();
    assert.equal(await runCli(["analyze", root, "--out", outputArgument], tools(), output.io), 0);
    const text = output.stdout.join("\n");
    assert.ok(text.includes(path.join(root, "contracts")));
    assert.ok(text.includes(path.join(root, "spec")));
    assert.ok(text.includes(path.resolve(outputArgument)));
    assert.ok(text.includes(path.resolve("tools/forge")));
    assert.match(text, /forge 1\.2\.3/);
    assert.equal((await stat(path.resolve(outputArgument))).isDirectory(), true);
  });

  for (const tool of ["forge", "slither"] as const) {
    it(`reports specifically when ${tool} is missing`, async () => {
      const root = await project();
      const output = capture();
      assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(tool), output.io), 2);
      assert.match(output.stderr.join("\n"), new RegExp(`${tool} was not found`));
    });
  }

  it("rejects incomplete arguments", async () => {
    const output = capture();
    assert.equal(await runCli(["analyze", "."], tools(), output.io), 2);
    assert.match(output.stderr.join("\n"), /--out/);
  });

  it("rejects an existing output path that is not a directory", async () => {
    const root = await project();
    const outputFile = path.join(root, "report-file");
    await writeFile(outputFile, "x");
    const output = capture();
    assert.equal(await runCli(["analyze", root, "--out", outputFile], tools(), output.io), 2);
    assert.match(output.stderr.join("\n"), /output path is not a directory/);
  });

  for (const missingDirectory of ["contracts", "spec"] as const) {
    it(`rejects missing effective ${missingDirectory}`, async () => {
      const root = await project();
      await rm(path.join(root, missingDirectory), { recursive: true });
      const output = capture();
      assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(), output.io), 2);
      assert.match(output.stderr.join("\n"), /effective.*path does not exist/);
      assert.ok(output.stderr.join("\n").includes(path.join(root, missingDirectory)));
    });
  }

  it("reports when a tool exists but --version fails", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readToolVersion = async () => { throw new Error("timeout"); };
    assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io), 2);
    assert.match(output.stderr.join("\n"), /forge --version/);
    assert.match(output.stderr.join("\n"), /timeout/);
  });

  it("reports specifically when forge config --json fails or hangs", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readFoundryConfig = async () => { throw new Error("timeout"); };
    assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io), 2);
    assert.match(output.stderr.join("\n"), /forge config --json/);
    assert.match(output.stderr.join("\n"), /timeout/);
  });
});
