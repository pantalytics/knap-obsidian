# Contributing to Knap Sync

Thanks for your interest. Knap Sync is an Obsidian plugin that syncs a vault, or
a folder of one, to a relay you host yourself.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/my-feature`

## Development

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build

# Lint
npm run lint

# Tests
npm test
```

### Testing in Obsidian

1. Build the plugin: `npm run build`
2. Copy `main.js`, `manifest.json` and `styles.css` into your vault's
   `.obsidian/plugins/knap-sync/`
3. Enable the plugin in *Settings → Community plugins*
4. Point it at your relay in *Settings → Knap Sync → Relay Servers*

A vault you do not mind breaking is the right vault for this.

## Pull Requests

1. Create a branch from `knap/fork-base`, the default branch
2. Make your changes
3. Ensure `npm run build` succeeds with no errors
4. Ensure `npm run lint` and `npm test` pass
5. Write a clear PR description explaining what and why
6. Submit the PR

## Versioning and releases

The version lives in three files and CI fails if they disagree: `manifest.json`,
`package.json` and `versions.json`, plus `manifest-beta.json` for the BRAT beta
channel. `npm version` keeps them in step.

A release happens when the version changes, and never otherwise. Merging does
not release anything: most merges are not releases, and the ones that are say so
in `manifest.json`.

The usual way is the **Bump version and release** workflow, under Actions. Pick
patch, minor or major, and it lints, type-checks, tests and builds first, writes
the four version files, commits to the default branch and publishes the release.
It needs no checkout, which is the point: a release can be cut from a phone.

Bumping the version yourself works the same way. `npm version patch` writes all
four files, and once that commit is on the default branch the release follows on
its own.

Tags stay bare semver matching `manifest.json` exactly, so `1.2.5` and never
`v1.2.5`. Obsidian looks for a release tagged the same as the manifest version,
so a `v` prefix means the release is invisible to it. Pushing such a tag by hand
still publishes, and so does running the **Release** workflow against an
existing tag when a release needs rebuilding. Every route ends in the same job:
build, attest provenance, attach `main.js`, `manifest.json` and `styles.css`.

CI runs on every pull request and on the default branch, and the **CI gate**
check is what passes or fails: lint, type-check, tests, a build, and the version
files agreeing with each other and increasing. Setting the repository variable
`CI_MODE` to `REPORT` makes everything except the version check informational,
which is an escape hatch rather than the normal state.

## Reporting Bugs

Use the [bug report](https://github.com/pantalytics/knap-obsidian/issues/new?template=bug-report.yml)
template.

## Requesting Features

Use the [feature request](https://github.com/pantalytics/knap-obsidian/issues/new?template=feature-request.yml)
template.

## Code Style

- TypeScript, strict mode
- Svelte for settings components, plain DOM with the Obsidian API elsewhere
- Follow the patterns already in the file you are editing
- Keep changes focused and minimal

Code copied from other projects lives in its own directory with its own licence
file, listed in [NOTICE](NOTICE). Do not remove those headers, and think twice
before editing those directories at all: they are easier to keep in step with
upstream when they stay close to it.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
