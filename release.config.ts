import type { Options } from "semantic-release";

import config from "@codeperfect/commitlint-config-emoji";

/**
 * Semantic-release loads this file before build output exists, so the parser
 * behavior is intentionally duplicated here instead of importing from src/.
 */
const releaseConfig = {
  branches: ["main"],
  plugins: [
    ["@semantic-release/commit-analyzer", config.parserPreset],
    ["@semantic-release/release-notes-generator", config.parserPreset],
    "@semantic-release/npm",
    "@semantic-release/github",
  ],
} satisfies Options;

export default releaseConfig;
