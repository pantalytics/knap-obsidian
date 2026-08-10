# Submitting Knap Sync to the community catalog

What the Obsidian community directory asks for, what this repo already has, and
the four steps left that need a human. Everything here was read off
[docs.obsidian.md, *Submit your plugin*](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
and the [obsidian-releases README](https://github.com/obsidianmd/obsidian-releases)
on 2026-08-10, not from memory. The submission route changed at some point from
a pull request against `obsidian-releases` to a form at community.obsidian.md,
so an older write-up will send you to the wrong place.

## How the catalog actually works

Worth understanding before the steps, because it explains why the order matters:

- The directory lists plugins from `community-plugins.json`. `name`, `author`
  and `description` are the fields people search on.
- Opening a plugin's page pulls `manifest.json` and `README.md` **from the
  default branch** of the repo. Not from the release.
- The manifest on the default branch only decides *which version is latest*. The
  files a user installs come from the **GitHub release tagged exactly that
  version**.
- If the manifest's `minAppVersion` is higher than the Obsidian someone is
  running, `versions.json` is consulted for the newest version they can have.

So: the default branch is the shop window, the release is the warehouse, and a
mismatch between them shows up as a plugin that appears in search and refuses to
install.

## What this repo already satisfies

| Requirement | State |
|---|---|
| `README.md`, `LICENSE`, `manifest.json` in the repo root | Present. CI checks they stay present. |
| Plugin id unique across published plugins | `knap-sync` is free. Checked against all 6518 entries in `community-plugins.json` on 2026-08-10. |
| Plugin id does not contain `obsidian` | `knap-sync`. CI checks it. |
| Name does not read as a first-party Obsidian product | Knap Sync. CI checks it. |
| `manifest.json` carries id, name, version, minAppVersion, description, author, `isDesktopOnly` | All set. `isDesktopOnly: false`, so the phone is a supported target and reviewers will hold it to that. |
| Semantic version, matching across manifest, package.json, versions.json, manifest-beta.json | CI fails the build when any two disagree. |
| Release tagged bare semver, equal to `manifest.version` | `.github/workflows/release.yml` refuses a `v` prefix and refuses a tag that differs from the manifest. |
| Release carries `main.js`, `manifest.json`, `styles.css` | The release workflow attaches all three, with build provenance attestation. |
| Licence and attribution for forked code | `LICENSE` carries all three copyright lines, `NOTICE` records the fork point and every vendored dependency. |

## The four steps left

Each needs a person, and the order is not negotiable.

### 1. Merge this work into `main`

The directory reads the manifest and the README off the default branch. Until
the branch is merged, an install-from-catalog would show upstream's old README.

### 2. Make the repository public

`pantalytics/knap-obsidian` is private today. This blocks everything: the
directory cannot read the manifest, BRAT cannot install a beta, and the README's
release links 404 for everybody but us.

Making it public publishes the default relay hostname
(`cp.knap.pantalytics.com`, in `src/RelayOnPremConfig.ts`) and the whole fork
history. Both are normal for a plugin that talks to a hosted service, and both
are worth knowing before the switch is flipped rather than after.

### 3. Cut a release

```bash
git tag 1.1.41        # bare semver, exactly the value in manifest.json
git push origin 1.1.41
```

The release workflow builds, attests provenance and creates the release with its
three assets. There are no releases on this repo yet, so this is the first one:
check the assets landed before moving on. `workflow_dispatch` rebuilds a tag if
something needs a second run.

### 4. Submit at community.obsidian.md

Sign in with an Obsidian account, link the GitHub account that owns the repo,
add the plugin. Only the first version is submitted by hand; after that Obsidian
picks up new releases from GitHub on its own.

## What review is likely to ask about

Not blockers, but cheaper to have an answer ready than to be surprised:

- **This is a fork of a plugin already in the catalog.** EVC Team Relay is
  listed as `evc-team-relay`, and it is itself derived from Relay
  (`system3-relay`). A near-duplicate submission gets read carefully, so the
  honest answer is the one in the README: vault-wide scope, and an OAuth
  callback over `obsidian://` instead of a loopback port, which is what makes
  sign-in work on a phone and against an identity provider that matches redirect
  URIs exactly.
- **It ships with a server configured.** `cp.knap.pantalytics.com` is a default,
  not a lock-in: the settings let you remove it and point anywhere. The README
  says so in the network section, which is where a reviewer looks.
- **Mobile.** `isDesktopOnly: false` is a promise. The loopback HTTP server that
  upstream used for OAuth is gone for exactly this reason, but anything else
  reaching for Node or Electron APIs would be caught here.

## Before resubmitting after review feedback

Bump the version, let CI confirm the four files agree, tag, and the release
workflow does the rest. The directory entry does not need touching again.
