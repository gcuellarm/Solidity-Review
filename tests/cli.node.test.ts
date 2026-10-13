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
});

const project = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
  await writeFile(path.join(root, "foundry.toml"), "[profile.default]\nsrc='contracts'\ntest='spec'\n");
  await mkdir(path.join(root, "contracts"));
  await mkdir(path.join(root, "spec"));
  return root;
};

describe("CLI (runner local reproducible)", () => {
  it("muestra ayuda solo en una invocación válida", async () => {
    const output = capture();
    assert.equal(await runCli(["--help"], tools(), output.io), 0);
    assert.match(output.stdout.join("\n"), /analyze <ruta> --out <directorio>/);
    const invalid = capture();
    assert.equal(await runCli(["comando-inventado", "--help"], tools(), invalid.io), 2);
    assert.match(invalid.stderr.join("\n"), /comando desconocido/);
  });

  it("distingue ruta inexistente y proyecto no Foundry", async () => {
    const missing = capture();
    assert.equal(await runCli(["analyze", "/ruta/que/no/existe", "--out", "reports"], tools(), missing.io), 2);
    assert.match(missing.stderr.join("\n"), /no existe/);
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    const incompatible = capture();
    assert.equal(await runCli(["analyze", root, "--out", "reports"], tools(), incompatible.io), 2);
    assert.match(incompatible.stderr.join("\n"), /foundry\.toml/);
  });

  it("resuelve rutas, crea la salida, normaliza ejecutables y muestra versiones", async () => {
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
    it(`informa específicamente si falta ${tool}`, async () => {
      const root = await project();
      const output = capture();
      assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(tool), output.io), 2);
      assert.match(output.stderr.join("\n"), new RegExp(`No se encontró ${tool}`));
    });
  }

  it("rechaza argumentos incompletos", async () => {
    const output = capture();
    assert.equal(await runCli(["analyze", "."], tools(), output.io), 2);
    assert.match(output.stderr.join("\n"), /--out/);
  });

  it("rechaza una salida existente que no es directorio", async () => {
    const root = await project();
    const outputFile = path.join(root, "report-file");
    await writeFile(outputFile, "x");
    const output = capture();
    assert.equal(await runCli(["analyze", root, "--out", outputFile], tools(), output.io), 2);
    assert.match(output.stderr.join("\n"), /salida no es un directorio/);
  });

  for (const missingDirectory of ["contracts", "spec"] as const) {
    it(`rechaza ${missingDirectory} efectivo inexistente`, async () => {
      const root = await project();
      await rm(path.join(root, missingDirectory), { recursive: true });
      const output = capture();
      assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(), output.io), 2);
      assert.match(output.stderr.join("\n"), /ruta efectiva.*no existe/);
      assert.ok(output.stderr.join("\n").includes(path.join(root, missingDirectory)));
    });
  }

  it("informa si una herramienta existe pero --version falla", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readToolVersion = async () => { throw new Error("timeout"); };
    assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io), 2);
    assert.match(output.stderr.join("\n"), /forge --version/);
    assert.match(output.stderr.join("\n"), /timeout/);
  });

  it("informa específicamente si forge config --json falla o se cuelga", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readFoundryConfig = async () => { throw new Error("timeout"); };
    assert.equal(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io), 2);
    assert.match(output.stderr.join("\n"), /forge config --json/);
    assert.match(output.stderr.join("\n"), /timeout/);
  });
});
