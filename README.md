# Knap

**Your vault on Knap, on every device you use.** The whole vault, on desktop and
on phone, with real-time collaborative editing on all of it.

The plugin keeps your notes as plain markdown in your vault. Knap holds a CRDT
copy, so two people can edit the same note without a merge conflict and a device
that was offline catches up when it reconnects.

---

## What it does

- **The whole vault, and nothing to pick.** Sign in, choose which cloud vault
  this one belongs to, and everything syncs. Making a folder makes it
  everywhere, moving it moves it everywhere, deleting it deletes it everywhere,
  the way any other sync behaves.
- **Two people, one note.** Edits merge as you type. No conflict copies, no
  last-writer-wins.
- **Offline is normal.** Edit on a plane, reconnect, and Knap catches up.
- **Attachments travel with the notes.** Images and PDFs sync alongside the
  markdown.
- **Phone included.** `isDesktopOnly` is false, sign-in comes back over an
  `obsidian://` link rather than a local port, so iOS and Android work the same
  way the laptop does.

This is the Obsidian half of [Knap](https://github.com/pantalytics), where the
same vault is reachable by an AI assistant over MCP. You do not need to use that
half: sign in, and the plugin syncs.

---

## Install

The plugin is not in the community catalog yet. Two ways to install it today.

### BRAT

[BRAT](https://obsidian.md/plugins?id=obsidian42-brat) installs plugins straight
from GitHub and keeps them updated.

1. Install and enable **BRAT** from *Settings → Community plugins → Browse*
2. *Settings → BRAT → Add beta plugin*
3. Paste `pantalytics/knap-obsidian`, pick the latest version, **Add plugin**
4. Enable **Knap** in *Settings → Community plugins*

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/pantalytics/knap-obsidian/releases/latest)
2. Put all three in `<your vault>/.obsidian/plugins/synced-vaults/`
3. Reload Obsidian and enable **Knap**

### Coming from an older version

The plugin was called Knap Sync up to 1.4.0 and Synced Vaults from 1.5.0 to
1.7.0. The name is Knap again from 1.8.0, and this time only the name changed:
the identifier stays `synced-vaults`, so the plugin updates in place and there
is nothing to delete and nothing to sign in to again.

Coming from Knap Sync is the upgrade that does cost something, because Obsidian
keys a plugin by its identifier and that one did change. Delete
`.obsidian/plugins/knap-sync/` once the new one is enabled, or two copies will
sync the same vault against each other. On BRAT, remove the beta plugin first
and add `pantalytics/knap-obsidian` again.

---

## Sign in

*Settings → Knap → Sign in.* A browser opens, you sign in with your Knap
account, and Obsidian picks it up from there. There is no address to type and no
code to paste, on a laptop or on a phone.

That button is the only way in. There is nothing else to try and nothing behind
it to choose.

Then *Cloud vault → Choose*, and pick which cloud vault this one belongs to. One
local vault is linked to one cloud vault, and linking replaces rather than adds,
so a vault is never syncing with two places at once.

After that the whole vault syncs, and there is nothing else to pick: a vault is
what syncs. To keep part of your notes off the cloud, keep them in a second
vault.

*Unlink* stops the syncing and deletes nothing, on either side. *Sign out* ends
this device's access and hands the credential back, so a laptop you pass on is
not a way in forever.

The plugin talks to Knap and nothing else, so there is no address to configure.
If you want to run your own, [EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin)
is the plugin for it, and this one is a fork of it.

---

## What it costs

The plugin is free and MIT licensed. Nothing to buy in it, and no licence key to
enter. What a Knap account costs is a question for Knap, not for the plugin.

---

## Network use

**A Knap account is required.** The plugin is a client, and with nothing to sign
in to there is nothing for it to sync against.

It talks to Knap, and to an identity provider only while you are signing in
through one.

| Connection | Protocol | What for | When |
|---|---|---|---|
| Knap | HTTPS | Trading the sign-in code for this device's credential, and handing it back at sign-out | Signing in and out |
| Knap | HTTPS | Which cloud vaults your account can open, and how large a file the server takes | Opening the picker, and starting a link |
| Knap | HTTPS | Attachment bytes, up and down | When an image or a PDF appears, changes or is opened on another device |
| Knap | WSS | The document sync itself: the vault's file tree, and one connection per note in play | While the vault is linked |
| Your browser | HTTPS | The sign-in page, at Knap and then at whichever identity provider Knap uses | Only while you are signing in |
| `obsidian://` callback | Obsidian URL scheme | Receiving the sign-in handoff | During sign-in only |

The identity provider row is worth being precise about. **The plugin never
contacts an identity provider at all**, and it holds no client id and no secret
for one. It opens a page at Knap in your browser, and what comes back through
the `obsidian://` link is a one-time handoff code rather than a credential,
because a deep-link URL survives in browser history. The credential itself is
fetched over TLS, once.

**No telemetry.** The plugin does not phone home, count anything, or send your
notes anywhere except to Knap.

---

## Where this comes from

This plugin is a fork of
[EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin),
which is itself derived from [Relay](https://github.com/No-Instructions/Relay)
by No Instructions, LLC. Both are MIT licensed and both copyright lines are
carried in [LICENSE](LICENSE), with the full attribution in [NOTICE](NOTICE).

The fork exists for two things upstream does not do: vault-wide scope as a first
class option, and a sign-in that survives an identity provider matching redirect
URIs exactly, which is why the callback arrives over `obsidian://` instead of a
loopback port. Upstream serves anybody running their own server, which this fork
no longer does: it talks to Knap and nothing else.

The syncing itself is no longer upstream's either. Since August 2026 the sign-in,
the link, the file tree and both directions of every edit are ours, in
`src/knap/`, against a server we wrote. What is left of the fork is compiled in
and does not run. [`docs/architecture.md`](docs/architecture.md) says which is
which.

---

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm run lint
npm test
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including how to load a
development build into a vault.

Before changing anything, [`docs/architecture.md`](docs/architecture.md): the
plugin carries two layers, only one of them ships, and knowing which file
belongs to which is the thing most likely to send a change to the wrong place.
[`docs/ui-ux.md`](docs/ui-ux.md) is the screen and the words, and
[`docs/README.md`](docs/README.md) indexes both.

## Support

- [Report a bug](https://github.com/pantalytics/knap-obsidian/issues/new?template=bug-report.yml)
- [Request a feature](https://github.com/pantalytics/knap-obsidian/issues/new?template=feature-request.yml)

## License

MIT. Copyright (c) 2024 No Instructions, LLC, (c) 2024-2026 Entire VC,
(c) 2026 Pantalytics. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
