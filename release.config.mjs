import emojiConfig from "@codeperfect/commitlint-config-emoji";

export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", emojiConfig.parserPreset],
    ["@semantic-release/release-notes-generator", emojiConfig.parserPreset],
    "@semantic-release/npm",
    "@semantic-release/github",
  ],
};
