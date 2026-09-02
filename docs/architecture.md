# Architecture

**This is the device half of Knap.** The server half is
[`pantalytics/knap-mcp-admin`](https://github.com/pantalytics/knap-mcp-admin),
and its `docs/architecture.md` is written to be read beside this page. Two
repositories, and that is the whole stack.

The plugin's job is one sentence: **keep this Obsidian vault and one cloud vault
equal, both ways, without ever replacing a note wholesale.**

## Two layers in one bundle

The bundle carries the rebuilt Knap client and the fork it grew out of, and only
one of them reaches a screen.

| | Where | What it is |
|---|---|---|
| **The Knap client** | `src/knap/` | What ships. Sign-in, the link, the tree, the bindings, the live editor, the settings tab |
| **The inherited fork** | most of the rest of `src/` | EVC Team Relay's plugin: a control plane, shares, folder pickers, member screens, billing. Compiled in, and held still by three guards |

`src/knap/` is a little over 3,000 lines and answers every question a person can
ask the plugin. Everything around it answers questions this product does not
have.
[ADR-0073](https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0073-we-build-the-sync-layer-ourselves.md)
is why.

### The switch, which is now always on

`KNAP_SERVER_URL` is an esbuild define. Empty, `registerKnapBeta` returns null
and the plugin behaves exactly as the fork did; set, it registers the protocol
handler, the settings tab, the editor extension and four commands, and
`main.ts` does **not** register the fork's own settings tab (`oneWorld.test.ts`
holds that line). One world per build.

**Since 2026-09-01 every published release sets it.** `.github/workflows/cd.yml`
fails the build if `vars.KNAP_SERVER_URL` is missing, insists on https with no
trailing slash, and greps the built `main.js` for the address afterwards,
because a build where the define silently stayed empty looks fine and registers
nothing.

Two debts follow from that and are worth naming rather than discovering:

- **The commands are still labelled *(beta)*** in the palette, on what is now
  the only shipping path.
- **The inherited layer is still constructed at load**, and held still by three
  guards rather than by not existing. Its objects are built (`relayOnPrem` is
  always enabled), and then `main.ts` does not register its settings tab, does
  not start its background sync, and returns early from
  `loadRelayOnPremShares`. All three read the same flag, and all three exist
  because the first beta ran both worlds at once: the old stack's shares were
  listed as *cloud vaults* beside the real ones and were being synced into
  whatever vault the beta was installed in.

`oneWorld.test.ts` asserts those guards by reading `main.ts` rather than by
standing an Obsidian up in jest, so what it proves is that each guard is there
and reads the same flag. Whether the plugin honours them at runtime is what the
real-app walk is for.

## The picture

```
  Obsidian
  ┌──────────────────────┐        ┌──────────────────────────────────────┐
  │ vault files          │        │ an editor with a note open           │
  └───────────┬──────────┘        └──────────────────┬───────────────────┘
              │ create/modify/delete/rename          │ keystrokes
              ▼                                      ▼
   ObsidianFileStore                        knapEditor  ──▶ LiveNote
              │                                      │      + NoteCursors
              ▼                                      │
   ┌──────────────────────┐   holds/releases         │
   │ VaultBinding (notes) │◀─────────────────────────┘
   │ AttachmentBinding    │
   └───────────┬──────────┘
               │  splices, tree entries, bytes
               ▼
        KnapVaultClient ─── TreeDoc (files, attachments)
               │                  one Y.Doc per open note
               │
     ws://…/sync/{vault}/{doc}?token=…        https://…/auth,/api,/files
               │                                       │
               ▼                                       ▼
  ┌──────────────────────────── Knap server ───────────────────────────────┐
  │  rooms + markdown mirror + SQLite          the door, /api/vaults,      │
  │                                            /api/limits, attachments    │
  └────────────────────────────────────────────────────────────────────────┘
```

Everything in that diagram is injected rather than imported: files come through
a `FileStore`, documents through a `VaultDocs`, HTTP through a `Fetch`, the
socket through a `WebSocketImpl`. That is what puts the rules under jest with no
Obsidian and no server, and it is the reason `__tests__/knap/` can drive the
real engine.

## The modules

| | |
|---|---|
| `KnapSync.ts` | The orchestrator, and the state. Sign in, link, unlink, sign out, start, stop, retry, and the one `status()` every screen reads |
| `KnapServer.ts` | The five HTTP conversations, and the socket address. One credential, no per-document token |
| `SignInFlow.ts` | Browser out, deep link back, code traded for a token, once |
| `KnapVaultClient.ts` | One linked cloud vault, live: the tree socket, plus a socket per open note |
| `TreeDoc.ts` | The two maps: path to document id, and path to `{hash, size}` |
| `VaultBinding.ts` | The engine for notes. Splices out, writes in, idempotent both ways |
| `AttachmentBinding.ts` | The engine for everything that is not a note. Hash first, bytes before the entry |
| `LiveNote.ts` · `knapEditor.ts` · `NoteCursors.ts` | An open editor bound straight to the document, and everybody's caret on awareness |
| `ObsidianFileStore.ts` · `ObsidianSeenTree.ts` · `obsidianFetch.ts` | The three adapters. Thin on purpose: every rule lives where jest can reach it |
| `ObsidianKnap.ts` | Where it meets Obsidian: the switch, the tab, the picker, the commands, the protocol handler |
| `KnapSettingsTab.ts` | The one screen. [`ui-ux.md`](ui-ux.md) is the whole of it |
| `linkSteps.ts` · `LinkProgressModal.ts` | What linking says while it happens. The step list and its arithmetic are pure; the modal only draws them |
| `deadline.ts` | A bounded wait, and the one number every wait for the tree uses |

## The four flows

### Signing in

```
  Settings → Sign in
        │
        ├─▶ window.open(  <server>/auth/plugin/start  )
        │        the browser does the OAuth. The plugin holds no client id,
        │        no secret, and never talks to the issuer itself.
        │
        └─◀ obsidian://synced-vaults/signin?code=…
                 │  a one-time handoff code, never a credential:
                 │  a deep-link URL survives in browser history
                 ▼
             POST /auth/plugin/exchange  ──▶  this device's token
```

The identifier in that URL stays `synced-vaults` whatever the plugin is called,
rebuild or no rebuild. A callback whose state did not start here is dropped and
said out loud, because anything on the machine can invoke a URL scheme.

### Linking, and the reconcile that follows

`link()` replaces, never appends: it stops whatever ran before, saves the one
cloud vault, and starts. A local vault is linked to at most one cloud vault, and
the reason is measured rather than tidy. Two local vaults on one account held
each other's folder trees on 2026-08-14 because the answer lived in whichever
row sat first in a settings array.

At link time nothing is guessed:

| On disk | In the tree | What happens |
|---|---|---|
| yes | no | uploads |
| no | yes | downloads |
| yes, same text | yes | nothing. Both directions are idempotent, which is what breaks the echo loop without a ledger |
| yes, different text | yes | the cloud text takes the path, the local text survives beside it as a conflict copy |
| no, and it was there last time | no | a delete somebody made, which travels |

That last row is what `ObsidianSeenTree` exists for. Without a record of what
this device last agreed with, a file that is gone and a note that never arrived
look identical, and every restart undid both sides' deletes. The record lives in
the plugin's own directory, never in settings, because it is a fact about one
device and may never ride along with anything that syncs.

The binding starts only on `workspace.onLayoutReady`. The first thing it does is
ask Obsidian which notes this vault holds, and a vault that has not finished
loading answers with too few, which now reads as deletions.

### A keystroke, both ways

Two paths, and which one carries a note depends on whether an editor has it
open.

```
  note not open            note open in an editor
  ─────────────            ──────────────────────
  Obsidian saves           every keystroke
  a second or two          ▼
  after typing stops       LiveNote: a difference into Y.Text, now
  ▼                        ▲
  VaultBinding:            │ remote differences come back the same way
  minimal splice           │
  (common prefix and       └─ the file binding stands down for that note
   suffix untouched)          for as long as the editor holds it
```

A caret cannot live on the file binding's clock: drawn from a document two
seconds behind the editor it sits in the wrong sentence, and a remote paragraph
arriving as a whole-file write lands under somebody's hands while they type. So
an open note is bound directly, and `hold()` / `release()` is the handoff.
Nothing in either path replaces a document or a file wholesale
([ADR-0010](https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0010-every-write-is-a-difference.md),
the same rule the server writes under).

Cursors ride awareness and never enter the document, as Yjs **relative**
positions rather than offsets. An offset is only true against one version of the
text, so somebody typing above your caret would drag it a word left on every
other screen.

### An attachment

A PNG has no common prefix worth keeping and no splice that means anything, so
it gets its own engine. The bytes go over `/files`, and the tree records only
that it exists, at `{hash, size}`. Three rules rhyme with the note ones:

- **The hash is the whole of "do I already have this."** Every direction
  compares it before moving a byte.
- **The bytes go up before the entry does.** An entry is what tells every other
  device to come and fetch.
- **A file over the ceiling is refused here, with a sentence**, rather than
  uploaded and refused there with a 413. The ceilings are asked for at
  `/api/limits` rather than compiled in, because they are the server's and the
  two repositories ship separately.

Nothing is in both maps, and that exclusivity is a safety property. One map with
a kind field would put a device's attachment bookkeeping in a position to name a
note's path and delete another device's note.

## What the plugin says to the server

One credential for all of it, and the server does the whole authorisation story
at the door.

| | |
|---|---|
| `GET /auth/plugin/start` | Opened in a browser, not fetched |
| `POST /auth/plugin/exchange` | The one-time code, for this device's token |
| `POST /auth/plugin/signout` | The token handed back. A 401 is the outcome, not a failure |
| `GET /api/vaults` | The cloud vaults this account may open |
| `GET /api/limits` | What this deployment accepts |
| `PUT` / `GET` / `DELETE /files/{vault}/{path}` | Attachment bytes |
| `wss://…/sync/{vault}/{doc}?token=…` | The y-protocol. The tree stays connected; note documents connect when opened |

## Where a change goes

| Bucket | Where it lives |
|---|---|
| **What a person sees or presses** | `KnapSettingsTab.ts`, the picker in `ObsidianKnap.ts`, `styles.css`. Read [`ui-ux.md`](ui-ux.md) first |
| **The words of a state** | `syncStatus.ts`, and nowhere else. The corner and the screen read one reading |
| **A rule about files and documents** | `VaultBinding.ts` or `AttachmentBinding.ts`, never the Obsidian adapter |
| **Anything Obsidian-shaped** | `ObsidianFileStore.ts`, `ObsidianSeenTree.ts`, `obsidianFetch.ts`. Translation only |
| **The wire** | `KnapServer.ts` for HTTP, `KnapVaultClient.ts` for sockets |
| **Typing and cursors** | `LiveNote.ts`, `knapEditor.ts`, `NoteCursors.ts` |
| **A format the server also has to know** | Both repositories at once, and the cross-repo spike below |

## Verifying a change

```bash
npm run lint
npx tsc --noEmit --skipLibCheck
npm test                      # jest; the engine tests are __tests__/knap/
```

Those are the same three the CD workflow runs before it publishes, so local
green is release green.

What they cannot see is the other repository. **A format written down in two
repositories that ship separately is the one thing neither repository's tests
can catch failing.** The admin repo's
`scripts/spikes/plugin_against_knap_server/` bundles these modules and drives
them against a live `knap_server`, and its `make obsidian` runs a real Obsidian
in a container with no screen. Run one of them before believing a wire change.

## The rules this half must not break

The six live in the admin repo's `CLAUDE.md`. Three of them are enforced here:

- **Plain markdown is the durable form.** The vault on disk stays readable if
  this plugin never loads again.
- **Every write is a difference, never a replacement.**
- **No note path and no note body ever leaves the device except to Knap.** What
  goes to the server about a failure is four content-free facts
  ([ADR-0071](https://github.com/pantalytics/knap-mcp-admin/blob/main/docs/adr/0071-the-plugin-says-that-it-failed-never-what-it-held.md)).
