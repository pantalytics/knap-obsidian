# Contributing to EVC Team Relay Obsidian Plugin

Thanks for your interest in contributing! This plugin enables live team editing and sync in Obsidian via EVC Team Relay.

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
```

### Testing in Obsidian

1. Build the plugin: `npm run build`
2. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/evc-team-relay-plugin/`
3. Enable the plugin in Obsidian Settings > Community Plugins
4. Point it at your local Team Relay instance

## Pull Requests

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run build` succeeds with no errors
4. Ensure `npm run lint` passes
5. Write a clear PR description explaining what and why
6. Submit the PR

## Reporting Bugs

Use the [Bug Report](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=bug_report.md) issue template.

## Requesting Features

Use the [Feature Request](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=feature_request.md) issue template.

## Code Style

- TypeScript with strict mode
- No React/Svelte - vanilla DOM with Obsidian API
- Follow existing patterns in the codebase
- Keep changes focused and minimal

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
