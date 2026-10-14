import type { ForgeTestSummary, TestFailure } from "../types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseForgeTestJson(text: string): ForgeTestSummary {
  const parsed = JSON.parse(text) as unknown;
  const suites = record(parsed);
  if (suites === undefined) {
    throw new Error("the JSON output does not contain the Forge suite structure");
  }

  let foundTestResults = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: TestFailure[] = [];

  for (const suiteValue of Object.values(suites)) {
    const suite = record(suiteValue);
    const testResults = record(suite?.test_results);
    if (testResults === undefined) {
      continue;
    }
    foundTestResults = true;

    for (const [name, testValue] of Object.entries(testResults)) {
      const test = record(testValue);
      const status = test?.status;
      if (status === "Success") {
        passed += 1;
      } else if (status === "Failure") {
        failed += 1;
        const reason = typeof test?.reason === "string" ? test.reason : undefined;
        failures.push(reason === undefined ? { name } : { name, reason });
      } else if (status === "Skipped") {
        skipped += 1;
      } else {
        throw new Error(`unrecognized Forge test status for ${name}`);
      }
    }
  }

  if (!foundTestResults && Object.keys(suites).length > 0) {
    throw new Error("the JSON output does not contain the Forge test-results structure");
  }

  return { total: passed + failed + skipped, passed, failed, skipped, failures };
}
