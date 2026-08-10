# Knap Sync

**Sync your vault to a relay you run yourself.** A whole vault or one folder at
a time, on desktop and on phone, with real-time collaborative editing on
whatever you share.

Knap Sync keeps your notes as plain markdown in your vault. The relay holds a
CRDT copy so two people can edit the same note without a merge conflict, and so
a device that was offline catches up when it reconnects.

---

## What it does

- **Sync a whole vault, or pick folders.** Scope is set per server: point it at
  everything, or share `Projects/` and leave the rest of the vault alone.
- **Two people, one note.** Edits merge as you type. No conflict copies, no
  last-writer-wins.
- **Offline is normal.** Edit on a plane, reconnect, and the relay catches up.
- **Attachments travel with the notes.** Images and PDFs sync alongside the
  markdown.
- **Phone included.** `isDesktopOnly` is false, sign-in comes back over an
  `obsidian://` link rather than a local port, so iOS and Android work the same
  way the laptop does.

Knap Sync is also the Obsidian half of [Knap](https://github.com/pantalytics),
where the same vault is reachable by an AI assistant over MCP. You do not need
any of that to use the plugin: point it at a relay, and it syncs.

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

## Connect

1. *Settings → Knap Sync → Relay Servers.* One server is configured out of the
   box, at `https://cp.knap.pantalytics.com`. If you run your own relay, use
   **Add Server** and give it your control plane URL. Leave the other two fields
   empty and they are worked out for you.
2. **No trailing slash on the control plane URL.** A slash on the end turns the
   health check into a 404 that reads as *Connection failed*.
3. Tick **Default** on the server you actually use. Online and offline detection
   follows the default server, so a default pointing somewhere else makes the
   connection light meaningless.
4. Press **Login** on the server card. Email and password, or one of the sign-in
   buttons if your relay offers them.

Then share a folder, or set the scope to the whole vault, and the first sync
starts.

---

## Network use

Knap Sync talks to the servers configured in its settings and to nothing else.

| Connection | Protocol | What for | When |
|---|---|---|---|
| Control plane | HTTPS | Sign-in, token refresh, listing and creating shares, inviting people | On login and on share operations |
| Control plane | HTTPS | Issuing the short-lived token for a relay connection | Before opening a socket |
| Relay server | WSS | The document sync itself | While a shared note is open, and while catching up |
| `obsidian://` callback | Obsidian URL scheme | Receiving the OAuth redirect, where the relay offers OAuth | During sign-in only |

**No telemetry.** The plugin does not phone home, count anything, or send your
notes anywhere except the relay you pointed it at. The default server above is a
default, not a requirement: remove it and the plugin has nowhere to talk to.

---

## Where this comes from

Knap Sync is a fork of
[EVC Team Relay](https://github.com/entire-vc/evc-team-relay-obsidian-plugin),
which is itself derived from [Relay](https://github.com/No-Instructions/Relay)
by No Instructions, LLC. Both are MIT licensed and both copyright lines are
carried in [LICENSE](LICENSE), with the full attribution in [NOTICE](NOTICE).

The fork exists for two things upstream does not do: vault-wide scope as a first
class option, and a sign-in that survives an identity provider matching redirect
URIs exactly, which is why the OAuth callback arrives over `obsidian://` instead
of a loopback port. It speaks the same protocol as an EVC Team Relay server, so
it works against one.

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
