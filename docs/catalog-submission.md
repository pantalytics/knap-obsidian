# Submitting Knap to the community catalog

What the Obsidian community directory asks for, what this repo already has, and
what is genuinely left. Everything here was read off
[docs.obsidian.md, *Submit your plugin*](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin),
the [developer policies](https://docs.obsidian.md/Developer+policies), the
[plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
and [*The future of Obsidian plugins*](https://obsidian.md/blog/future-of-plugins/),
or measured against this repo and the live catalog, on 2026-08-11 and
re-measured on 2026-08-13.

**As of 1.12.1 every check this document lists is green and one step is left:
the submission itself, which is a form somebody has to sign into with an
Obsidian account.** Nothing in the repo is holding it up. Jump to
[What is left](#what-is-left).

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

Verified against the live repo and the live catalog on 2026-08-13, not assumed.

| Requirement | State |
|---|---|
| Repository is public | Public. This was the blocker in the previous draft and it is gone. |
| `README.md`, `LICENSE`, `manifest.json` in the repo root | Present. CI checks they stay present. |
| Default branch carries the Knap manifest and README | `knap/fork-base` is the default branch and holds both. There is no `main`, so there is nothing to merge first. |
| Plugin id unique across published plugins | `synced-vaults` is free: re-checked against all 6620 entries in `community-plugins.json` on 2026-08-13. The id stayed `synced-vaults` when the name went back to Knap (ADR-0045). The name was checked in the same pass: no published plugin is called Knap and none carries the word in its id or name. |
| Plugin id does not contain `obsidian` | `synced-vaults`. CI checks it. |
| Name does not read as a first-party Obsidian product | Knap. It is the product's own name and says nothing about Obsidian. CI checks for "Obsidian". |
| `manifest.json` carries id, name, version, minAppVersion, description, author, `isDesktopOnly` | All set. `isDesktopOnly: false`, so the phone is a supported target and the scan will hold it to that. |
| Semantic version, matching across manifest, package.json, versions.json, manifest-beta.json | CI fails the build when any two disagree. |
| Release tagged bare semver, equal to `manifest.version` | The newest is **1.12.1**, tagged `1.12.1`, equal to `manifest.version` on the default branch. `release.yml` refuses a `v` prefix and refuses a tag that differs from the manifest. |
| Release carries `main.js`, `manifest.json`, `styles.css` | All three are attached to 1.12.1 as binary assets, uploaded by the release workflow with build provenance attestation. |
| Default branch and newest release agree | Both are commit `8072238`. The shop window and the warehouse say 1.12.1, `synced-vaults`, Knap. |
| Licence and attribution for forked code | `LICENSE` carries all three copyright lines, `NOTICE` records the fork point and every vendored dependency. |
| Required disclosures in the README | Network use was already there. 1.1.43 adds that an account is required, that a relay can charge and where its billing screen lives, and that signing in through Google, GitHub, Microsoft or Discord loads that provider's page. |
| No client-side telemetry | None. The policy prohibits it outright, and nothing in `src/` reaches an analytics service. |

## What was done for the scan, in 1.1.43

`eslint-plugin-obsidianmd` now tracks `^0.4.1`, and `eslint.config.mjs` consumes
the plugin's own `recommended` config whole instead of spreading it into a
`rules` block. The old spread kept only the rule entries and dropped the rest of
the config, which is the mechanism by which `npm run lint` stayed green on
findings the directory would have reported.

Against the plugin's untuned `recommended`, `src/` went from 1 error and 37
warnings to **0 errors and 5 warnings**:

| Was | Now |
|---|---|
| `eslint-comments/no-restricted-disable`, 2 | Gone. Both were `eslint-disable` comments switching off `ui/sentence-case` for the product name, "Knap Sync" as it read then. The ruleset forbids disabling that rule, so the suppression had become the finding. The rule's `brands` option names the product once instead. |
| `@typescript-eslint/no-floating-promises`, 1 | Fixed. `netSync()` did not await `addLocalDocs()`, so `syncFileTree()` could start while the divergent-guid claim was still in flight. |
| `obsidianmd/prefer-create-el`, 15 | Fixed. `activeDocument.createElement()` became `createDiv()`, `createSpan()` and `createEl()`. Note the rule's message suggests `activeWindow.createDiv()`, which does not type-check: Obsidian puts `createDiv` on `Node`, where it appends, and the bare global is the one that returns a detached element. |
| `obsidianmd/ui/sentence-case`, 9 | 2 were the product name and are handled by `brands`. 1 was a placeholder, now "Notes/shared". The other 6 are duration labels like "30 days", where the rule asks for "30 Days"; that is title case, so the rule is wrong and `ignoreRegex` exempts strings that open with a digit rather than breaking correct English. |
| `no-undef`, 7 | 6 fixed, 1 left. Three unreachable Node branches carrying `process` and `Buffer` are gone, which they should have been in a plugin shipping `isDesktopOnly: false`, and three `require()` calls became a plain import once it was clear the only cycle was type-only. |
| `obsidianmd/prefer-window-timers`, 2 | Fixed, and the `Pending.timer` type went from `@types/node`'s `Timeout` to `number`. |
| `@typescript-eslint/no-deprecated`, 3 | Left. lib0's `Observable` is deprecated in favour of `ObservableV2`, but `YSweetProvider` extends it and the migration retypes every event on the core sync class. This is vendored y-websocket code kept close to upstream on purpose. |
| `obsidianmd/settings-tab/prefer-setting-definitions`, 1 | Left. The rule assumes a tab built from `new Setting()` rows; ours mounts a Svelte app, so there is nothing to enumerate without rebuilding the settings UI. |
| `no-undef` on `require`, 1 | Left. `customFetch.ts` lazily requires the eventsource polyfill on desktop only, and esbuild resolves it at build time. |

The four left are warnings with a reason, not oversights. The command that
previews the scan the directory's way is under
[What is left](#verified-on-2026-08-13-against-1121), along with the numbers it
gives today. Two things about it changed since this section was written: the
config needs `parserOptions.projectService` or the typed rules refuse to load,
and a `<(printf ...)` process substitution does not survive ESLint's ESM loader,
so the config has to be a real file.

One thing this does not settle: the directory runs its own configuration, so our
`brands` and `ignoreRegex` entries may not reach it. If the scorecard comes back
naming "Knap sync", that is the reason, and the product name is the right answer
rather than the lint's.

## What is left

One step, and it is not a repository change.

### Submit at community.obsidian.md

1. Sign in at [community.obsidian.md](https://community.obsidian.md) with an
   **Obsidian account**. This is the account from obsidian.md, not a GitHub
   login and not a Knap account.
2. Link the GitHub account that can prove ownership of
   `pantalytics/knap-obsidian`, so the directory can verify the repo is ours.
3. Add the plugin, pick `pantalytics/knap-obsidian`, and complete the form.
4. Run the dashboard's preview scan before submitting. It is the same ruleset
   previewed below, run the directory's way, and it is the only place the
   directory's own configuration shows itself.

Only the first version goes in by hand. After that Obsidian picks up new
GitHub releases on its own and scans each one.

**This step cannot be automated from a session in this repo, and that is not a
tooling gap to route around.** It is an authenticated form behind a personal
Obsidian account, and the account linking exists precisely to prove a human who
owns the repo is the one submitting. Somebody with the account does it.

### Verified on 2026-08-13, against 1.12.1

Everything the form and the scan will look at, re-run rather than remembered:

| Check | Result |
|---|---|
| Repo public, MIT `LICENSE`, `README.md`, `manifest.json` in root | Present. |
| Default branch `knap/fork-base` manifest | `synced-vaults`, Knap, 1.12.1, `minAppVersion` 1.8.7, `isDesktopOnly: false`. |
| Newest release | `1.12.1`, bare semver, matching the manifest, `main.js` + `manifest.json` + `styles.css` attached. |
| Default branch == release commit | Both `8072238`. |
| `id` and name free in the live catalog | Checked against all 6620 entries. |
| `npm audit --omit=dev` | 0 vulnerabilities. |
| Untuned `eslint-plugin-obsidianmd` `recommended` over `src/` | **0 errors, 12 warnings.** |

The 12 warnings are the four this document already argues are warnings-with-a-
reason, plus the six `30 Days` title-case false positives, plus two more
`no-deprecated` hits on lib0's `Observable` in `src/client/provider.ts`. None is
an error, and none is new.

Reproduce the scan the way the directory runs it, ignoring our own tuning. The
config needs type information, so a bare `--config` with only the recommended
spread will not run:

```bash
cat > eslint.config.scan.tmp.mjs <<'EOF'
import o from "eslint-plugin-obsidianmd";
export default [
	...(o.default ?? o).configs.recommended,
	{
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
	},
];
EOF
npx eslint src/ --config eslint.config.scan.tmp.mjs; rm -f eslint.config.scan.tmp.mjs
```

### What was not verified from here

- **A click through a real vault.** The Svelte 5 migration in 1.2.0 traded a
  compile-time guarantee for a runtime one — `mount()` call sites that `tsc`,
  eslint and the unit tests all pass without exercising — and ten minor
  versions of UI work have landed on top of it since. That is a reason to open
  a vault before submitting, not a reason to wait. Modals, the settings tab,
  the folder pill during a sync, and the connection dot in a note and a canvas
  are the places where a broken mount would show.

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
