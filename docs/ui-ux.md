# What this plugin should do, and what it should not

Knap Sync is a fork of EVC Team Relay's Obsidian plugin. The fork exists because
we run one service and upstream builds a hosted product, and most of what this
plugin still renders answers questions our stack does not have.

This page is the design the fork is being cut down to. It was settled on
2026-08-11 against an interactive mockup, and the decisions behind it live as
ADRs in the private admin repository, `knap-mcp-admin/docs/adr/`: **0030**
(sign-in), **0031** (one control surface), **0032** (whole vault by default),
**0033** (one server), **0034** (permissions), **0042** (a vault is one share,
which retired 0039's toggle). Where this page and an ADR disagree, the ADR
wins.

## The one rule

**Everything a person can change about their notes is changed here.** Whether
this device syncs, and who may read the vault. Knap's web page sets nothing
about the vault: it connects an AI and reports whether the chain is working.

*What* syncs is no longer on that list, because it is no longer a question: a
vault syncs whole (ADR-0042). What is left is device-shaped or account-shaped,
and both live here rather than
being split across two surfaces. That distinction is real in the architecture
and invisible to the person using it: from where they sit, *does this laptop
sync* and *who can see this* are the same decision about the same vault, made in
the same sitting.

## The flow

### 1. Install, then one button

The settings tab is a sentence and a button. No server field, no email, no
password, no code to paste. Pressing it opens a browser, Zitadel asks, and the
callback comes back through `obsidian://knap-sync/oauth-callback`.

That button is the only way in. There is no *Other ways to sign in*, and no email
and password form behind it: an account created through the identity service has
no password until an admin sets one, so the second door opened onto nothing. A
choice of two, where one of them cannot work for a new person, is worse than no
choice at all.

There is no server field because there is no second server (ADR-0033). The list,
the default chip, the duplicate check, the connection test, the endpoint editor
and the self-host dialog all answer a question nobody is asked now.

### 2. The whole vault syncs, without asking

Signing in shares the vault at its root, through the vault scope in
`src/vaultScope.ts`. The person watches notes move instead of answering a
question about a vault they have not yet seen us handle. There is no second
answer to give: one vault is one share, the way it is in Obsidian Sync and in
every other sync a person has used.

Two lines of copy while they wait, and both earn their place:

- *The whole vault is on its way up. Leave Obsidian open until it finishes, and
  it picks up where it left off if you close it.*
- *Your notes, all of them. Not your settings, themes or plugins: those stay on
  the device they are installed on.*

The second is not a detail. A bare second device reads as a failed sync to
anybody expecting their setup to arrive with the notes, and this is the only
moment they are looking at the screen.

### 3. Working

One row for the vault: a dot, the name, the state, when it last moved. Open, it
carries the facts, who may read them, and the two actions that belong to this
device.

### 4. Folders are content, not settings

A folder is a thing inside the vault, and the vault is what syncs. So there is
no folder picker, no *Knap Sync: sync this folder* on the context menu, and no
*Add a folder* button. **Making a folder makes it everywhere, moving it moves it
everywhere, and deleting it deletes it everywhere**, which is what a person
already expects from a sync and what they get from Obsidian Sync.

That last one looks like it needs code and does not, which is worth writing
down because it cost a wrong change to find out. `deleteFile` removes one entry
from the sync store, and a folder is an entry like any other, so deleting a
folder reads like it would leave the notes inside it behind. **Measured in a
real Obsidian on 2026-08-12** (`make obsidian` in the admin repo, against the
build at `4a72663`): Obsidian fires a `delete` event for every descendant
before the folder's own, empty subfolders included, on both `vault.delete` and
the file explorer's `fileManager.trashFile`. Every note removes itself, and the
shared map is clean afterwards with a same-prefix sibling untouched. A cascade
inside `deleteFile` is not needed, and the one written for it walked the whole
sync store once per delete event.

**Adopting a share does not ask either.** The member screen's *Sync this vault
here* attaches at the vault root with the vault scope, the same way signing in
does. It used to open a folder picker, which made a folder-scope record for a
share the rest of the plugin treats as a whole vault: that disagreement is
exactly what one share per vault exists to end, so a picker here would have
reintroduced it through the back door.

The one screen that still names a folder is for vaults an older build left
syncing them: whole vault and folder shares are exclusive in both directions
(`SharedFolder._new`), so the folders come off before the vault share can be
made. It is a button, it asks first because deleting a share deletes its
documents, and it goes when the last of those vaults has been through it.

### 5. Signed out

The row turns red, the shares pause, and *Sign in again* is the primary button
inside it. Nothing has been lost, and the copy says so: every note is still on
this device.

## One vault, one row, and never a second level

The vault is the row and there is nothing under it. Anything that wants to be a
second level is a fact on the first, or it does not exist. This is the shape
ADR-0042 bought: the table of folders that used to sit inside the row was the
only reason there were ever two.

## One status, written once

The states live in `status.py` in the admin repository and that stays the single
source. **This plugin reads from that list rather than inventing its own words.**
The screens showed *Uploading, 412 of 1,202* and *Syncing, 412 notes so far* for
one fact, which teaches a person they are watching two things fail in two ways.

| Part of the row | Rule |
|---|---|
| State word, dot, counts, bar | Identical to Knap's, string for string |
| The instruction under it | Whatever this side can act on |
| Caveats and warnings | Here only. Nobody is watching a web page during a first sync |

The states are **Syncing**, **Up to date**, **Paused**, **Signed out**. Only the
last one differs between the screens on purpose: the fix lives here, so only this
side gets the button.

## The words

Four of them, and no others. This is Knap's ADR-0038, and the admin repo's
`docs/nomenclature.md` carries the same table, because a person moves between
the two applications in one sitting and matching up two vocabularies is not
their job.

| On screen | What it means |
|---|---|
| **Vault** | This Obsidian vault |
| **Folder** | A folder inside the vault. It syncs because the vault does, so it is never a thing to turn on |
| **Sync** | What happens between them. **Knap Sync** is this settings tab and Knap's own page, the same two words on both sides |
| **MCP** | How an AI reaches the vault |

| Not on screen | Say instead |
|---|---|
| share, workspace, space | folder |
| Relay Server, relay-onprem, Knap servers, Obsidian servers | Knap Sync |
| relay, control plane, any hostname | Knap, or the vault |
| pair, pairing code, token | **Sign in** |
| viewer, editor, role | **can read**, **can edit** |

*Relay* is upstream's word for their product and their server. Neither is
something a person using this plugin has to know about, so neither reaches the
screen. `Relay: share folder` became `Knap Sync: sync this folder` for that
reason, and then went altogether when there stopped being a folder to sync on
its own.

**Upstream's own screens still say all of it**, and they are left that way on
purpose. `Relays.svelte`, `ManageRelay.svelte`, `ManageSharedFolder.svelte` and
`ManageRemoteFolder.svelte` only render when `isRelayOnPremMode()` is false,
which it never is here, so nobody reads them. Renaming a file we rebase from
upstream costs every future rebase to buy a word that is never shown.

**That is also where every remaining folder picker lives**, and it is the check
to run before believing the pickers are gone: `FolderSuggestModal`,
`ShareFolderModal`, `AddToVaultModal`, `RemoteFolderSuggestModal` and
`FolderSelectInput` are all reached only from those four. `PluginSettings.svelte`
branches to `RelayOnPremSettings` on `isRelayOnPremMode()`, so in this fork they
are unreachable rather than merely unused. A picker that turns up on a screen we
do render is a bug, not upstream's business.

## Permissions come from one place

Invites are set here, stored by the control plane, and read by everything else.
**The MCP grants nothing.** An AI connects as the person who added it and reaches
exactly what that person reaches, so removing somebody from a share removes their
AI with them, in one act, with nothing to remember.

There is no scope list, no per-connector grant, and no table mapping our users to
theirs. Any of those is a second permission model, and two of them disagree the
week somebody leaves.

## What goes

| | Why |
|---|---|
| `Relays.svelte`, `ManageRelay.svelte` | Upstream's hosted product at entire.vc. On our stack the list stays empty forever, beside the one that matters |
| `BillingView.svelte` | We run one service. Nothing to buy, no plan to be on |
| `AgentKeysView.svelte` | Write-only, per share, and they need web publishing on. Reading needs an account, so this was never our credential |
| `RelayOnPremServerList.svelte`, `EndpointConfigModal`, `SelfHostModal` | One server (ADR-0033). The largest single file in the fork, serving a question nobody is asked |
| `Discord.svelte`, `GetInTouch.svelte`, the icon and button rows | Already gone. They sent people away from the screen before it had said anything |
| `CreateShareView.svelte`, `QuickShareModal` | Already gone (ADR-0042). A vault is one share and nothing creates a second |
| `ShareManagementModal`'s `createShare` and `createLocalSharedFolder` | Dead with the form above them. The modal itself stays: it is the other route to the member list |

## What stays, and gets rewritten

`CreateInviteView.svelte` and `UserSelectModal` were on the removal list until
2026-08-11, on the reasoning that membership belonged on the web. With invites
moving here they stay, in our wording: *can read* and *can edit* rather than
viewer and editor, and no relay anywhere in the copy.

## Two things to check before changing any of this

- **Vault scope has no prefix guard.** A folder share is protected inbound by its
  own path prefix; a vault share is protected only by `isExcludedPath`, and the
  write path uses `vault.adapter` rather than Obsidian's file index. A regression
  there writes a remote file into somebody's plugin directory.
- **The OAuth state check is load-bearing.** Anything on the machine can invoke a
  URL scheme, so a callback carrying the wrong state is rejected rather than used
  (TR-21). It survived the move off the loopback server on purpose.
