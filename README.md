# Synced Vaults

**Your vault on Knap, on every device you use.** A whole vault or one folder at
a time, on desktop and on phone, with real-time collaborative editing on
whatever syncs.

Synced Vaults keeps your notes as plain markdown in your vault. Knap holds a CRDT
copy, so two people can edit the same note without a merge conflict and a device
that was offline catches up when it reconnects.

---

## What it does

- **The whole vault, and nothing to pick.** Sign in and everything syncs.
  Making a folder makes it everywhere, moving it moves it everywhere, deleting
  it deletes it everywhere, the way any other sync behaves.
- **Two people, one note.** Edits merge as you type. No conflict copies, no
  last-writer-wins.
- **Offline is normal.** Edit on a plane, reconnect, and Knap catches up.
- **Attachments travel with the notes.** Images and PDFs sync alongside the
  markdown.
- **Phone included.** `isDesktopOnly` is false, sign-in comes back over an
  `obsidian://` link rather than a local port, so iOS and Android work the same
  way the laptop does.

Synced Vaults is the Obsidian half of [Knap](https://github.com/pantalytics), where
the same vault is reachable by an AI assistant over MCP. You do not need to use
that half: sign in, and the plugin syncs.

---

## Install

Synced Vaults is not in the community catalog yet. Two ways to install it today.

### BRAT

[BRAT](https://obsidian.md/plugins?id=obsidian42-brat) installs plugins straight
from GitHub and keeps them updated.

1. Install and enable **BRAT** from *Settings → Community plugins → Browse*
2. *Settings → BRAT → Add beta plugin*
3. Paste `pantalytics/knap-obsidian`, pick the latest version, **Add plugin**
4. Enable **Synced Vaults** in *Settings → Community plugins*

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/pantalytics/knap-obsidian/releases/latest)
2. Put all three in `<your vault>/.obsidian/plugins/synced-vaults/`
3. Reload Obsidian and enable **Synced Vaults**

### Coming from Knap Sync

The plugin was called Knap Sync up to 1.4.0, and Obsidian keys a plugin by its
identifier rather than its name, so 1.5.0 installs beside the old one instead of
replacing it. Delete `.obsidian/plugins/knap-sync/` once the new one is enabled,
or two copies will sync the same vault against each other. On BRAT, remove the
beta plugin first and add `pantalytics/knap-obsidian` again.

You stay signed in. What does not carry over is the offline copy each synced
folder keeps, so every folder downloads itself again on first run. Let a device
finish syncing before you upgrade it, or anything still waiting to upload goes
with the old copy.

---

## Sign in

*Settings → Synced Vaults → Sign in.* A browser opens, you sign in with your Knap
account, and Obsidian picks it up from there. There is no address to type and no
code to paste, on a laptop or on a phone.

That button is the only way in. There is nothing else to try and nothing behind
it to choose.

The whole vault starts syncing on its own. To sync some folders instead, pick
them in the same tab; it is one or the other, never a mixture.

The plugin talks to Knap and nothing else, so there is no address to configure.
If you want to run your own, [EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin)
is the plugin for it, and this one is a fork of it.

---

## What it costs

The plugin is free and MIT licensed. Nothing to buy in it, and no licence key to
enter. What a Knap account costs is a question for Knap, not for the plugin.

---

## Network use

**A Knap account is required.** Synced Vaults is a client, and with nothing to sign
in to there is nothing for it to sync against.

Synced Vaults talks to Knap, and to an identity provider only while you are signing
in through one.

| Connection | Protocol | What for | When |
|---|---|---|---|
| Control plane | HTTPS | Sign-in, token refresh, listing and adding folders, inviting people | On sign-in, and when a folder changes |
| Control plane | HTTPS | Issuing the short-lived token for a sync connection | Before opening a socket |
| Sync server | WSS | The document sync itself | While a synced note is open, and while catching up |
| Identity provider | HTTPS | The sign-in page itself | Only while you are signing in |
| `obsidian://` callback | Obsidian URL scheme | Receiving the sign-in redirect | During sign-in only |

The identity provider row is worth being precise about. Synced Vaults never contacts
an identity provider on its own account, and it holds no client id and no secret
for one. It opens the sign-in page Knap sent it to, and catches the redirect
coming back.

**No telemetry.** The plugin does not phone home, count anything, or send your
notes anywhere except to Knap.

---

## Where this comes from

Synced Vaults is a fork of
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
