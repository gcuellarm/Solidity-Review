import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliDependencies } from "../src/cli.js";

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

describe("CLI", () => {
  it("muestra ayuda", async () => {
    const output = capture();
    expect(await runCli(["--help"], tools(), output.io)).toBe(0);
    expect(output.stdout.join("\n")).toContain("analyze <ruta> --out <directorio>");
  });

  it("no deja que --help oculte argumentos inválidos", async () => {
    const output = capture();
    expect(await runCli(["comando-inventado", "--help"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("comando desconocido");
  });

  it("rechaza una ruta inexistente con un error específico", async () => {
    const output = capture();
    expect(await runCli(["analyze", "/ruta/que/no/existe", "--out", "reports"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("no existe");
  });

  it("rechaza un directorio que no es un proyecto Foundry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    const output = capture();
    expect(await runCli(["analyze", root, "--out", "reports"], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("foundry.toml");
  });

  it("resuelve rutas absolutas y usa src/test efectivos", async () => {
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

  it.each(["forge", "slither"] as const)("informa específicamente si falta %s", async (tool) => {
    const root = await mkdtemp(path.join(tmpdir(), "solidity-review-"));
    await writeFile(path.join(root, "foundry.toml"), "[profile.default]\n");
    const output = capture();
    expect(await runCli(["analyze", root, "--out", "reports"], tools(tool), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain(`No se encontró ${tool}`);
  });

  it("rechaza argumentos incompletos", async () => {
    const output = capture();
    expect(await runCli(["analyze", "."], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("--out");
  });

  it("rechaza una salida existente que no es directorio", async () => {
    const root = await project();
    const outputFile = path.join(root, "report-file");
    await writeFile(outputFile, "x");
    const output = capture();
    expect(await runCli(["analyze", root, "--out", outputFile], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("salida");
    expect(output.stderr.join("\n")).toContain("no es un directorio");
  });

  it.each(["contracts", "spec"])("rechaza %s efectivo inexistente", async (missingDirectory) => {
    const root = await project();
    await rm(path.join(root, missingDirectory), { recursive: true });
    const output = capture();
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], tools(), output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("no existe");
    expect(output.stderr.join("\n")).toContain(path.join(root, missingDirectory));
  });

  it("informa cuando --version de una herramienta falla", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readToolVersion = async () => { throw new Error("timeout"); };
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("forge --version");
    expect(output.stderr.join("\n")).toContain("timeout");
  });

  it("informa específicamente si forge config --json falla o se cuelga", async () => {
    const root = await project();
    const output = capture();
    const dependencies = tools();
    dependencies.readFoundryConfig = async () => { throw new Error("timeout"); };
    expect(await runCli(["analyze", root, "--out", path.join(root, "reports")], dependencies, output.io)).toBe(2);
    expect(output.stderr.join("\n")).toContain("forge config --json");
    expect(output.stderr.join("\n")).toContain("timeout");
  });
});
