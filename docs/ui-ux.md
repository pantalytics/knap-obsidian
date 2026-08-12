# What this plugin should do, and what it should not

Synced Vaults is a fork of EVC Team Relay's Obsidian plugin. The fork exists because
we run one service and upstream builds a hosted product, and most of what this
plugin still renders answers questions our stack does not have.

This page is the design the fork is being cut down to. It was settled on
2026-08-11 against an interactive mockup, and the decisions behind it live as
ADRs in the private admin repository, `knap-mcp-admin/docs/adr/`: **0030**
(sign-in), **0031** (one control surface), **0032** (whole vault by default),
**0033** (one server), **0034** (permissions), **0039** (individual folders is
one toggle). Where this page and an ADR disagree, the ADR wins.

## The one rule

**Everything a person can change about their notes is changed here.** Which
folders sync, whether this device syncs, and who may read them. Knap's web page
sets nothing about the vault: it connects an AI and reports whether the chain is
working.

The tempting alternative is to split it, keeping folders here because a folder is
device-shaped and putting membership on the web because a membership is
account-shaped. That distinction is real in the architecture and invisible to the
person using it: from where they sit, *which folders* and *who can see them* are
the same decision about the same vault, made in the same sitting.

Note which way the collapse had to go. Everything-on-the-web is not available,
because a browser cannot list a laptop's folders, so folder selection would stay
here regardless and we would be back to two places. **Obsidian is the only
surface that can hold all of it**, and it is where the person already is.

## The flow

### 1. Install, then one button

The settings tab is a sentence and a button. No server field, no email, no
password, no code to paste. Pressing it opens a browser, Zitadel asks, and the
callback comes back through `obsidian://synced-vaults/oauth-callback`.

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
question about a vault they have not yet seen us handle.

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
carries the facts, the shared folders, who may read them, and the two actions
that belong to this device.

### 4. Shared folders instead

Somebody who wants less turns on **Sync individual folders**, the one setting on
this screen, and then shares folders **from the file explorer, the way this
plugin already works**: right-click a folder, *Synced Vaults: sync this folder*, at
any depth.
`Clients` and `Personal/Reading list` are both ordinary cases, which is why the
table shows the path rather than the leaf name.

The settings screen lists what exists. It never becomes a second way to create
one.

**This is an either/or, not a preference**, and the code enforces it in both
directions (`SharedFolder._new`): *syncing the whole vault cannot be combined
with folder shares*, and *this vault is already synced whole, so a folder cannot
be shared separately*. So the toggle is a switch between two states rather than
a third one, and flipping it is a single act: the shares the old mode owned come
off the server first, and the setting is written only once they have all gone.

**That order is the point of it existing** (ADR-0039). Unsharing folders one at a
time used to leave this plugin syncing nothing and the server still holding the
shares, and neither half noticed. A refusal now stops the switch: what came off
stays off, the setting still describes what is happening, and pressing the toggle
again picks up from there.

Both directions delete shares and make new ones, so both re-upload. The
confirmation says that before anything moves, and says the notes on the device
are not touched.

### 5. Signed out

The row turns red, the shares pause, and *Sign in again* is the primary button
inside it. Nothing has been lost, and the copy says so: every note is still on
this device.

## Vault, then shared folders, and never a third level

Two levels, here and on Knap's page. The vault is the row; inside it sits either
**Whole vault** as one line, or the table of shared folders. Anything that wants
to be a third level is a fact on the second, or it does not exist.

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
| **Folder** | A folder in it that syncs. *Synced folder* the first time on a screen, plain *folder* after that |
| **Sync** | What happens between them. **Synced Vaults** is this settings tab and Knap's own page, the same two words on both sides |
| **MCP** | How an AI reaches the vault |

| Not on screen | Say instead |
|---|---|
| share, workspace, space | folder |
| Relay Server, relay-onprem, Knap servers, Obsidian servers | Synced Vaults |
| relay, control plane, any hostname | Knap, or the vault |
| pair, pairing code, token | **Sign in** |
| viewer, editor, role | **can read**, **can edit** |

*Relay* is upstream's word for their product and their server. Neither is
something a person using this plugin has to know about, so neither reaches the
screen. `Relay: share folder` became `Synced Vaults: sync this folder`, for the same
reason the settings section stopped being called Relay Servers.

**Upstream's own screens still say all of it**, and they are left that way on
purpose. `Relays.svelte`, `ManageRelay.svelte`, `ManageSharedFolder.svelte` and
`ManageRemoteFolder.svelte` only render when `isRelayOnPremMode()` is false,
which it never is here, so nobody reads them. Renaming a file we rebase from
upstream costs every future rebase to buy a word that is never shown.

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
