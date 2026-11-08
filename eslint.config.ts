import { config } from "@codeperfect/eslint-config";
import {
  createTypeScriptImportResolver,
  defaultConditionNames,
} from "eslint-import-resolver-typescript";
import { defineConfig } from "eslint/config";

/** CodePerfect ESLint configuration. */
const codePerfect = await config({
  plugins: { playwright: false, "rxjs-x": false, "vitest-e2e": true },
});

const sourceResolution = defineConfig({
  files: ["**/*.ts"],
  settings: {
    "import-x/resolver-next": [
      createTypeScriptImportResolver({
        alwaysTryTypes: true,
        conditionNames: ["source", ...defaultConditionNames],
      }),
    ],
    "import/resolver": {
      typescript: {
        alwaysTryTypes: true,
        conditionNames: ["source", ...defaultConditionNames],
      },
    },
  },
});

/** Combined ESLint configuration for the solution. */
const eslintConfig = defineConfig(codePerfect, sourceResolution);

export default eslintConfig;
