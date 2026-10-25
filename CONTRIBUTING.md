# Contributing

Thanks for helping improve Task Runner. Bug reports, focused fixes, documentation
updates, and feature proposals are welcome.

Before opening an issue, check the existing [issues](https://github.com/parloti/task-runner/issues). Use the
templates for [bug reports](.github/ISSUE_TEMPLATE/bug_report.md), [feature requests](.github/ISSUE_TEMPLATE/feature_request.md),
and [documentation requests](.github/ISSUE_TEMPLATE/docs_request.md).

## Development setup

Task Runner requires Node.js 24 or newer.

```bash
git clone https://github.com/parloti/task-runner.git
cd task-runner
npm ci --allow-remote=all
```

The development lockfile includes the npm CLI used by the release tooling, so
the clean install opts into npm's remote-tarball dependencies explicitly.

The install step prepares the local source CLI shim used by this repository's
task scripts. The published package uses the compiled CLI in `dist`.

## Make and validate changes

- Keep graph policy in `src/domain`, orchestration in `src/application`, IO and
  process handling in `src/infrastructure`, CLI parsing in `src/presentation`,
  and composition in `src/bootstrap`.
- Add or update focused unit and end-to-end coverage for behavior changes.
- Keep the README, schema, and specs aligned with changes to the public
  configuration or API.
- Run `npm run validate` before opening a pull request. It runs formatting,
  linting, type checks, unit tests, end-to-end tests, and the build.
- Use `npm test` for the unit suite or `npm run e2e` for the compiled-package
  and consumer checks while iterating.

To inspect a local package artifact, run `npm pack --pack-destination artifacts`
and install the generated tarball in a consumer project. `artifacts/` is ignored;
do not commit generated tarballs.

## Branches and commits

Use `feature/<short-description>` for features or documentation work and
`fix/<short-description>` for bug fixes. Pushes to these branches run validation
and open or update a pull request to `develop`.

Use `npm run commit` to create a commit that follows the repository's emoji
conventional-commit rules in `commitlint.config.ts`.

## Pull requests

- Target `develop` for normal changes; release pull requests are prepared from
  `pre-release` to `main`.
- Explain the user-visible change and link related issues.
- Include or update coverage and documentation when relevant.
- Resolve review discussions before merging.

Releases are maintainer-managed: the `pre-release` workflow prepares a release
pull request, and merging it to `main` runs Semantic Release. Before publishing,
configure npm trusted publishing for GitHub Actions with repository
`parloti/task-runner` and workflow `release.yml`. The workflow uses OIDC and
does not require an `NPM_TOKEN` secret. Semantic Release calculates published
versions from commit history; with no previous release tag, its first stable
release is `1.0.0`. The manifest's `0.1.0` version is for local development
artifacts. See the [npm trusted publisher guide](https://docs.npmjs.com/trusted-publishers/)
and our [Code of Conduct](CODE_OF_CONDUCT.md).
