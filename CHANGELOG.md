# Changelog

## 1.7.0
- Name: the plugin is **Knap**. Every screen, notice, menu item and log prefix that said Synced Vaults says the product's own name, which is what it was called up to 1.4.0 and what the service on the other end has always been called.
- Name, the identifier: this one stays. The manifest id is still `synced-vaults`, and so are the sign-in deep link `obsidian://synced-vaults/oauth-callback`, the settings tab, the ribbon icon, the commands and the localStorage and IndexedDB keys. **Nothing to reinstall and nothing to sign in to again**: this release updates in place, and the control plane's allowlist for native callbacks is untouched. 1.5.0 moved the identifier with the name and 1.6.0 charged everybody a reinstall for it; charging that twice in a week to buy a word that appears for one second in a browser address bar is not a trade worth making.
- The settings screen is two rows and two buttons. **Account** is the address signed in and **Status** is the state word, both as Obsidian's own setting rows, label on the left and value on the right, so the tab reads like the settings pages either side of it. Under them sits whatever the state has to say, and nothing when it has nothing.
- **Dashboard** opens Knap's page in a browser, which is where the half this screen does not cover lives: which devices sync, and which AI is connected. **Logout** is the other button, and on a signed-out screen both are replaced by **Sign in**, because there is nothing to open without an account.
- The header is the name and a rule under it. The line of description that used to sit there said what the plugin does, which is a question somebody answered before installing it.

## 1.6.0
- The settings screen is the account row and nothing else. **Who can read this**, the share list behind it and the three screens under that (a share's detail, invite somebody, agent keys) all came off. The list was a list of one now that a vault is one share, and the row it held repeated the row above it. Worth knowing before you go looking: this is also the last route to a vault's members, invites and agent keys, so there is currently no way to invite somebody to a vault from inside Obsidian. Bringing that back is a screen about people rather than a list of shares.
- The status bar mark carries the state. Green when the vault is up to date, the accent colour while notes are moving, grey when the share is disconnected and red when nobody is signed in, with the word itself in the tooltip. It reads the same four words the settings screen does, off the same list, so the corner of the window and the settings tab cannot describe one vault two ways.
- The status bar menu is two actions and Settings. **Sync all shares** is **Sync vault** and **Sync current file** is **Sync this file**, because the vault is what syncs and a share is not a word anybody here has met. **Manage shares** is gone: it opened a list of one thing, on a plugin where a vault is one share.
- Sync scope: a vault is one share, and picking folders is gone. The **Sync individual folders** setting added in 1.4.0, the *Synced Vaults: sync this folder* and *stop syncing this folder* items on the file explorer's context menu, the *Add a folder* button and `CreateShareView` all came out, along with the per-server `syncMode` they were stored behind. Signing in syncs the whole vault and that is the only shape there is (ADR-0042). The either/or the toggle managed was the reason the screens needed two levels and the reason two halves could disagree about what was shared; neither is a thing that can happen now.
- Sync scope: a vault that already syncs folders is offered one button, *Sync the whole vault*, because whole-vault and folder shares are exclusive in both directions and the folders have to come off before the vault share can be made. It asks first, since deleting a share deletes its documents and a folder somebody else is a member of takes their copy too. The removals go to the server first and the local record second, so a refusal stops the run with the two halves still agreeing.
- Sync scope: adopting a share no longer asks for a folder either. *Sync this vault here*, on the member screen and in the share modal, attaches at the vault root with the vault scope, the same way signing in does. It used to open a folder picker and make a folder-scope record for a share the rest of the plugin treats as a whole vault, which is the disagreement one share per vault exists to end. `ShareManagementModal`'s `createShare` and `createLocalSharedFolder` went with the form that was their only caller. Every folder picker left in the fork hangs off `Relays.svelte`, `ManageRelay.svelte`, `ManageRemoteFolder.svelte` and `ManageSharedFolder.svelte`, which never render here.
- Deleting a folder already deleted it everywhere, and an earlier draft of this release claimed otherwise. `deleteFile` removes one entry from the sync store and a folder is an entry like any other, which reads like the notes inside it would be left behind. Measured in a real Obsidian instead of reasoned about: Obsidian fires a `delete` event for every descendant before the folder's own, empty subfolders included, on both `vault.delete` and the file explorer's `fileManager.trashFile`, so each note removes itself. The cascade written for the bug was reverted; it fixed nothing and walked the whole sync store once per delete event.

## 1.5.0
- Name: the plugin is **Synced Vaults**. Every screen, notice, menu item and log prefix that said Knap Sync says the new name, and so does Knap's own page, because the two are deliberately the same words on both sides.
- Name, the identifier: unlike the 1.4.0 wording pass, this one moved the identifiers too. The plugin id is `synced-vaults`, the sign-in deep link is `obsidian://synced-vaults/oauth-callback`, the settings tab, ribbon icon, commands, CSS classes and the differences view all follow, and so do the localStorage and IndexedDB keys. That was the decision rather than a side effect: the id is what a person sees in the plugin folder and in the URL their browser hands back after signing in, and leaving it on the old word would have meant explaining two names forever.
- Upgrading, and this needs a hand: Obsidian keys a plugin by its id, so this release installs beside the old one instead of replacing it. Remove `.obsidian/plugins/knap-sync/` after installing, or two plugins will try to sync the same vault. BRAT users: remove the beta plugin and add `pantalytics/knap-obsidian` again.
- Upgrading, what survives: the sign-in does. The stored credential is copied from the old key to the new one on first load, over the same migration path that already carried a server rename, so nobody has to sign in again.
- Upgrading, what does not: the local CRDT cache is keyed by the old name and is not migrated, so every synced folder downloads itself again from the relay on first run. Anything still queued for upload when you switch goes with it, so let a device finish syncing before you upgrade it.
- The control plane's allowlist for native sign-in callbacks moved with the deep link. An old plugin build signing in against the updated server is refused with a 400, which is the allowlist doing its job rather than a fault.

## 1.4.0
- Wording (#29): the screens use the four words Knap settled on, vault, folder, sync and MCP. Shared folders are Synced folders, Create Share is Add a folder, and the context menu says sync this folder and stop syncing this folder. Identifiers are untouched, and upstream's System 3 screens keep their own headings because they never render here.
- Vault name (#28): a synced folder now carries the vault it belongs to, in a map of ours on the folder's own document. Knap's page drew a vault and had nothing to call it, so it drew the hostname. The name lives in Obsidian and nowhere else, so the side that knows writes it down, after the first sync and only when it changed.
- Sync scope: one setting on the Knap Sync screen, **Sync individual folders**, replaces the sequence of unshares that used to be the only way between the whole vault and folder shares. Off is the whole vault and stays the default. Flipping it removes the shares the old mode owned, from the server first and then locally, and writes the setting down only once they have all gone. A refusal stops the switch instead of finishing it, because a setting that says one thing while the server does another is the failure being fixed here: unsharing folders by hand left this plugin syncing nothing and the shares still on the server, and neither half noticed. The switch plans from this vault's own local records, so a share on the same account belonging to a second vault, or to somebody else, is never in the list.
- Sync scope: leaving the whole vault had no control at all before this. A vault-scope share has the local path `""`, so there is no folder in the file explorer to right-click, and the only way out was the share list's Delete.
- Sync scope: `startSyncingTheVault` no longer proposes the whole vault when the setting says folders and nothing is shared yet. That gap is the normal state right after the switch, and the old guard, a folder count above zero, did not cover it. A device that signs in and finds folder shares instead writes the setting down as folders, which is how a second device follows the first without the server holding a preference.
- Auth (#25): the settings tab has one way in. *Other ways to sign in*, and the email and password form behind it, are gone, and so is `RelayOnPremLoginModal`. The fallback could not serve the person it was shown to: an account created through the identity service has no control-plane password until an admin sets one. When the control plane reports no OAuth provider the screen now says sign-in is unavailable instead of opening a form nobody has a credential for. Password login itself stays in `LoginManager`; what went is the UI for it.
- Auth (#14): one sign-in left a 30-day session behind per control-plane operation, not per sign-in. Every request re-derives its bearer token through `getValidToken()`, which refreshes — and so rotates the session — whenever `isTokenValid()` says no, and `isTokenValid()` subtracted a flat five minutes from expiry. A buffer only works while it is shorter than the token it guards: an access token that lives five minutes or less was expired from the instant it was minted, so the answer was no for its whole life and each operation bought another session. The buffer is now a quarter of the token's own lifetime, read from the JWT's `iat`/`exp` or, when those are absent, from the `expires_in` the control plane stated when it minted the token — `iat` is an optional claim, and scaling off it alone left every token without one on the flat five minutes.
- Auth (#14, hardening): two narrower ways a second session-minting request could reach the wire, neither of which explains the measurement on the issue but both of which are real. `refreshTokenWithRetry` replayed `POST /v1/auth/refresh` up to three times on anything that was not a 401/403, which is the duplicate TR-29 removed from `customFetch` reintroduced one layer up — the retry is gone. And `refreshToken()` is now single-flight, so `restoreAuth()` and `reAuthForSensitiveAction()` join an in-flight refresh instead of sending a second POST carrying the same refresh token.
- Network: `customFetch` takes `replayable`, so a caller can overrule the method-based retry rule in either direction. Nothing in the plugin needs it today — the non-idempotent GET it was written for, the OAuth callback exchange, is gone now that the control plane exchanges the code itself — but the rule it overrules is a heuristic, and the next caller that knows better than its own HTTP verb can say so.

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
