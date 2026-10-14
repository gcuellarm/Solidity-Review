# Solidity Review — User and Operator Guide

This guide explains how to prepare the environment, run the current CLI, interpret its results, and diagnose common failures.

## 1. Understand the current scope

The current tool validates a local Foundry project, runs Forge build/tests, and collects LCOV coverage. Slither findings, final Markdown/JSON reports, mutation testing, and full end-to-end validation are still pending.

Treat the output as engineering evidence, not as a security certification.

## 2. Prepare the environment

### Node.js

Use Node.js 22 or newer. When using a version manager from the repository root, select the version recorded in `.node-version`.

```sh
node --version
npm --version
```

### Foundry

Install Foundry using its official installation instructions, then verify Forge:

```sh
forge --version
```

The target project must contain `foundry.toml`. Resolve its dependencies and remappings before using Solidity Review.

### Slither

Slither is currently checked as a prerequisite even though analysis integration belongs to the next implementation step. Install it in an isolated Python environment, preferably with `pipx`, and verify it:

```sh
slither --version
```

### Project dependencies

Install the exact JavaScript dependencies recorded in `package-lock.json`:

```sh
npm ci
```

## 3. Verify the target project first

Before blaming the wrapper, confirm that the target Foundry project works directly from its own root:

```sh
forge config --json
forge build
forge test --json
forge coverage --report lcov --report-file coverage.lcov --exclude-tests
```

These commands compile or execute the target project. Run only trusted local projects.

## 4. Run Solidity Review

Show help:

```sh
npm run dev -- --help
```

Analyze a project:

```sh
npm run dev -- analyze /absolute/or/relative/project --out ./reports
```

The CLI resolves both paths to absolute paths. The output directory is created when it does not exist, but an existing output path must be a directory.

## 5. Execution sequence

The current analysis follows this strict order:

1. Validate CLI syntax.
2. Validate the project directory and `foundry.toml`.
3. Locate and version-check Forge and Slither.
4. Read effective Foundry configuration.
5. Validate effective source and test directories.
6. Prepare the output directory.
7. Run `forge build`.
8. Run `forge test --json` if the build completed.
9. Run LCOV coverage when the build completed, including when tests report failures.
10. Print the phase summary and return a policy exit code.

If build fails or times out, dependent test and coverage work cannot be trusted. If test JSON or LCOV cannot be parsed, the corresponding phase is inconclusive rather than successful.

## 6. Interpret coverage

The LCOV artifact is written to:

```text
<output>/artifacts/coverage.lcov
```

The summary preserves covered and total counts. It does not infer unavailable data:

- `lines=8/10` means eight of ten reported source lines were executed.
- `branches=unavailable` means LCOV supplied no branch records; it does not mean zero or 100 percent.
- Only files inside the effective Foundry source directory contribute to target metrics.
- Tests and records outside that source scope are excluded.

Line execution alone does not prove that assertions are meaningful or that the contract is secure.

## 7. Interpret exit codes

### Exit code 0

Required phases completed and tests passed. This is an operational result, not a security approval.

### Exit code 1

The analysis completed but the configured policy was violated because tests failed or no tests ran.

### Exit code 2

Input was invalid or a required phase failed, timed out, was cancelled, or produced unreadable data. Code `2` has priority over code `1`.

## 8. Common failures

### `forge was not found in PATH`

Open a new shell after installing Foundry and verify `forge --version` in that same shell.

### `slither was not found in PATH`

Verify the isolated environment is exposed through `PATH`. For `pipx`, its binary directory commonly needs to be added to the shell configuration.

### `foundry.toml was not found`

Pass the Foundry project root, not its `src/` directory.

### Effective source or test path does not exist

Run `forge config --json` from the target project and inspect `src` and `test`. Correct the Foundry configuration or create the expected directories.

### Build failure

Run `forge build` directly in the target project. Solidity Review intentionally skips dependent work until compilation succeeds.

### Zero tests

Confirm test discovery with `forge test --list`. A zero-test suite is a policy violation, not a successful test run.

### Coverage is inconclusive

Run the exact coverage command directly, inspect compiler/profile compatibility, and check whether the LCOV file was produced. Missing branch records remain unavailable by design.

### Timeout or cancellation

The runner sends termination to the process group and escalates when necessary. Investigate slow compilation, forked RPC dependencies, hanging tests, or unusually large output before increasing limits in future configuration work.

## 9. Contributor workflow

Run the automated checks without producing a build artifact:

```sh
npm test
npm run test:local
npx tsc -p tsconfig.json --noEmit
```

Test fixtures under `tests/fixtures/` represent captured external formats. Update parsers against explicit fixtures and keep unknown or missing fields distinguishable from valid zero values.

## 10. Work still required

The tool should not be presented as complete until all of the following are implemented and verified:

1. Slither JSON execution and normalization.
2. Shared Markdown and JSON report generation.
3. Explicit findings/rules and report limitations.
4. Controlled mutation generation and classification.
5. Real fixtures for passing tests, failed tests, build failure, zero tests, partial coverage, known Slither findings, timeout, cancellation, and mutations.
6. End-to-end execution against a controlled fixture and then a trusted real project.
7. Packaged CLI validation and release documentation.

For implementation intent and acceptance criteria, consult `Guia_desarrollo_Solidity_Review.docx`.
