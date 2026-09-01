# The screen, and what it refuses to be

**Design document.** What a person sees in Obsidian, and why it has this shape.
[`architecture.md`](architecture.md) is what sits underneath it. The design the
fork was being cut down to before the rebuild is
[`archive/ui-ux-fork.md`](archive/ui-ux-fork.md), and nothing in it describes
what ships.

The decisions live as ADRs in the admin repository, `knap-mcp-admin/docs/adr/`:
**0030** sign-in, **0031** one control surface, **0033** one server, **0034**
permissions, **0038** the words, **0043** a vault is one unit, **0045** the
plugin is Knap, **0066** one local vault to one cloud vault, **0071** what a
failure may say. Where this page and an ADR disagree, the ADR wins.

## The rule

**Everything about the vault is set here in Obsidian. Knap's page reports.**
One row is taken out of that: **who may read a cloud vault is set on Knap's page
and nowhere else**, because that is a fact about a vault rather than about a
device, and two places to set it is how two places come to disagree.

So this side owns: whether this device is signed in, and which cloud vault this
local vault is linked to. That is the whole list, and it is why the screen is
this short.

## The screen

One settings tab. Obsidian's own `setting-item` rows, so it reads like the pages
either side of it rather than like a panel we built.

```
  Settings → Knap
  ┌──────────────────────────────────────────────────────────────┐
  │ next.knap.pantalytics.com                                    │  ← the host,
  │                                                              │    once, quietly
  │ ┌──────────────────────────────────────────────────────────┐ │
  │ │ ● Syncing                     Work notes · 312 notes   ▾ │ │  ← the bar
  │ ├──────────────────────────────────────────────────────────┤ │
  │ │ Leave Obsidian open until it finishes. It picks up       │ │
  │ │ where it left off if you close it.                       │ │
  │ │ Cloud vault      Work notes                              │ │
  │ │ Notes            312                                     │ │
  │ └──────────────────────────────────────────────────────────┘ │
  │                                                              │
  │ Account                                       [ Sign out ]   │
  │ Signed in.                                                   │
  │                                                              │
  │ Cloud vault                                   [ Unlink ]     │
  │ Work notes. Deleting a note here deletes it in the cloud     │
  │ vault too, and the other way round.                          │
  └──────────────────────────────────────────────────────────────┘

  signed out:                        signed in, not linked yet:
  ┌────────────────────────────┐     ┌────────────────────────────┐
  │ Account       [ Sign in ]  │     │ Cloud vault  [ Choose... ] │
  │ Not signed in. Signing in  │     │ Not linked.                │
  │ opens your browser and     │     └────────────────────────────┘
  │ comes back here.           │
  └────────────────────────────┘

  a vault has been chosen, and the link is coming up:
  ┌──────────────────────────────────────────────────┐
  │ ◠ Syncing                          Work notes  ▾ │  ← the dot turns
  │                                                  │
  │ Cloud vault                      [ Linking... ]  │  ← and does not press
  │ Linking to Work notes. This can take a moment.   │
  └──────────────────────────────────────────────────┘
```

### While a link is being made

**Cloud vault has three states, and the third one is where this screen was
worst.** A vault is chosen, the socket is on its way up, and on a phone that is
several seconds in which nothing used to move: the row said *Not linked* and
the bar said *Up to date*, because the page redrew only where it had just
pressed something. Somebody who chose again took the first attempt down half
way and got *This vault is not linked any more.* over a link they had asked for
(ADR-0086).

So the row names the vault it is linking to, its button says **Linking...** and
does not press, and the dot in the bar turns for as long as anything is moving.
A link is made when the cloud vault answers rather than when every note has
travelled, so the rest of it is reported by the bar: *Syncing* with the count
climbing, then *Up to date*, or *Problem* with **Try again** if something stuck.

The page watches while it is open rather than redrawing where it was pressed.
Everything it reports now finishes on its own, and a climbing number is written
in place once a second, because announcing every note of a few thousand would
redraw the page a few thousand times and shut a fold somebody had opened.

Each of the three parts earns its place. **The bar** says how it is going, and
is first because it is what somebody came to find out. **Account** is who.
**Cloud vault** is what this vault syncs with. The two rows under the bar are
what somebody came to change, which is rarer than wanting to know.

The screen exists at all because the commands were the only way in, and a
command palette is where somebody looks after they already know the thing is
there. Asked to try the beta, the first thing a person does is open Settings and
look for a button.

Four things that are absent on purpose:

- **No server field.** There is one server and no second one to point at.
- **No scope or folder picker.** A vault is one unit. Somebody who must keep
  part of their notes off the cloud uses a second vault, which is Obsidian's own
  answer.
- **No second kind of member to set.** There is one kind of person in a vault.
- **No Change button on Cloud vault.** Linking somewhere else is Unlink and then
  Choose, which is what happens underneath either way. A third button to say so
  is a third button.

And one thing that is present on purpose: **signed in, there is always a way
back out.** A screen that can only sign in is one a person cannot hand their
laptop on from, and the only alternative was uninstalling the plugin, which
leaves the token alive anyway.

### The bar, and the fold

The bar is the only thing on the screen that folds, and that is the hierarchy.
The dot and the word are always out. The vault and its note count sit at the far
end, pushed there rather than following the word so the eye finds the word in
the same place whatever it is about. Everything else comes out when somebody
asks:

| Behind the fold | When |
|---|---|
| The instruction for this word | Whenever the word carries one |
| Cloud vault, Notes | When there is a link, and when notes have arrived |
| Could not sync, *N* changes | When something failed and stayed failed |
| **Try again** | Only under *Problem* and *Offline*, the two words a person can act on |

Nothing deeper is kept here at all. What went wrong in detail is the server's;
this device only ever tells it four content-free facts (ADR-0071).

## The words

Six, from `src/syncStatus.ts`, and no screen invents a seventh. That file is the
list. It used to mirror a `status.py` in the admin repository, and that file went
with the rebuild, so there is nothing on the other side to keep in step with
today.

| Word | Dot | The instruction under it |
|---|---|---|
| **Syncing** | accent | Leave Obsidian open until it finishes. It picks up where it left off if you close it. |
| **Up to date** | green | none |
| **Paused** | yellow | Nothing is moving while this device is paused. |
| **Offline** | yellow | Your changes are saved here and go up when the connection is back. |
| **Signed out** | red | Your notes are all still on this device. Sign in again to carry on. |
| **Problem** | red | Everything else is up to date, and nothing was lost. |

The order they are decided in is the argument: no account beats everything,
because nothing else is even attempted without one. Paused beats the rest
because the person did it on purpose. **Offline beats Problem**, because a device
with no connection has everything stuck, and blaming the notes for what the
tunnel did sends somebody looking in the wrong place.

**Two words share each of the two unhappy dots**, and that is what having both
carriers is for. Yellow is wait: Paused and Offline both resolve with nobody
doing anything. Red is act: Signed out and Problem both need a person.

Offline and Problem were added on 2026-09-01, because four words could not say
that something was wrong and Signed out held the only error dot, so a refused
upload had to present itself as a missing account. **The rule for adding a
seventh is that a word earns its place when the reader's next move is
different.**

Counts are one phrasing: *412 of 1,202* once something has counted the far side,
*412 notes so far* while the first pass is still discovering how much there is.
Inventing the second number would be worse than not saying it.

### The corner of the window

The same reading, drawn small: the icon wears the dot, the count sits beside it,
and a two pixel bar follows while there is a denominator to draw it against. The
word itself is in the tooltip rather than on screen, because the corner is read
out of the side of the eye during a first sync and what is wanted there is how
far along, not a sentence.

It reads `readVaultStatus()` in `main.ts`, which returns the Knap client's own
`status()` whenever there is one. **The corner and the settings screen cannot
word one vault two ways**, which is the whole reason it is read there and not
computed beside the icon. The bar is absent rather than empty when nothing is
moving: an empty track beside a finished vault reads as work that never started.

## Choosing a cloud vault

A suggest modal, and the list is fetched every time it opens. That is the whole
answer to the gap between two windows: somebody who has just made a cloud vault
in the browser closes the picker, opens it again, and it is there. No refresh
button, no polling, and no message telling them to reopen it.

```
  ┌ Search cloud vaults... ───────────────────────────────┐
  │ Work notes                                            │
  │ Tuinplannen                                           │
  │ New cloud vault                 opens Knap in browser │  ← always last,
  └───────────────────────────────────────────────────────┘     survives every query
```

The state of the fetch goes in the placeholder (*Asking Knap...*, *Could not
reach Knap. Your notes are safe here.*), never into the list, so there is never
a row somebody can select that is not a thing they can choose.

**The way out is in the list rather than beside it**, because it answers the same
question. A person with no cloud vaults used to be told to go and make one in the
panel and then left in Obsidian with nothing to press. It sits last, under
everything real, and it survives every query: somebody typing the name of a vault
that does not exist yet is exactly the person who needs it.

Each row is the vault's name and nothing else. There is one kind of person in a
vault, so there is no access level to qualify it with.

Choosing one closes the picker, and the wait that follows belongs to the screen
behind it: the settings page carries the linking state above. Closing the
picker without choosing anything is an answer too, and it settles rather than
leaving a page that never looks again.

## The commands

Four, all still labelled *(beta)*, which is a name that has outlived its
accuracy now that this is the only shipping path.

| Command | The same act as |
|---|---|
| Sign in (beta) | the Account row's button |
| Link this vault (beta) | Cloud vault, Choose |
| Sign out (beta) | the Account row's button |
| Unlink from the cloud vault (beta) | Cloud vault, Unlink |

Both entry points share one implementation, so the palette and the screen cannot
drift into two accounts of the same act. `signOutNotice` exists for exactly that
reason.

## What a notice says

A notice is what this plugin has instead of a page, so each one says what
happened and what is now true.

| After | It says |
|---|---|
| Signing in | Signed in. Now link this vault. |
| Linking | Linked. This vault now syncs with *name*. Said when the cloud vault answers, which is when the link exists; the notes are still on their way and the bar says so |
| A link that could not be made | Could not reach the cloud vault. Your notes are safe here. The link is kept, because linking replaces whatever was there, and Try again is on the bar |
| Choosing a second cloud vault while the first is still coming up | Still linking to *name*. Wait for that to finish. |
| Unlinking | Unlinked. Nothing was deleted, anywhere. |
| Signing out | Signed out. Nothing was deleted, anywhere. |
| Signing out with no connection | Signed out here only. Knap could not be reached, so it may still count this device as signed in. |
| A file too large | *path*: This file is 24 MB, and the cloud vault takes attachments up to 10 MB. It stays on this device. Both numbers, because *too large* leaves somebody guessing by how much. Refused here rather than uploaded and refused there, so nobody spends their upstream first |
| A vault that is full | *path*: The cloud vault is full. Remove some attachments from it, or use a second vault. |
| A sign-in that started elsewhere | That sign-in did not start here. Run sign in (beta) and try again. |
| A link that cannot come back up | Knap could not reach your cloud vault. It will retry when you sign in again. |

Two shapes to copy. **Say what is still true**, because the fear behind most of
these is losing notes: *nothing was deleted, anywhere*, *your notes are safe
here*, *it stays on this device*. And **never claim what was not measured**: the
sign-out that could not reach the server says so rather than reporting success.

## The look

**Everything is Obsidian's, not ours.** The colours are the vault's theme
variables and the accent is whichever one the person picked, because a settings
tab that looks like our website is the one tab in the list that looks wrong.
Ours is how short the sentences are, not what colour they sit on.

The classes are in `styles.css` under `.knap-`: the host line, the bar and its
fold, the four dots, the picker's way out. All of them are built from
`--background-*`, `--text-*`, `--size-*` and `--color-green|yellow|red`.

## The words a person sees

The admin repo's `docs/nomenclature.md` carries the same table, because somebody
moves between the two applications in one sitting and matching up two
vocabularies is not their job.

| On screen | What it means |
|---|---|
| **Vault** | This Obsidian vault. **Cloud vault** is the one on Knap, and *local vault* is this one when both halves are in view |
| **Folder** | A folder inside the vault. It syncs because the vault does, so it is never a thing to turn on |
| **Sync** | What happens between them |
| **Link** and **Unlink** | The relationship, and ending it. Unlink stops the syncing and deletes nothing, which is what tells it apart from deleting a vault |
| **Account**, **Sign in**, **Sign out** | Who, and the two ends of it |

| Not on screen | Say instead |
|---|---|
| share, workspace, space | folder |
| relay, control plane, server, a hostname | Knap, or the cloud vault. The one exception is the host line at the top of the tab, which is there because a beta build talks somewhere other than a release does, and it sits nowhere near a button because it is not a choice |
| client | device |
| pair, pairing code, token | **Sign in** |
| viewer, editor, owner, role | nothing. There is one kind of person in a vault |
| remote vault | cloud vault |

*Relay* is upstream's word for their product and their server, and neither is
something a person using this plugin has to know about.

**Upstream's own screens still say all of it, and they are left that way.**
`Relays.svelte`, `ManageRelay.svelte`, `ManageSharedFolder.svelte` and
`ManageRemoteFolder.svelte`, and every folder picker reached from them, render
only in a world this build does not have. Renaming a file we rebase from
upstream costs every future rebase to buy a word nobody reads. **A picker that
turns up on a screen we do render is a bug**, and that is the check to run before
believing they are gone.

## Changing any of this

- The screen is `src/knap/KnapSettingsTab.ts`. `statusFacts` and `hasRetry` are
  exported and pure precisely so the branching is pinned in
  `__tests__/knap/settingsTab.test.ts` rather than asserted against a screen.
- What the screen reads while a link is being made is `KnapSync.linking` and
  `KnapSync.onChange`, and what those promise is pinned in
  `__tests__/knap/linking.test.ts` against a fake network that can be made to
  take a connection and then say nothing.
- The words are `src/syncStatus.ts`, and adding one means the rule above.
- The picker is `ObsidianKnap.ts`; `vaultChoices` and `pickerPlaceholder` are
  exported for the same reason.
- Run the `humanizer` skill over any sentence a person reads before it ships,
  and keep em-dashes out of it.
