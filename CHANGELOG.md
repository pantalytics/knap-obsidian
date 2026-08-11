# Changelog

## 1.2.0
- Svelte 5. This clears the last `npm audit` finding, svelte `<=5.55.6`, and with it GHSA-rcqx-6q8c-2c42, the one advisory of the six that could fire client-side. `npm audit --omit=dev` now reports nothing.
- The 64 components did not need rewriting: Svelte 5 still runs Svelte 4 syntax, so `export let`, `$:`, `<slot>` and `createEventDispatcher` stay as they were. What changed is the host TypeScript, because Svelte 5 removed the client component API. `new Component({ target })` throws at runtime now, and it type-checks anyway, so a green build proved nothing here: every modal, pill and the settings tab would have thrown on open. Fifteen call sites moved to `mount()` and seventeen `$destroy()` calls to `unmount()`.
- `$set` has no replacement, because props handed to `mount()` are only reactive when the props object is a `$state` rune, and runes do not exist in a plain `.ts` file. The four places that pushed updates from TypeScript now pass a store instead: the settings path (`SettingsTab`), the folder pill and its sync progress (`FolderNav`), the upload tag, and the per-view connection state (`LiveViews`). The store props are named `pill` and `actions` rather than `state` or `props`, which would collide with the `$state` and `$props` runes.
- `EndpointConfigModalContent` uses callback props instead of `createEventDispatcher`. `mount()` still takes an `events` option, but it is deprecated and goes in Svelte 6.
- `GenericSuggestModal` took a component class with a `new` signature. Svelte 5 components are functions, so it takes what `mount()` accepts.
- Fixed while passing through: `FilePillDecoration.setText` destroyed its pill when a file moved into meta but left the reference set, so the next update called `$set` on a destroyed component.
- Toolchain: `esbuild-svelte` to `^0.9.5`, `svelte-preprocess` to `^6`, the compiler's `css: true` to `css: "injected"` (Svelte 5 dropped the boolean form), and `Unsubscriber` imported from `svelte/store` rather than `svelte/motion`.

## 1.1.43
- Catalog: `eslint-plugin-obsidianmd` was pinned at `^0.1.9` while the community directory scans every published version against the current ruleset. Bumped to `^0.4.1` and switched `eslint.config.mjs` to consume the plugin's own `recommended` config whole. Spreading it into a `rules` block, as before, dropped everything the config carries besides rule entries, which is why lint sat green on findings the directory would have reported.
- Sync: `netSync()` did not await `addLocalDocs()`, so `syncFileTree()` could start while the divergent-guid claim was still running. The other caller already awaited it.
- Auth: `require("eventsource")` assigned the whole module object to `window.EventSource`. eventsource v4 exports `{ ErrorEvent, EventSource }`, so had that desktop polyfill ever fired, `new EventSource(...)` would have thrown. It now takes the named export.
- Mobile: dropped three unreachable Node branches that put `process` and `Buffer` in a plugin shipping with `isDesktopOnly: false`. Obsidian always has a `window`, as the surrounding code already assumed.
- UI: `activeDocument.createElement` replaced with Obsidian's `createDiv`/`createSpan`/`createEl` at fifteen sites, and the OAuth timeout now uses `window.setTimeout` so it behaves in popout windows.
- Deps: uuid to `^11.1.1`, clearing GHSA-w5hq-g745-h8pq, and dropped `@types/uuid` now that uuid ships its own.
- Docs: README states that an account is required, what the relay can charge for, and that a webview reaches an identity provider when you sign in through one.

## 1.1.38
- Network (TR-26): offline/online detection was dead in the EVC build (build-time `HEALTH_URL` was always empty) — the health-check URL is now derived at runtime from the active server's control-plane URL, with `NetworkStatus.updateUrl()` re-pointing it when the default server changes.
- Sync (TR-09): attachments (images/audio/video/pdf) never synced in live shares — `LiveTokenStore.fetchFileToken` now branches to the relay-onprem token provider the same way `refresh()` already does, and `requestFileToken` mints a presigned-URL token from the new control-plane `POST /shares/{id}/file-token` route (companion fix, control-plane PR #151).

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
