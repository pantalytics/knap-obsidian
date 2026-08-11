# Submitting Knap Sync to the community catalog

What the Obsidian community directory asks for, what this repo already has, and
what is genuinely left. Everything here was read off
[docs.obsidian.md, *Submit your plugin*](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin),
the [developer policies](https://docs.obsidian.md/Developer+policies), the
[plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
and [*The future of Obsidian plugins*](https://obsidian.md/blog/future-of-plugins/),
or measured against this repo and the live catalog, on 2026-08-11.

Two things changed under this document since the 2026-08-10 draft, and both
change the work: most of the mechanical checklist is now done, and the review
that stood between us and the catalog turned out to be a machine rather than a
person.

## How the catalog actually works

Worth understanding before the steps, because it explains why the order matters:

- The submission route is a form at community.obsidian.md. It is **not** a pull
  request against `obsidian-releases` any more. An older write-up sends you to
  the wrong place, and the repository still accepting PRs does not mean they are
  read.
- The directory lists plugins from `community-plugins.json`. `name`, `author`
  and `description` are the fields people search on.
- Opening a plugin's page pulls `manifest.json` and `README.md` **from the
  default branch** of the repo. Not from the release. Our default branch is
  `knap/fork-base`, which is unusual but is what the directory will read.
- The manifest on the default branch only decides *which version is latest*. The
  files a user installs come from the **GitHub release tagged exactly that
  version**.
- If the manifest's `minAppVersion` is higher than the Obsidian someone is
  running, `versions.json` is consulted for the newest version they can have.

So: the default branch is the shop window, the release is the warehouse, and a
mismatch between them shows up as a plugin that appears in search and refuses to
install.

## Review is automated, and it runs on every version

This is the part that is new, and it is the reason the remaining work is code
rather than paperwork.

Obsidian used to review the first submission by hand and then leave a plugin
alone. Now every published version is scanned for code quality, policy
adherence and known vulnerabilities, and the result is a scorecard on the
plugin's public page. A submission that fails is not installable until it
passes, and there is no queue to wait out: results come back in minutes.

The scanner is the same ruleset as
[`eslint-plugin-obsidianmd`](https://www.npmjs.com/package/eslint-plugin-obsidianmd),
which is already a devDependency here, so the scan can be previewed locally
before submitting. The catch is version drift, and we walked into it: this repo
pins `^0.1.9`, the current release is `0.4.1`, and `npm run lint` is green on
the first and not on the second. **A green lint against a pinned old ruleset is
not evidence that the scan will pass.** See step 1.

The other half of the scorecard is dependency vulnerabilities, which come from
the lockfile rather than from our own code.

## What this repo already satisfies

Verified against the live repo and the live catalog on 2026-08-11, not assumed.

| Requirement | State |
|---|---|
| Repository is public | Public. This was the blocker in the previous draft and it is gone. |
| `README.md`, `LICENSE`, `manifest.json` in the repo root | Present. CI checks they stay present. |
| Default branch carries the Knap Sync manifest and README | `knap/fork-base` is the default branch and holds both. There is no `main`, so there is nothing to merge first. |
| Plugin id unique across published plugins | `knap-sync` is free. Checked against all 6558 entries in `community-plugins.json` on 2026-08-11. |
| Plugin id does not contain `obsidian` | `knap-sync`. CI checks it. |
| Name does not read as a first-party Obsidian product | Knap Sync. 275 catalog plugins carry "Sync" in the name, so the word itself is not a problem. CI checks for "Obsidian". |
| `manifest.json` carries id, name, version, minAppVersion, description, author, `isDesktopOnly` | All set. `isDesktopOnly: false`, so the phone is a supported target and the scan will hold it to that. |
| Semantic version, matching across manifest, package.json, versions.json, manifest-beta.json | CI fails the build when any two disagree. |
| Release tagged bare semver, equal to `manifest.version` | 1.1.41 and 1.1.42 are published. `release.yml` refuses a `v` prefix and refuses a tag that differs from the manifest. |
| Release carries `main.js`, `manifest.json`, `styles.css` | All three are attached to 1.1.42, with build provenance attestation. |
| Licence and attribution for forked code | `LICENSE` carries all three copyright lines, `NOTICE` records the fork point and every vendored dependency. |
| No client-side telemetry | None. The policy prohibits it outright, and nothing in `src/` reaches an analytics service. |

## What is left

### 1. Make the scan green before submitting, not after

Bump `eslint-plugin-obsidianmd` to `^0.4.1` so CI is measuring the same thing
the directory measures, then clear what it finds. Run today against `0.4.1`,
`src/` reports **3 errors and 35 warnings** where the pinned `0.1.9` reports
nothing:

| Count | Rule | What it is |
|---|---|---|
| 2 errors | `eslint-comments/no-restricted-disable` | `src/main.ts:465` and `:1289` disable `obsidianmd/ui/sentence-case` for the string "Knap Sync". The new ruleset forbids disabling that rule, so the suppression is now the finding. The rule takes a `brands` option, so the fix is to declare `brands: ["Knap Sync"]` in the config and delete both comments. Naming the brand once is also more honest than switching the rule off twice. |
| 1 error | `@typescript-eslint/no-floating-promises` | `src/SharedFolder.ts:818`, `this.addLocalDocs()` is not awaited. A real one, in the reconcile path that the two lines above it warn is order-sensitive. |
| 15 warnings | `obsidianmd/prefer-create-el` | `activeDocument.createElement()` where `activeWindow.createDiv()` is wanted, mostly in `AwarenessViewPlugin.ts`. |
| 7 warnings | `obsidianmd/ui/sentence-case` | Title case in UI strings, for example "30 Days" and "E.g., notes/shared". |
| 7 warnings | `no-undef` on `process` | `src/client/provider.ts:497` and `:592`. Both sit behind `typeof window !== "undefined"`, and in Obsidian `window` is always defined, so this is dead code inherited from y-websocket rather than a mobile hazard. Deleting the branch is cheaper than explaining it. |
| 3 warnings | `@typescript-eslint/no-deprecated` | Deprecated `Observable` and `super` use in `src/client/provider.ts`. |
| 2 warnings | `obsidianmd/prefer-window-timers` | Bare `setTimeout`/`clearTimeout` in `OAuthDeepLinkReceiver.ts`, which misbehave in popout windows. |
| 1 warning | `obsidianmd/settings-tab/prefer-setting-definitions` | `SettingsTab.ts` has no `getSettingDefinitions()`, so our settings never show up in Obsidian's settings search. Not required, but it is the kind of thing a scorecard reader notices. |

Warnings are not automatically fatal, but they are visible on the scorecard, and
the errors are what stops a submission.

To preview the scan without waiting on the version bump:

```bash
npm i --no-save eslint-plugin-obsidianmd@latest
npx eslint src/            # against a config that uses the new recommended set
```

### 2. Clear the two dependency advisories

`npm audit --omit=dev` reports two moderate findings in shipped dependencies:

- **svelte `<=5.55.6`**, six advisories. Five are server-side rendering issues
  that cannot fire in a plugin, but GHSA-rcqx-6q8c-2c42 is DOM clobbering of
  internal framework state and runs client-side. We are on svelte 4, so the fix
  is a major upgrade rather than a patch.
- **uuid `<11.1.1`**, a missing buffer bounds check in v3/v5/v6 when a buffer is
  passed. We do not pass one, so the exposure is nil, but the scanner reads the
  lockfile and not the call sites.

Neither is dangerous here. Both will appear on the scorecard, so decide
deliberately whether to upgrade first or to submit and carry them.

### 3. Say the quiet parts in the README

The developer policies allow all of these and require that each be stated
plainly in the README. Ours covers network use well and is thin on the rest:

- **An account is required.** The Connect section shows a Login step, which
  implies it. The policy asks for it to be indicated, so indicate it: without an
  account on a relay, the plugin does nothing.
- **Whether payment is required.** If the default relay at
  `cp.knap.pantalytics.com` is a paid service at any tier, that has to be said.
  This is the one item on this page that needs a decision rather than an edit.
- **The "and to nothing else" sentence.** `src/LoginManager.ts:566-573`
  intercepts OAuth redirects for Google, GitHub, Discord and Microsoft, which
  means a webview can load those hosts during sign-in. It only happens when the
  relay offers social sign-in and the user picks it, and we initiate none of it,
  but the sentence as written overstates the case. One clause fixes it.

### 4. Submit at community.obsidian.md

Sign in with an Obsidian account, link the GitHub account that owns
`pantalytics/knap-obsidian`, pick the repo, complete the form. The dashboard
also offers a preview scan, which is worth running even after step 1.

Only the first version is submitted by hand. After that Obsidian picks up new
releases from GitHub on its own, and scans each one.

## What review is likely to ask about

Not blockers, but cheaper to have an answer ready than to be surprised:

- **This is a fork of a plugin already in the catalog, twice over.** EVC Team
  Relay is listed as `evc-team-relay` and Relay as `system3-relay`, both
  confirmed present today. A near-duplicate submission gets read carefully, so
  the honest answer is the one in the README: vault-wide scope as a first class
  option, and an OAuth callback over `obsidian://` instead of a loopback port,
  which is what makes sign-in work on a phone and against an identity provider
  that matches redirect URIs exactly.
- **It ships with a server configured.** `cp.knap.pantalytics.com` is a default,
  not a lock-in: the settings let you remove it and point anywhere. The README
  says so in the network section, which is where a reviewer looks.
- **Mobile.** `isDesktopOnly: false` is a promise. The loopback HTTP server that
  upstream used for OAuth is gone for exactly this reason, and the only Node
  globals left in `src/` are unreachable, but anything new reaching for Node or
  Electron would be caught here.

## Before resubmitting after review feedback

Bump the version, let CI confirm the four files agree, tag, and the release
workflow does the rest. The directory entry does not need touching again.
