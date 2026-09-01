# Docs

Four kinds of document, and a document is exactly one of them. If a page answers
two it gets split; if it answers none it is archived.

| | The question | Where |
|---|---|---|
| **Structure** | What *is* it? | [`architecture.md`](architecture.md) |
| **Design** | What does a person see, and why that? | [`ui-ux.md`](ui-ux.md) |
| **Operations** | How does a release get out? | [`catalog-submission.md`](catalog-submission.md), and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| **History** | How did we get here? | [`archive/`](archive/) -- do not design from it |

**If you are an agent, read [`architecture.md`](architecture.md) first.** It
gives you the two layers, the switch between them, and which of the two any
given file belongs to, which is the thing most likely to send a change to the
wrong place here.

The reasoning lives in the other repository. Decisions are ADRs in
[`pantalytics/knap-mcp-admin`](https://github.com/pantalytics/knap-mcp-admin)
under `docs/adr/`, and its `CLAUDE.md` carries the standing answers: what has
been measured, ruled out, and does not need proposing again. Both pages here
cite ADRs by number, and where a page and an ADR disagree, the ADR wins.

## The other half

| | |
|---|---|
| `knap-mcp-admin/docs/architecture.md` | The server, in the same shape as this repo's |
| `knap-mcp-admin/docs/design.md` | Knap's own page: its screens, its tokens, its state words |
| `knap-mcp-admin/docs/nomenclature.md` | Every word, on screen and in the code, for both halves |

## Archive

| | |
|---|---|
| [`ui-ux-fork.md`](archive/ui-ux-fork.md) | The design the fork was being cut down to, before the rebuild. The words and the one-screen rule survive it; the control plane, the shares and the screens do not |
