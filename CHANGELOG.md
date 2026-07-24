# Changelog

## 1.1.37
- Sync (TR-08): `checkStale()` now actually detects divergence for relay-linked docs instead of always reporting "not stale" — the HTTP re-fetch is skipped for relay-linked docs (WebSocket sync is authoritative) but the real staleness comparison now runs, so the conflict-detection UI is no longer dead code on tr.entire.vc. (This fix was listed under 1.1.36 but did not make that build; it ships here.)

## 1.1.36
- Sync (TR-08): shipped in 1.1.37 (this build did not include the fix).
- Auth (TR-10): route OAuth2 login through `LoginManager` so listeners fire and shares load without a restart.
- Network (TR-12): reconnect retries forever with capped backoff instead of giving up after 3 attempts.
- Auth (TR-21): verify the OAuth callback `state` to close a session-fixation gap.
- Network (TR-29): `customFetch` no longer retries mutating requests on transient network errors (prevents duplicate writes).
- Shared folders (TR-30): reject nested shares in either direction.
- Sync (TR-41): retry initial awareness until synced instead of a single 2s attempt.
- Sync (TR-42): preserve unsynced edits before a remote-delete trashes a local file.
- Sync (TR-51): wait for the socket buffer to flush instead of a fixed 1000ms timer.
- Auth (TR-52): a failed re-login no longer clears an existing valid session.
- Auth (TR-53): persist `lastUserEmail` so it survives reload.
- Sync (TR-U4): don't echo inbound sync-artifact writes back out as local edits in the Document sync path.
- Sync (TR-25): wire the `isOutboundSyncing` echo-guard into the manual/full-sync paths too.
- Relay on-prem (TR-U3): fall back to a read-only token on 403 instead of hard-failing viewers.
- Auth (TR-56): key the relay-onprem auth session by `appId`, not the mutable vault name.
- Auth (TR-58): gate the legacy System3/PocketBase dead-code path with a clear error instead of a silent trap.

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
