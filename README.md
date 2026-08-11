# Knap Sync

**Your vault on Knap, on every device you use.** A whole vault or one folder at
a time, on desktop and on phone, with real-time collaborative editing on
whatever you share.

Knap Sync keeps your notes as plain markdown in your vault. Knap holds a CRDT
copy, so two people can edit the same note without a merge conflict and a device
that was offline catches up when it reconnects.

---

## What it does

- **Sync a whole vault, or pick folders.** Sync everything, or share
  `Projects/` and leave the rest of the vault alone.
- **Two people, one note.** Edits merge as you type. No conflict copies, no
  last-writer-wins.
- **Offline is normal.** Edit on a plane, reconnect, and Knap catches up.
- **Attachments travel with the notes.** Images and PDFs sync alongside the
  markdown.
- **Phone included.** `isDesktopOnly` is false, sign-in comes back over an
  `obsidian://` link rather than a local port, so iOS and Android work the same
  way the laptop does.

Knap Sync is the Obsidian half of [Knap](https://github.com/pantalytics), where
the same vault is reachable by an AI assistant over MCP. You do not need to use
that half: sign in, and the plugin syncs.

---

## Install

Knap Sync is not in the community catalog yet. Two ways to install it today.

### BRAT

[BRAT](https://obsidian.md/plugins?id=obsidian42-brat) installs plugins straight
from GitHub and keeps them updated.

1. Install and enable **BRAT** from *Settings → Community plugins → Browse*
2. *Settings → BRAT → Add beta plugin*
3. Paste `pantalytics/knap-obsidian`, pick the latest version, **Add plugin**
4. Enable **Knap Sync** in *Settings → Community plugins*

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/pantalytics/knap-obsidian/releases/latest)
2. Put all three in `<your vault>/.obsidian/plugins/knap-sync/`
3. Reload Obsidian and enable **Knap Sync**

---

## Sign in

*Settings → Knap Sync → Sign in.* A browser opens, you sign in with your Knap
account, and Obsidian picks it up from there. There is no address to type and no
code to paste, on a laptop or on a phone.

Email and password are still there, under *Other ways to sign in*, for a day the
sign-in page will not load.

Then share a folder, or sync the whole vault, and the first sync starts.

There is one Knap server and the plugin talks to that one. If you want to run
your own, [EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin)
is the plugin for it, and this one is a fork of it.

---

## What it costs

The plugin is free and MIT licensed. Nothing to buy in it, and no licence key to
enter. What a Knap account costs is a question for Knap, not for the plugin.

---

## Network use

**A Knap account is required.** Knap Sync is a client, and with nothing to sign
in to there is nothing for it to sync against.

Knap Sync talks to Knap, and to an identity provider only while you are signing
in through one.

| Connection | Protocol | What for | When |
|---|---|---|---|
| Control plane | HTTPS | Sign-in, token refresh, listing and creating shares, inviting people | On login and on share operations |
| Control plane | HTTPS | Issuing the short-lived token for a sync connection | Before opening a socket |
| Sync server | WSS | The document sync itself | While a shared note is open, and while catching up |
| Identity provider | HTTPS | The sign-in page itself | Only while you are signing in that way |
| `obsidian://` callback | Obsidian URL scheme | Receiving the sign-in redirect | During sign-in only |

The identity provider row is worth being precise about. Knap Sync never contacts
an identity provider on its own account. It opens the sign-in page Knap sent it
to, and catches the redirect coming back. Sign in with email and password and no
third party is involved at all.

**No telemetry.** The plugin does not phone home, count anything, or send your
notes anywhere except to Knap.

---

## Where this comes from

Knap Sync is a fork of
[EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin),
which is itself derived from [Relay](https://github.com/No-Instructions/Relay)
by No Instructions, LLC. Both are MIT licensed and both copyright lines are
carried in [LICENSE](LICENSE), with the full attribution in [NOTICE](NOTICE).

The fork exists for two things upstream does not do: vault-wide scope as a first
class option, and a sign-in that survives an identity provider matching redirect
URIs exactly, which is why the callback arrives over `obsidian://` instead of a
loopback port. Upstream serves anybody running their own server, which this fork
no longer does: it talks to Knap and nothing else.

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

## Support

- [Report a bug](https://github.com/pantalytics/knap-obsidian/issues/new?template=bug-report.yml)
- [Request a feature](https://github.com/pantalytics/knap-obsidian/issues/new?template=feature-request.yml)

## License

MIT. Copyright (c) 2024 No Instructions, LLC, (c) 2024-2026 Entire VC,
(c) 2026 Pantalytics. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
