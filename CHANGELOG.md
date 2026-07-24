# Changelog

## 1.1.35
- Security (H3): added a path-traversal containment guard in `InboundFileDownloader` — a malicious or compromised relay server could otherwise supply a `relativePath` like `../../.obsidian/plugins/evil.js` in the files index and overwrite arbitrary vault files, including plugin JS and vault config. Traversal attempts are now logged and skipped; the rest of the batch continues processing.
- CI: scoped the manifest-version monotonicity guard to only run when a PR/push actually touches `manifest.json`/`package.json`/`versions.json` — previously it ran on every PR and permanently deadlocked any PR that didn't itself bump the version, once `main`'s version equaled the latest published release.

## 1.1.34
- Community review: removed unnecessary type assertions and switched `document` → `activeDocument` for popout-window compatibility (auto-fixed via eslint-plugin-obsidianmd typed lint)
- `SharedFolder`: bound the debounced `notifyListeners` to fix the unbound-method warning
- Replaced the `builtin-modules` package with Node's built-in `node:module` builtins (esbuild config)
- Marked the vendored `y-indexeddb` adapter's `no-unsafe-*` / unbound-method as intentional with a described eslint-disable

## 1.1.33
- Fix ESLint issues in test files and build scripts (no-restricted-imports, unused vars, empty blocks)
- Replace deprecated setWarning() with setDestructive() in ShareManagementModal
- Remove unused eslint-disable directives in MockTimeProvider
- Add CHANGELOG

## 1.1.32
- Fix forbidden eslint-disable directives on obsidianmd rules
- Fix ShareManagementModal UI text to sentence-case

## 1.1.31
- Fix all bare-timer usage (window.setTimeout/setInterval/clearTimeout/clearInterval)
- Fix activeDocument usage (replace bare document. references)
- Fix globalThis usage
- Fix CSS: remove !important, :has(), text-decoration rules
- Wire eslint-plugin-obsidianmd

## 1.1.30
- Initial community review fixes
