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

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run build` succeeds with no errors
4. Ensure `npm run lint` and `npm test` pass
5. Write a clear PR description explaining what and why
6. Submit the PR

## Versioning and releases

The version lives in three files and CI fails if they disagree: `manifest.json`,
`package.json` and `versions.json`, plus `manifest-beta.json` for the BRAT beta
channel. `npm version` keeps them in step.

Releases are cut by pushing a tag that is bare semver and matches
`manifest.json` exactly, so `1.2.5` and never `v1.2.5`. Obsidian looks for a
release tagged the same as the manifest version, so a `v` prefix means the
release is invisible to it. The release workflow builds, attests provenance and
attaches `main.js`, `manifest.json` and `styles.css`.

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
