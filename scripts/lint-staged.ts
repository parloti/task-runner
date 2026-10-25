import chalk from "chalk";
import { execSync } from "node:child_process";

/** Milliseconds per second constant for time calculations. */
const MS_PER_SEC = 1000;

/**
 * Display a warning banner about not modifying files during lint-staged execution.
 * @example
 * ```typescript
 * logBanner();
 * ```
 */
const logBanner = (): void => {
  console.log(chalk.bold.underline.bgRed.inverse(">>>>> WARNING <<<<<\n"));
  console.log(
    `${chalk.red("Running")}${chalk.bold(' "lint-staged"')}${chalk.red("!")}
`,
  );
  console.log(
    `${chalk.bold.underline.red("DO NOT")}${chalk.red(" change repository files while")}${chalk.bold(
      ' "lint-staged"',
    )}${chalk.red(" is running!\n")}`,
  );
};

/**
 * Log successful completion of lint-staged with execution time.
 * @param getTimeDiff Function that returns the elapsed time string.
 * @example
 * ```typescript
 * const getTimeDiff = (): string => "120ms";
 * logSuccess(getTimeDiff);
 * ```
 */
const logSuccess = (getTimeDiff: () => string): void => {
  console.log(
    `${chalk.bold.green('"lint-staged"')}${chalk.reset()}${chalk.green(
      " executed!",
    )}`,
  );
  console.log("Files can already be changed.");
  console.log(`"lint-staged" executed in ${getTimeDiff()}`);
};

/**
 * Execute the lint-staged command with error handling.
 * @param getTimeDiff Function that returns the elapsed time string.
 * @throws {Error} Rethrows lint-staged failures for upstream handling.
 * @example
 * ```typescript
 * const getTimeDiff = (): string => "120ms";
 * runLintStagedCommand(getTimeDiff);
 * ```
 */
const runLintStagedCommand = (getTimeDiff: () => string): void => {
  try {
    execSync(`npx --yes lint-staged --config lint-staged.config.ts`, {
      stdio: "inherit",
    });
    logSuccess(getTimeDiff);
  } catch (error) {
    const message = `"lint-staged" ${chalk.bold.underline.red("FAILED")} in ${getTimeDiff()}`;
    console.error(message);
    throw error;
  }
};

/**
 * Run lint-staged with timing and status reporting.
 * @example
 * ```typescript
 * runLintStaged();
 * ```
 */
const runLintStaged = (): void => {
  const start = Date.now();
  const getTimeDiff = (): string =>
    `${String((Date.now() - start) / MS_PER_SEC)}s`;

  logBanner();
  runLintStagedCommand(getTimeDiff);
};

runLintStaged();
