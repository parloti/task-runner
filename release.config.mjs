import config from "@codeperfect/commitlint-config-emoji";

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", config.parserPreset],
    ["@semantic-release/release-notes-generator", config.parserPreset],
    "@semantic-release/npm",
    "@semantic-release/github",
  ],
};
