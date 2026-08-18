# ADR-0075: A write to a note's file is an edit, and a conflict copy needs a real conflict

- **Status** Accepted
- **Date** 2026-08-18
- **Plane** Backend

> The decision register lives in
> [`knap-mcp-admin/docs/adr/`](https://github.com/pantalytics/knap-mcp-admin/tree/main/docs/adr).
> This file is here because it ships with the change it describes; the row in
> that register still needs adding.

## Context

Two faults, one shape underneath them.

A Kanban board opened as a plain note on 2026-08-17 (#81), missing the eight
bytes `---\n\nkan` from the front of the file. Without an opening fence there
is no frontmatter, so no `kanban-plugin: board`, so no board. Twelve minutes of
drawing in Excalidraw left twenty-one conflict copies of one file (#82), one
roughly every 34 seconds, growing from 3489 to 15006 bytes.

The stated cause of #81 was wrong, and the wrong reason pointed the fix at the
wrong place. Verified in the source at `467c04a`: Kanban's board view extends
`TextFileView` and `"kanban"` is in `ALLOWED_TEXT_FILE_VIEWS`
(`src/LiveViews.ts:60-63`, on by default per `src/flags.ts:41`), so a board does
get a `LiveView` and a `TextFileViewPlugin`, and `src/TextViewPlugin.ts` patches
the view's own `requestSave`. The patch is there. What it turns on is
`view.tracking`, which starts `false` (`src/LiveViews.ts:416,433`) and is only
set inside `resync()`, `syncViewToCRDT()`, the ytext observer, or the
`setViewData(_, clear=true)` branch. `resync()` awaits `doc.whenSynced()`, and
in that window `requestSave` fires a resync it does not wait for and calls the
original save: the bytes go to the file and nowhere else. Kanban re-serialises
the board on open, which is exactly when that window is open.

The second half is `src/main.ts`, which asked `if (isDocument(file) &&
!file.connected)` before pushing a disk write out. `connected` is a WebSocket
status (`src/HasProvider.ts:200-202`), not an editor binding, and `attach()` has
already connected the document by then, so the modify event was dropped too.
Disk and Y.Doc diverged with nothing recording it.

#82 is fully determined by the same source and needs no window at all.
`.excalidraw.md` is an ordinary `Document`, but Excalidraw's view type is
`"excalidraw"`, which is not in `ALLOWED_TEXT_FILE_VIEWS`, so no view is built,
no view plugin is installed, and nothing connects the document. `!file.connected`
is therefore always true, every autosave took the reconcile path, and
`reconcileWithConflictCopy` (`src/y-diffMatchPatch.ts:258-284`) writes a copy on
any difference at all, with no notion of the Y.Doc's content being an ancestor
of the file's. **There was no second writer.** The twenty-one copies were this device's own
previous autosaves, which is exactly what the measurement says: mutually
different, growing in size, one per autosave.

The eight bytes in #81 are **not reproduced**. Yjs deletes union rather than
intersect, so concurrent deletes can only remove more and cannot leave a gap,
and `diffMatchPatch` has a land-on-target backstop
(`src/y-diffMatchPatch.ts:175-188`). What is written down here is that the
precondition existed. The causal chain from it to those eight bytes is
inference, and it stays labelled as inference.

## Decision

A write to a note's file is an edit, and it is carried into the CRDT as one,
whether it came from CodeMirror, from Kanban, from Excalidraw or from any other
plugin, and whether or not the note's socket happens to be open.

A conflict copy is written only when a remote edit genuinely arrived in between,
measured against the Y.Doc's state vector rather than inferred from a text
difference. Each moment the file and the Y.Text are known to hold the same text
records a vector; a later write with that vector unchanged is a pure descendant
and is carried in with no copy, and a moved vector keeps the old route.

Two shapes of write are refused rather than carried: one that removes the
opening `---` fence from a note that had one, and one that empties a note that
was not empty. A refusal leaves both sides exactly as they are and logs. It
never falls back to reconciling, because a reconcile applies the same
destruction and leaves a file behind to tidy up.

## Consequences

- A board that re-serialises before its view starts tracking, and a drawing
  whose view type nothing recognises, both reach the relay as ordinary edits.
  #82 goes away entirely. For #81 this removes the precondition; see below.
- Conflict copies stop being the ordinary case. In the test rig, three autosaves
  against a lagging relay copy went from three copies to none, and the sync path
  on its own from three to one.
- Carrying plugin writes in makes a plugin's bad serialisation into real CRDT
  operations on every device that syncs the note. That is the price of the
  decision, and the refusal is what keeps it bounded. The refusal is narrow on
  purpose: it catches the shape #81 left behind and nothing else.
- The refusal can decline a deliberate truncation. Emptying a note or deleting
  its frontmatter inside Obsidian's own editor goes through CodeMirror and never
  reaches this path, so what it can decline is a plugin or an external program
  doing it on disk. That write stays on disk and out of the note until somebody
  looks at the log.
- The vector test does not distinguish a local operation from a remote one, and
  deliberately so: a local operation the file does not know about is content a
  carried write would delete, which is the same loss by another route. The cost
  is a reconcile where a carry would have been safe.
- A large `.excalidraw.md` re-diffed on every autosave builds a long operation
  history. Today's reconcile already does exactly this diffing, so the volume is
  not new, but it is now the normal path rather than the exceptional one. If
  sync gets slow on drawing-heavy vaults, this is the first place to look.
- Two guards keep a write from looping back through the CRDT: the note says so
  while it is inside its own `vault.modify`, which the patch reads
  synchronously, and a short window covers the modify event that follows.
  `diffMatchPatch` returning early on an empty diff is the third, and on its own
  it is not enough once a remote operation has landed in between.
- `SyncFile`s are untouched. Excalidraw also writes `.svg` and `.png` sidecars
  and those keep going down `file.sync()`.

## Alternatives rejected

- **Make `tracking` true sooner, or bind Excalidraw's view type.** Fixes the two
  plugins in front of us and leaves the next one to find the same hole. There is
  no list of view types that is ever complete.
- **The narrow brake alone**, refusing a write that takes the opening fence off
  a note. It is in the decision, as one clause. On its own it would have left
  every board edit still going to the file and nowhere else, and #82 untouched.
- **Ask whether the text differs, and copy when it does.** That is today's
  behaviour, and it is what produced twenty-one copies of one drawing. A text
  difference says the two sides are not equal, not that anybody's work is at
  risk.
- **Compare only other clients' entries in the state vector**, so a local
  operation does not force a reconcile. More precise about what "remote" means
  and wrong about what is at stake: see the consequence above.
- **Widen the reconcile route instead**, so a connected note reconciles too.
  It would carry the same writes and charge a conflict copy for each one.
