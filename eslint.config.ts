import { config } from "@codeperfect/eslint-config";
import { defineConfig } from "eslint/config";

/** CodePerfect ESLint configuration. */
const codePerfect = await config({
  plugins: { playwright: false, "rxjs-x": false, "vitest-e2e": true },
});

/** Combined ESLint configuration for the solution. */
const eslintConfig = defineConfig(codePerfect);

export default eslintConfig;
