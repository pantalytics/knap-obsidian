# Submitting Knap to the community catalog

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
  `main`, renamed from `knap/fork-base` on 2026-08-13.
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
| Default branch carries the Knap manifest and README | `main` is the default branch and holds both, so there is nothing to merge first. It was renamed from `knap/fork-base` on 2026-08-13; GitHub redirects the old name, and the directory reads whatever is default at the time it looks. |
| Plugin id unique across published plugins | `synced-vaults` is free: re-checked against all 6582 entries in `community-plugins.json` on 2026-08-12, after the rename off `knap-sync`. The id stayed there when the name went back to Knap (ADR-0045). The name was checked separately on 2026-08-12 against all 6588 entries then published: no plugin is called Knap and none carries the word in its name, and that was still true of all 7371 entries on 2026-09-07. Uniqueness was never the problem; see below. |
| Plugin id does not contain `obsidian` | `synced-vaults`. CI checks it. |
| Name does not read as a first-party Obsidian product | Pantalytics Knap. It says nothing about Obsidian, and CI checks for the word. The name was `Knap` until 2026-09-07; see *The directory refused the name* below. |
| `manifest.json` carries id, name, version, minAppVersion, description, author, `isDesktopOnly` | All set. `isDesktopOnly: false`, so the phone is a supported target and the scan will hold it to that. |
| Semantic version, matching across manifest, package.json, versions.json, manifest-beta.json | CI fails the build when any two disagree. |
| Release tagged bare semver, equal to `manifest.version` | Tags are bare semver and `cd.yml` stamps the manifest it publishes to match. **Since 2026-09-01 the version files in git deliberately lag the releases**, so this row needs the files brought back in step before submission. |
| Release carries `main.js`, `manifest.json`, `styles.css` | All three are attached to 1.1.42, with build provenance attestation. |
| Licence and attribution for forked code | `LICENSE` carries all three copyright lines, `NOTICE` records the fork point and every vendored dependency. |
| Required disclosures in the README | Network use was already there. 1.1.43 adds that an account is required, that a relay can charge and where its billing screen lives, and that signing in through Google, GitHub, Microsoft or Discord loads that provider's page. |
| No client-side telemetry | None. The policy prohibits it outright, and nothing in `src/` reaches an analytics service. |

## The directory refused the name

Measured, not inferred. The 2026-09-01 submission passed its scan at 1.13.6 --
the scorecard reads *Completed* and the release checks pass -- and the entry was
hidden anyway, with a banner of its own:

> **Name not allowed in the directory.** The name "Knap" is not allowed in the
> directory. Your entry has been hidden until you change the name in your
> `manifest.json`.

What that is not: it is not the duplicate-name error, which reads *an entry with
this name already exists*, and no published entry is called Knap or carries the
word (re-checked against all 7371 entries on 2026-09-07). It is not the scan
either, which the same page reports as passed. Obsidian publishes no rule about
allowed names beyond the ban on "Obsidian", so **why the bare word is refused is
not something we can read anywhere**, and guessing at it would be a design on
unmeasured behaviour.

The answer is to stop submitting a bare word. **The manifest name is
`Pantalytics Knap`**: the author field already says Pantalytics, the pair reads
as a vendor and a product rather than as a dictionary entry, and it stays short
enough to sit in the settings sidebar. It is the one thing that changed. The id
is still `synced-vaults`, so the plugin updates in place, and everything the
plugin says about itself is still Knap. Obsidian draws two strings from the
manifest that a person sees, the Community plugins row and the settings tab
heading, and both now read *Pantalytics Knap*.

If the resubmission comes back refused again, the word itself is on a list we
cannot see, and the next name has to drop it. That is a fact worth having before
picking one, which is why this section records the attempt. The decision is
[ADR-0097](https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0097-the-plugin-is-pantalytics-knap-in-the-directory.md),
which amends ADR-0045's name and leaves its id and its screen alone.

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

The four left are warnings with a reason, not oversights. Preview the scan the
way the directory runs it, ignoring our own tuning:

```bash
npx eslint src/ --config <(printf 'import o from "eslint-plugin-obsidianmd";\nexport default [...(o.default??o).configs.recommended];\n')
```

One thing this does not settle: the directory runs its own configuration, so our
`brands` and `ignoreRegex` entries may not reach it. If the scorecard comes back
naming "Knap sync", that is the reason, and the product name is the right answer
rather than the lint's.

## The 1.13.6 scorecard, and what it took

The 1.13.6 entry scored Health *Excellent* and Review *Satisfactory*, with one
hard failure and a list of warnings. The failure was the one worth having:

> Build verification failed while running the build script

Two separate causes. The first is fixed here. The second is measured, and
parked with the measurement, because fixing it breaks something else.

1. **`git describe` was unguarded.** `esbuild.config.mjs` opened with
   `execSync("git describe --tags --always")`. The directory unpacks a
   release's source and builds it with no `.git` beside it, so that call threw
   and the build died before esbuild started. It falls back to the manifest
   version now, which is the value it was already computing for a tagless
   checkout. `notify-send` on a failed build is wrapped for the same reason.
   Verified: a source tree with `.git` and `node_modules` removed builds
   cleanly with `npm run build` and no environment variables at all.

2. **The release still cannot be reproduced from its own source.** `cd.yml`
   builds with `KNAP_SERVER_URL` set from a repository variable, and the define
   defaults to the empty string, so `npm run build` produces a plugin with the
   whole `src/knap` path switched off while every shipped release has it on.
   Two different plugins from one source tree, and nothing for a verifier to
   compare. Defaulting the define to the same one server address as the rest of
   the file (ADR-0033) closes it exactly -- measured: that build is
   byte-identical to the `main.js` attached to the 1.13.6 release -- and the
   Obsidian wire end to end then times out driving the app, because the harness
   has only ever exercised a build with `src/knap` off. ADR-0068 says that job
   decides, so the default stays empty until the harness copes. Tracked in
   [#167](https://github.com/pantalytics/knap-obsidian/issues/167).

   What this means for the next scorecard: the build script now runs to
   completion, so verification gets an artifact to compare rather than a crash.
   It will not match until #167 lands.

The warnings that were worth acting on:

| Finding | What was done |
|---|---|
| 13 unsafe values (5 returns, 3 arguments, 3 assignments, 2 calls) | All 13 were in `src/storage/y-indexeddb.js`, from lib0's untyped `getAll`, `getLastKey`, `count` and `promise.create`, plus a `get()` whose JSDoc advertised `\| any`. Typed in place, no runtime change except one: `destroy()` dropped its close promise, so `clearData()` called `.then` on `undefined` and would have thrown. `destroy()` returns the promise again, as upstream does. The file's exemption in `eslint.config.unsafe-check.mjs` is gone with it. |
| 2 `This assertion is unnecessary since it does not change the type` | Two `as ArrayBuffer` casts on `ArrayBuffer.prototype.slice` in the test mocks, and one `as keyof FeatureFlags` on a parameter already declared that way. Removed. |
| 12 `This assertion is unnecessary since the receiver accepts the original type` | Not reproducible here against any configuration we can construct -- our own tsconfig, a strict one, one that includes the tests, one that includes the `.svelte` files. Tracked rather than guessed at. |
| 2 `PluginSettingTab does not implement getSettingDefinitions()` | Left. The declarative settings API arrived in Obsidian 1.13 and is not in the `obsidian` typings this repo builds against, so the shape would be guesswork. Tracked. |
| `super`/`Observable` deprecated, 3 | Left, for the reason recorded above: lib0's `ObservableV2` migration retypes every event on the core sync class, and this is vendored y-websocket code kept close to upstream. |

Two disclosures the scorecard shows publicly and which are by design: the
plugin encodes and decodes base64 at runtime (JWT claims, and the binary
frames the sync protocol carries), and it reads and writes `window.localStorage`
directly in the PocketBase auth store and its on-prem sibling. The latter is
where a session token lives, which is browser storage on purpose: it is
vault-local, it is not vault content, and it must not travel into the plugin
data file that syncs.

## What is left

### 1. Click through a vault

`npm audit --omit=dev` reports nothing at all as of 1.2.0. uuid went to
`^11.1.1` in 1.1.43 and svelte to 5 in 1.2.0, which closed the last one.

What that migration cost is a testing debt, and it is the honest reason this
step exists. Svelte 5 removed the client component API: `new Component()`
throws at runtime while still type-checking, so the fifteen call sites that
moved to `mount()` cannot be validated by `tsc`, `eslint` or the 441 unit
tests. All four are green and none of them opens a modal.

What to exercise, in a real vault, before tagging:

- The settings tab, including a deep link into a share, which is the `$set`
  that became a store.
- Each modal: debug, self-host, user select, share folder, add to vault,
  feature flags, IndexedDB analysis, endpoint config. The endpoint config
  modal's Apply button in particular, since its two events became callback
  props.
- The folder pill in the file explorer while a sync runs, so the progress
  updates land, and the upload tag on a file.
- The connection dot in a note's view actions, and the same in a canvas.

### 2. Cut the release

The published releases are 1.1.41 and 1.1.42, both of which predate the scan
fixes. Submitting against either would put the version with the findings in
front of the scanner, so tag first:

```bash
git tag 1.2.0         # bare semver, exactly the value in manifest.json
git push origin 1.2.0
```

The release workflow builds, attests provenance and attaches the three assets.
`workflow_dispatch` rebuilds a tag if a run needs repeating.

1.1.43 was merged but never tagged, so it is available as a checkpoint release
if you want the lint and bug fixes out separately from the framework
migration. Tag it on the commit that merged it. Note that a session running in
this environment cannot do either: the git credential is scoped to branch refs
and a push to `refs/tags/*` comes back 403.

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
- **It ships with a server configured.** `app.knap.pantalytics.com` is a default,
  not a lock-in: the settings let you remove it and point anywhere. The README
  says so in the network section, which is where a reviewer looks.
- **Mobile.** `isDesktopOnly: false` is a promise. The loopback HTTP server that
  upstream used for OAuth is gone for exactly this reason, and the only Node
  globals left in `src/` are unreachable, but anything new reaching for Node or
  Electron would be caught here.

## Before resubmitting after review feedback

Bump the version, let CI confirm the four files agree, tag, and the release
workflow does the rest. The directory entry does not need touching again.
