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
| Release tagged bare semver, equal to `manifest.version` | 1.1.41 and 1.1.42 are published. `release.yml` refuses a `v` prefix and refuses a tag that differs from the manifest. 1.1.43 still needs tagging, see below. |
| Release carries `main.js`, `manifest.json`, `styles.css` | All three are attached to 1.1.42, with build provenance attestation. |
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
| `eslint-comments/no-restricted-disable`, 2 | Gone. Both were `eslint-disable` comments switching off `ui/sentence-case` for the string "Knap Sync". The ruleset forbids disabling that rule, so the suppression had become the finding. The rule's `brands` option names the product once instead. |
| `@typescript-eslint/no-floating-promises`, 1 | Fixed. `netSync()` did not await `addLocalDocs()`, so `syncFileTree()` could start while the divergent-guid claim was still in flight. |
| `obsidianmd/prefer-create-el`, 15 | Fixed. `activeDocument.createElement()` became `createDiv()`, `createSpan()` and `createEl()`. Note the rule's message suggests `activeWindow.createDiv()`, which does not type-check: Obsidian puts `createDiv` on `Node`, where it appends, and the bare global is the one that returns a detached element. |
| `obsidianmd/ui/sentence-case`, 9 | 2 were the product name and are handled by `brands`. 1 was a placeholder, now "Notes/shared". The other 6 are duration labels like "30 days", where the rule asks for "30 Days"; that is title case, so the rule is wrong and `ignoreRegex` exempts strings that open with a digit rather than breaking correct English. |
| `no-undef`, 7 | 6 fixed, 1 left. Three unreachable Node branches carrying `process` and `Buffer` are gone, which they should have been in a plugin shipping `isDesktopOnly: false`, and three `require()` calls became a plain import once it was clear the only cycle was type-only. |
| `obsidianmd/prefer-window-timers`, 2 | Fixed, and the `Pending.timer` type went from `@types/node`'s `Timeout` to `number`. |
| `@typescript-eslint/no-deprecated`, 3 | Left. lib0's `Observable` is deprecated in favour of `ObservableV2`, but `YSweetProvider` extends it and the migration retypes every event on the core sync class. This is vendored y-websocket code kept close to upstream on purpose. |
| `obsidianmd/settings-tab/prefer-setting-definitions`, 1 | Left. The rule assumes a tab built from `new Setting()` rows; ours mounts a Svelte app, so there is nothing to enumerate without rebuilding the settings UI. |
| `no-undef` on `require`, 1 | Left. `customFetch.ts` lazily requires the eventsource polyfill on desktop only, and esbuild resolves it at build time. |

The four left are warnings with a reason, not oversights. Preview the scan the
way the directory runs it, ignoring our own tuning:

```bash
npx eslint src/ --config <(printf 'import o from "eslint-plugin-obsidianmd";\nexport default [...(o.default??o).configs.recommended];\n')
```

One thing this does not settle: the directory runs its own configuration, so our
`brands` and `ignoreRegex` entries may not reach it. If the scorecard comes back
naming "Knap sync", that is the reason, and the product name is the right answer
rather than the lint's.

## What is left

### 1. Decide on svelte

`npm audit --omit=dev` is down to one moderate finding. uuid went to `^11.1.1`
in 1.1.43, clearing GHSA-w5hq-g745-h8pq, and `@types/uuid` went with it.

svelte `<=5.55.6` remains, six advisories. Five are server-side rendering issues
that cannot fire inside a plugin. The sixth, GHSA-rcqx-6q8c-2c42, is DOM
clobbering of internal framework state and does run client-side. The fix is
svelte 5, and this repo has 64 components on svelte 4 using `new Component()`,
`$set` and `$destroy`, all of which svelte 5 removes. That is a migration with
its own testing, not a dependency bump, and it should not ride along with a
catalog submission.

So the choice is to submit carrying one moderate advisory on the scorecard, or
to do the svelte 5 migration first. Carrying it looks right, given five of the
six cannot fire here and the sixth needs an attacker who can already put chosen
markup into the settings UI.

### 2. Cut the 1.1.43 release

The published releases are 1.1.41 and 1.1.42, both of which predate the scan
fixes. Submitting against either would put the version with the findings in
front of the scanner, so tag first:

```bash
git tag 1.1.43        # bare semver, exactly the value in manifest.json
git push origin 1.1.43
```

The release workflow builds, attests provenance and attaches the three assets.
`workflow_dispatch` rebuilds a tag if a run needs repeating.

### 3. Submit at community.obsidian.md

Sign in with an Obsidian account, link the GitHub account that owns
`pantalytics/knap-obsidian`, pick the repo, complete the form. The dashboard
also offers a preview scan, which is worth running even after all of the above.

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
