# Contributing to Knap

Thanks for your interest. Knap is an Obsidian plugin that syncs a vault, or
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
   `.obsidian/plugins/pantalytics/`
3. Enable the plugin in *Settings → Community plugins*
4. Point it at your relay in *Settings → Pantalytics → Relay Servers*

A vault you do not mind breaking is the right vault for this.

## Pull Requests

1. Create a branch from `main`, the default branch
2. Make your changes
3. Ensure `npm run build` succeeds with no errors
4. Ensure `npm run lint` and `npm test` pass
5. Write a clear PR description explaining what and why
6. Submit the PR

## Versioning and releases

The community catalog reads `manifest.json` off `main` to decide which
version is the latest, and installs the files from the release with that tag.
So a release is a version bump: run `npm version patch` (it updates
`manifest.json`, `package.json` and `versions.json`), and merge. The CD
workflow publishes a release for the version in `manifest.json` when it has
none yet, with the production server baked in and provenance attested. A merge
that does not bump the version publishes nothing.

Tags stay bare semver, so `1.2.5` and never `v1.2.5`: Obsidian looks for a
release tagged the same as the manifest version inside it, and a `v` prefix
makes the release invisible to it.

CI runs on every pull request and on the default branch, and the **CI gate**
check is what passes or fails: lint, type-check, tests, a build, and the version
files agreeing with each other. Setting the repository variable `CI_MODE` to
`REPORT` makes everything except the version check informational, which is an
escape hatch rather than the normal state.

## Reporting Bugs

Use the [bug report](https://github.com/pantalytics/pantalytics-obsidian/issues/new?template=bug-report.yml)
template.

## Requesting Features

Use the [feature request](https://github.com/pantalytics/pantalytics-obsidian/issues/new?template=feature-request.yml)
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
