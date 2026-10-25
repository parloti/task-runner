import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  { ignores: ["dist/**", "coverage/**", "artifacts/**", "logs/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: [
      "src/domain/**/*.ts",
      "src/application/**/*.ts",
      "src/presets/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/infrastructure/**",
                "**/presentation/**",
                "**/bootstrap/**",
                "node:*",
              ],
              message:
                "Inner layers and pure presets cannot depend on adapters.",
            },
          ],
        },
      ],
    },
  },
);
