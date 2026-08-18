# The join rig: a second account, joining a vault it did not create

The first fill of a joined vault is the one path no already-synced device
ever runs. An owner's machine has the files already, so the create branch is
never reached, and every manual test on it passes while every new member
breaks. That is how [#85][85] survived four days of releases, and it is why
this rig exists: it is the only way to run the chain a member actually runs,
which is sign in, attach a share somebody else made, and fill from it.

[85]: https://github.com/pantalytics/knap-obsidian/issues/85

## What is automated, and what is not

Three levels cover this, and they are not the same thing.

| Level | Where | Runs in CI | Fails on 1.13.2 |
|---|---|---|---|
| The unit: `_handleServerCreate` and `syncFileTree` over a real Y.Doc and SyncStore | `__tests__/joinFill.test.ts` | yes, `npm test` | yes, 3 of 4 |
| The wire: a cold member receiving a populated file list, root-level entries included, put through the share's own path rules | `scripts/e2e/join.e2e.mjs`, run by `run-wire.sh` | yes, the Wire job | **no** |
| The chain: a second account, added as a member, linking a fresh vault in a real Obsidian and receiving every note | this document | no | yes |

Read that middle row honestly. `join.e2e.mjs` proves that a member joining
cold receives every entry over a real relay and that the share's rules accept
all of them, root-level names with apostrophes and diacritics included. It
does not drive `syncFileTree`, so it would not have gone red on 1.13.2. The
test that goes red on 1.13.2 is `joinFill.test.ts`. The chain is what nothing
automated reaches, and that is what the rest of this file is for.

## What the chain needs

Four things, none of which a plain runner has:

- **Their control plane**, built from our copy at the commit
  `deploy/knap-relay.sha` pins in `knap-mcp-admin` ([ADR-0040][adr40]). The
  spike rigs under `knap-mcp-admin/scripts/spikes/` build exactly this image;
  `relay_token_budget/run.sh` is the shortest one to copy, because it already
  mints the Ed25519 keypair the control plane signs relay tokens with and the
  relay server verifies against.
- **relay-server 0.9.7**, the published tag the deploy runs. Same compose
  file.
- **A real Obsidian**, from the harness at
  `knap-mcp-admin/scripts/dev/obsidian/obsidian.sh`. There is no headless
  substitute: the plugin's join runs in the renderer.
- **TLS in front of the relay.** Obsidian's renderer is an `app://` origin,
  which Chromium treats as a secure context, so it refuses a plaintext `ws://`
  even to localhost. `scripts/e2e/run-obsidian-wire.sh` in this repo already
  sets up the proxy and the CA in the app's NSS store; the join rig reuses it.

[adr40]: https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0040-the-deploy-builds-the-commit-we-pinned.md

## The recipe

Run it from a checkout of this repo with `knap-mcp-admin` beside it. Docker
is required throughout.

**1. Bring up the control plane and the relay.** Copy
`knap-mcp-admin/scripts/spikes/relay_token_budget/` to a working directory
and run its `run.sh`. It builds the control-plane image from the pinned sha,
generates the keypair, and starts both services with a throwaway Postgres.
Note the two ports it prints.

**2. Make two accounts.** The bootstrap admin is in the compose environment
(`BOOTSTRAP_ADMIN_EMAIL`). Through the control plane's admin API, create the
owner and the member, and set each a password with
`PATCH /v1/admin/users/<id>`. Two accounts is the whole point: an owner
account that makes the vault and a member account that has never seen it.

**3. Fill the owner's vault.** Start the harness, install this plugin, sign
in as the owner, and let it create and fill a vault. Thirteen notes is
enough, and **at least two of them must be at the root of the vault**, not in
a folder. That is the condition #85 turned on, and a rig whose notes are all
nested reproduces nothing.

```bash
npm run build && mkdir -p /tmp/knap-plugin && cp manifest.json main.js styles.css /tmp/knap-plugin/
../knap-mcp-admin/scripts/dev/obsidian/obsidian.sh up
../knap-mcp-admin/scripts/dev/obsidian/obsidian.sh plugin /tmp/knap-plugin
```

There is no pointer in the container, so the sign-in is driven with
`obsidian.sh eval`, the same way `run-obsidian-wire.sh` drives its half. A
password login rather than the Zitadel button: the deep link needs a browser
the container does not have, and what is under test here is the fill, not the
identity ([ADR-0030][adr30] covers that half separately).

[adr30]: https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0030-the-plugin-signs-in-through-the-control-plane.md

**4. Add the member to the owner's share.** Through the control plane, as the
owner. The member must not create the share, and must not be its owner: a
member of somebody else's share is the case, and an owner joining their own
share from a second device is a different and easier one.

**5. Join, from a fresh vault.** Reset the harness (`obsidian.sh down` then
`up` gives a clean vault), sign in as the member, and link the owner's cloud
vault.

**6. Read the disk.** Count what arrived:

```bash
docker exec knap-obsidian find /config/vault -name '*.md' | wc -l
docker exec knap-obsidian find /config/vault -maxdepth 1 -name '*.md'
```

## What passing looks like

Every note the owner uploaded is on the member's disk, with its body, and the
root-level ones are among them. On 1.13.2 the count is zero: the folder
document syncs, `filemeta_v0` arrives complete, and not one note is written,
with every light on the screen green. That gap, complete metadata against an
empty disk, is the fingerprint to look for. The other one is on the relay
side: an affected client holds tokens for exactly two documents, the folder
document and any note it uploaded itself, refreshes them forever, and never
opens a document websocket.

The whole run is about a minute once the images are built.

## If you automate this

Two things to get right, because both have already cost a day.

The first is the root-level note. A rig that seeds `Projects/note.md` and
nothing else passes on the broken build.

The second is honesty about what has been seen to pass. `wire.yml` in this
repo carries a note explaining that its `obsidian-wire` job was written on a
box without Docker and has never had a green run, and that it must not be a
required check until it has. A join job earns the same note until somebody
watches it go green, and it earns a red the first time it is wrong rather
than a `continue-on-error` that nobody reads.
