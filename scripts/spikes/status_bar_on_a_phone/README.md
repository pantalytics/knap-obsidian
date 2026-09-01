# Does the status bar's head fit a phone?

The bar was drawn for a desktop width and #125 was the bill: on an iPhone the
head ran past its card and `.knap-status { overflow: hidden }` cut it, taking
the note count with it. The fix was reasoned off the CSS. This measures it.

Run it:

```sh
node scripts/spikes/status_bar_on_a_phone/measure.mjs
```

It needs `playwright-core` and a Chromium, neither of which is a dependency of
this plugin, so it installs nothing and skips with exit code 2 when they are
not there. Where Playwright's own browser does not match its version, point it
at one: `KNAP_CHROMIUM=/path/to/chrome node .../measure.mjs`. In this repo's own CI they are not, which is why this is a spike
rather than a test: it is run by a person changing the bar, not by a robot.

## What it does

Renders the head exactly as `KnapSettingsTab.drawStatus()` builds it, inside a
card the width Obsidian's settings sheet gives it on a 390px screen, against
the real `styles.css`. Then it asks one question of every rendering: **is
anything outside the card?**

The vault name is the one from the #125 screenshot, `260812_RH_Obsidian_vault`,
because a name that long is what made a comfortable row into a broken one.

## The thing it cannot know, and what it does instead

**Obsidian's own font sizes on a phone.** `--font-ui-small` and the base size
are the app's, not ours, and there is no Obsidian on the machine that runs this
(the real-app e2e needs a docker daemon). So it sweeps them instead of guessing
one, and every size in the sweep has to pass.

That sweep is what caught the fix's first measurement being worthless: at a
desktop-ish 13px the old CSS did not overflow at all, and the bug only appears
from about 15px, which is where a phone starts.

## What it measured on 2026-09-01

Point `styles.css` at the commit before the fix and the cut grows with the font
size, on the same *Syncing* head this script renders:

| base / `--font-ui-small` | cut off the right |
|---|---|
| 16 / 13 | none |
| 16 / 15 | 9px |
| 17 / 16 | 27px |
| 18 / 17 | 44px |

A longer word in front of it costs more: *Up to date* rather than *Syncing*
puts the same row 28px, 46px and 65px outside.

**The overflow is to the right only, and the dot is never cut.** #125 and this
PR both said the dot went off the left edge, read off a screenshot. It does
not: negative free space in a flex row packs the items left and spills the tail,
so the count is what is lost and the dot stays where it is. The claim is
corrected in `docs/ui-ux.md`; this table is where it was settled.

After the fix, nothing is outside the card at any size in the sweep.
