#!/usr/bin/env node

import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

type FoundryConfig = {
  src?: unknown;
  test?: unknown;
};

export type CliDependencies = {
  findExecutable(name: "forge" | "slither"): Promise<string | undefined>;
  readToolVersion(executable: string): Promise<string>;
  readFoundryConfig(projectRoot: string, forgePath: string): Promise<FoundryConfig>;
};

type CliIo = {
  out(text: string): void;
  err(text: string): void;
};

const HELP = `Solidity Review

Uso:
  solidity-review analyze <ruta> --out <directorio>
  solidity-review --help

Valida que la ruta sea un proyecto Foundry y que Forge y Slither estén disponibles.
No ejecuta todavía una auditoría ni garantiza la seguridad del proyecto.`;

async function findExecutable(name: "forge" | "slither"): Promise<string | undefined> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continuar buscando en PATH.
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
    throw new Error("la herramienta no devolvió información de versión");
  }
  return version;
}

const defaultDependencies: CliDependencies = { findExecutable, readToolVersion, readFoundryConfig };
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
    return fail(io, `comando desconocido "${args[0]}". Usá --help para ver la sintaxis.`);
  }

  const projectArgument = args[1];
  if (projectArgument === undefined || projectArgument.startsWith("-")) {
    return fail(io, "falta <ruta> del proyecto Foundry.");
  }

  const outIndex = args.indexOf("--out");
  const outputArgument = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outputArgument === undefined || outputArgument.startsWith("-")) {
    return fail(io, "falta --out <directorio>.");
  }

  const expectedLength = 4;
  if (args.length !== expectedLength || outIndex !== 2) {
    return fail(io, "argumentos no reconocidos. Usá: analyze <ruta> --out <directorio>.");
  }

  const projectRoot = path.resolve(projectArgument);
  const outputDirectory = path.resolve(outputArgument);

  try {
    const projectStats = await stat(projectRoot);
    if (!projectStats.isDirectory()) {
      return fail(io, `la ruta del proyecto no es un directorio: ${projectRoot}`);
    }
  } catch {
    return fail(io, `la ruta del proyecto no existe: ${projectRoot}`);
  }

  const foundryFile = path.join(projectRoot, "foundry.toml");
  try {
    const foundryStats = await stat(foundryFile);
    if (!foundryStats.isFile()) {
      return fail(io, `foundry.toml no es un archivo: ${foundryFile}`);
    }
  } catch {
    return fail(io, `no se encontró foundry.toml en ${projectRoot}; no parece un proyecto Foundry compatible.`);
  }

  const discoveredForgePath = await dependencies.findExecutable("forge");
  if (discoveredForgePath === undefined) {
    return fail(io, "No se encontró forge en PATH. Instalá Foundry y verificá `forge --version`.");
  }
  const forgePath = path.resolve(discoveredForgePath);

  const discoveredSlitherPath = await dependencies.findExecutable("slither");
  if (discoveredSlitherPath === undefined) {
    return fail(io, "No se encontró slither en PATH. Instalalo en un entorno aislado y verificá `slither --version`.");
  }
  const slitherPath = path.resolve(discoveredSlitherPath);

  let forgeVersion: string;
  try {
    forgeVersion = await dependencies.readToolVersion(forgePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `no se pudo ejecutar forge --version (${forgePath}): ${detail}`);
  }

  let slitherVersion: string;
  try {
    slitherVersion = await dependencies.readToolVersion(slitherPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `no se pudo ejecutar slither --version (${slitherPath}): ${detail}`);
  }

  let config: FoundryConfig;
  try {
    config = await dependencies.readFoundryConfig(projectRoot, forgePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(io, `no se pudo ejecutar forge config --json para leer la configuración efectiva: ${detail}`);
  }

  const sourceDirectory = path.resolve(projectRoot, configuredPath(config.src, "src"));
  const testDirectory = path.resolve(projectRoot, configuredPath(config.test, "test"));

  for (const [label, directory] of [["fuentes", sourceDirectory], ["tests", testDirectory]] as const) {
    try {
      const directoryStats = await stat(directory);
      if (!directoryStats.isDirectory()) {
        return fail(io, `la ruta efectiva de ${label} no es un directorio: ${directory}`);
      }
    } catch {
      return fail(io, `la ruta efectiva de ${label} no existe: ${directory}`);
    }
  }

  try {
    const outputStats = await stat(outputDirectory);
    if (!outputStats.isDirectory()) {
      return fail(io, `la ruta de salida no es un directorio: ${outputDirectory}`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(io, `no se pudo utilizar el directorio de salida ${outputDirectory}: ${detail}`);
    }
    try {
      await mkdir(outputDirectory, { recursive: true });
    } catch (creationError) {
      const detail = creationError instanceof Error ? creationError.message : String(creationError);
      return fail(io, `no se pudo crear el directorio de salida ${outputDirectory}: ${detail}`);
    }
  }

  io.out([
    "Proyecto Foundry válido.",
    `Proyecto: ${projectRoot}`,
    `Fuentes: ${sourceDirectory}`,
    `Tests: ${testDirectory}`,
    `Salida: ${outputDirectory}`,
    `Forge: ${forgePath} — ${forgeVersion}`,
    `Slither: ${slitherPath} — ${slitherVersion}`,
  ].join("\n"));
  return 0;
}

const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
