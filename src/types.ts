export type PhaseStatus = "completed" | "failed" | "skipped" | "inconclusive";

export type ProcessTermination = "exit" | "timeout" | "cancelled" | "output-limit" | "error";

export type ProcessOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
};

export type ProcessResult = {
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  termination: ProcessTermination;
  reason?: string;
};

export type ProcessRunner = (options: ProcessOptions) => Promise<ProcessResult>;

export type TestFailure = {
  name: string;
  reason?: string;
};

export type ForgeTestSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
};

export type BuildPhase = {
  status: Exclude<PhaseStatus, "skipped">;
  execution: ProcessResult;
  reason?: string;
};

export type TestOutcome = "passed" | "failed" | "zero-tests" | "not-run";

export type TestPhase = {
  status: PhaseStatus;
  outcome: TestOutcome;
  execution?: ProcessResult;
  summary?: ForgeTestSummary;
  reason?: string;
};

export type ForgeAnalysis = {
  build: BuildPhase;
  tests: TestPhase;
};

export type CoverageMetric = {
  covered: number;
  total: number;
};

export type FileCoverage = {
  path: string;
  lines: CoverageMetric | null;
  functions: CoverageMetric | null;
  branches: CoverageMetric | null;
  uncoveredLines: number[];
};

export type CoverageSummary = {
  files: FileCoverage[];
  totals: {
    lines: CoverageMetric | null;
    functions: CoverageMetric | null;
    branches: CoverageMetric | null;
  };
  excluded: string[];
};

export type CoveragePhase = {
  status: Exclude<PhaseStatus, "skipped">;
  execution: ProcessResult;
  reportPath: string;
  summary?: CoverageSummary;
  reason?: string;
};
