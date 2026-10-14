import path from "node:path";
import type { CoverageMetric, CoverageSummary, FileCoverage } from "../types.js";

type MutableFileCoverage = {
  sourceFile: string;
  lines: Map<number, number>;
  functions: number[];
  branches: Array<number | null>;
  hasLineData: boolean;
  hasFunctionData: boolean;
  hasBranchData: boolean;
};

function metric(values: readonly number[]): CoverageMetric {
  return { covered: values.filter((value) => value > 0).length, total: values.length };
}

function portableRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function totals(files: readonly FileCoverage[], key: "lines" | "functions" | "branches"): CoverageMetric | null {
  const available = files.flatMap((file) => file[key] === null ? [] : [file[key]]);
  if (available.length === 0) return null;
  return available.reduce<CoverageMetric>(
    (sum, current) => ({ covered: sum.covered + current.covered, total: sum.total + current.total }),
    { covered: 0, total: 0 },
  );
}

export function parseLcov(text: string, projectRoot: string, sourceRoot: string): CoverageSummary {
  const records: MutableFileCoverage[] = [];
  let current: MutableFileCoverage | undefined;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      const sourceFile = line.slice(3);
      if (sourceFile.length === 0) throw new Error("LCOV contains an empty SF path");
      current = {
        sourceFile,
        lines: new Map(),
        functions: [],
        branches: [],
        hasLineData: false,
        hasFunctionData: false,
        hasBranchData: false,
      };
      records.push(current);
    } else if (line.startsWith("DA:") && current !== undefined) {
      const [lineText, countText] = line.slice(3).split(",");
      const lineNumber = Number(lineText);
      const count = Number(countText);
      if (!Number.isInteger(lineNumber) || !Number.isFinite(count)) throw new Error(`invalid LCOV DA record: ${line}`);
      current.hasLineData = true;
      current.lines.set(lineNumber, (current.lines.get(lineNumber) ?? 0) + count);
    } else if (line.startsWith("FNDA:") && current !== undefined) {
      const [countText] = line.slice(5).split(",");
      const count = Number(countText);
      if (!Number.isFinite(count)) throw new Error(`invalid LCOV FNDA record: ${line}`);
      current.hasFunctionData = true;
      current.functions.push(count);
    } else if (line.startsWith("BRDA:") && current !== undefined) {
      const fields = line.slice(5).split(",");
      const takenText = fields[3];
      if (takenText === undefined) throw new Error(`invalid LCOV BRDA record: ${line}`);
      const taken = takenText === "-" ? null : Number(takenText);
      if (taken !== null && !Number.isFinite(taken)) throw new Error(`invalid LCOV BRDA record: ${line}`);
      current.hasBranchData = true;
      current.branches.push(taken);
    }
  }

  if (records.length === 0) throw new Error("no SF records were found in the LCOV report");

  const files: FileCoverage[] = [];
  const excluded: string[] = [];
  for (const record of records) {
    const absoluteFile = path.resolve(projectRoot, record.sourceFile);
    const relativeFile = portableRelative(projectRoot, absoluteFile);
    if (!isInside(sourceRoot, absoluteFile)) {
      excluded.push(relativeFile);
      continue;
    }
    const lineEntries = [...record.lines.entries()].sort(([left], [right]) => left - right);
    files.push({
      path: relativeFile,
      lines: record.hasLineData ? metric(lineEntries.map(([, count]) => count)) : null,
      functions: record.hasFunctionData ? metric(record.functions) : null,
      branches: record.hasBranchData ? metric(record.branches.map((taken) => taken ?? 0)) : null,
      uncoveredLines: lineEntries.filter(([, count]) => count === 0).map(([lineNumber]) => lineNumber),
    });
  }

  return {
    files,
    totals: {
      lines: totals(files, "lines"),
      functions: totals(files, "functions"),
      branches: totals(files, "branches"),
    },
    excluded,
  };
}
