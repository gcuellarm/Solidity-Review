# Solidity Review

Solidity Review is a work-in-progress TypeScript CLI for collecting reproducible evidence from local Foundry projects. It validates the target, runs Forge build and tests, and extracts LCOV coverage into an internal model.

It is **not a security auditor**, does not assign a security score, and does not guarantee that a contract is safe.

## Current status

The project is functional at the unit and orchestration-test level, but it is **not finished** and has not yet been validated end to end against a controlled Foundry fixture.

Completed:

- **Step 1:** CLI arguments, Foundry project validation, effective `src`/`test` paths, and Forge/Slither availability checks.
- **Step 2:** safe process execution, `forge build`, `forge test --json`, timeouts, cancellation, child-process cleanup, and explicit zero-test detection.
- **Step 3:** `forge coverage` with LCOV parsing, per-file metrics, uncovered lines, and explicit unavailable metrics.

Remaining for the usable MVP:

- **Step 4:** run Slither, parse its JSON output, preserve impact/confidence and locations, and distinguish findings from operational failure.
- **Step 5:** generate consistent `report.md` and `report.json` files and add the initial policy rules.

Remaining for the complete development plan:

- **Steps 6–7:** controlled mutation testing on isolated project copies.
- **Step 8:** controlled Foundry fixtures, real end-to-end validation, a real-project trial, and release-quality documentation.
- Validate the packaged `dist/cli.js` executable. The repository currently runs from TypeScript source.

## How the tool currently works

For this command:

```sh
npm run dev -- analyze ./my-foundry-project --out ./reports
```

the CLI performs these operations in order:

1. Parses the command and resolves absolute project/output paths.
2. Requires a real project directory containing `foundry.toml`.
3. Locates Forge and Slither in `PATH` and records their version output.
4. Runs `forge config --json` to obtain effective source and test paths instead of assuming `src/` and `test/`.
5. Validates those directories and creates the output directory when needed.
6. Runs `forge build` with an explicit working directory, separated arguments, no shell, bounded output, timeout, and process-group cleanup.
7. Runs `forge test --json` only after a successful build and classifies the suite as passed, failed, zero tests, or inconclusive.
8. Runs Forge coverage and stores LCOV at `<output>/artifacts/coverage.lcov`.
9. Restricts coverage metrics to the effective source directory. Missing function or branch data remains unavailable rather than being reported as zero or 100 percent.
10. Prints an English summary and returns the CLI policy exit code.

The current implementation does **not** run Slither analysis yet and does **not** generate `report.md` or `report.json`.

## Requirements

- Node.js 22 or newer (`.node-version` selects Node 22).
- npm.
- Foundry/Forge available in `PATH`.
- Slither available in `PATH`; an isolated `pipx` installation is recommended.
- A trusted local Foundry project. Do not use this version to execute unknown repositories.

## Installation

```sh
npm ci
node --version
forge --version
slither --version
```

## Usage

```sh
npm run dev -- --help
npm run dev -- analyze ./my-foundry-project --out ./reports
```

Current output artifact:

```text
reports/
└── artifacts/
    └── coverage.lcov
```

See [USER_GUIDE.md](./USER_GUIDE.md) for detailed instructions and troubleshooting.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Required phases completed and the selected tests passed. |
| `1` | Analysis completed, but tests failed or zero tests were executed. |
| `2` | Invalid input or a required phase failed, timed out, or produced unreadable data. This takes priority over code `1`. |

External-tool exit codes are interpreted; they are not returned directly by the CLI.

## Architecture

```text
src/cli.ts                 CLI parsing, validation, orchestration, and policy
src/runners/process.ts     safe common child-process execution
src/runners/forge.ts       Forge build/test workflow
src/runners/coverage.ts    Forge coverage execution and LCOV artifact handling
src/parsers/forge-test.ts  Forge JSON normalization
src/parsers/lcov.ts        LCOV normalization and source filtering
src/types.ts               shared internal data model
tests/                     unit/orchestration tests and captured samples
```

Operational state is deliberately separate from quality results. A completed analysis may find failed tests; a tool that could not run is not equivalent to a clean result.

## Development checks

```sh
npm test
npm run test:local
npx tsc -p tsconfig.json --noEmit
```

Current verified baseline:

- 31 Vitest tests passing.
- 11 local runner tests passing.
- TypeScript strict checking passing.

These checks do not replace the pending real Foundry end-to-end validation.

## Security boundaries

- Commands use separated arguments and `shell: false`.
- Processes run in the selected project directory with time and output limits.
- Cancellation terminates the spawned process group on macOS/Linux.
- Coverage data is limited to the effective source directory.
- The tool currently assumes trusted local projects and does not provide network, filesystem, FFI, or secret isolation for hostile repositories.

## Roadmap

1. Integrate and normalize Slither JSON.
2. Generate Markdown and JSON reports from one shared model.
3. Add policy rules for failed tests, zero tests, and uncovered locations.
4. Add controlled mutation testing.
5. Validate every documented scenario against real fixtures.
6. Package and verify the distributable CLI.

The original implementation plan is stored in `Guia_desarrollo_Solidity_Review.docx`. Development notes are maintained separately in `cuaderno_de_ruta.md` and are intentionally excluded from Git.
