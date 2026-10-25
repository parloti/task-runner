import type { Configuration } from "lint-staged";

export default {
  "!*.{css,scss,sass,htm,html,js,ts}":
    "npx --yes prettier --ignore-unknown --write",
  "*.{htm,html,js,ts}": [
    "npx --yes prettier --ignore-unknown --write",
    "npx --yes eslint --no-warn-ignored --fix",
  ],
} satisfies Configuration;
