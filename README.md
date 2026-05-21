# EVC Team Relay Plugin


**Real-time collaboration and web publishing for Obsidian.**

> Edit notes together. Share folders with your team. Publish to the web. Self-hosted or hosted — your choice.

---

## The Problem

You love Obsidian, but your team needs more:
- **Sharing a note** means exporting, copy/pasting, or screenshotting
- **Collaborating** means switching to Notion or Google Docs
- **Publishing** means paying $8/month for Obsidian Publish with limited control
- **Git sync** works until two people edit the same file

## The Solution

**EVC Team Relay** adds multiplayer mode to Obsidian. CRDT-based real-time sync — no merge conflicts, works offline, your data stays on your server (or ours).

---

## What You Get

### 🔄 Real-time Collaboration
- Edit the same note simultaneously — changes merge automatically
- Share entire folders with viewer or editor permissions
- Works offline — edits sync when you reconnect

### 🌐 Web Publishing
- Publish notes as a website with one click
- Three modes: **public**, **protected** (link + token), **private** (login required)
- Custom domains supported
- Perfect for: internal wikis, client portals, project docs, personal sites
- [Live example →](https://docs.entire.vc/team-relay/Demo)

### 🔒 Your Data, Your Server
- **Self-hosted:** deploy on your VPS with Docker Compose ([server repo](https://github.com/entire-vc/evc-team-relay))
- **Hosted:** zero ops, connect and go ([entire.vc](https://entire.vc))

---

## Install

1. *Settings → Community plugins → Browse* → search **"EVC Team Relay"**
2. **Install**, then **Enable**

Or open directly: `obsidian://show-plugin?id=evc-team-relay`  
Plugin page: https://obsidian.md/plugins?id=evc-team-relay

<details>
<summary>Manual install</summary>

1. Download from [latest release](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/releases)
2. Copy to `.obsidian/plugins/evc-team-relay/`
3. Enable in Settings

</details>

---

## Quickstart

1. **Connect:** Plugin settings → Add server → enter your relay URL (or sign up at [entire.vc](https://entire.vc))
2. **Share:** Right-click a folder → Share → invite by email
3. **Collaborate:** Open a shared note — edits sync in real-time
4. **Publish:** Right-click a note or folder → Publish to web

---

## Who Is This For?

### Small Teams (5-20 people)
Replace Notion/Confluence. Keep Obsidian. Real-time collaboration without $8/user/month.

### Consultants & Freelancers
Share deliverables with clients via protected web publish. No "can you export that as PDF?"

### Dev Teams
Documentation that lives in Obsidian, accessible to the whole team. Pair with [Local Sync](https://github.com/entire-vc/evc-local-sync-plugin) for repo `/docs` ↔ vault sync.

### Content Creators
Publish your vault as a beautiful website. Better than Obsidian Publish — custom domains, access control, flat pricing.

---

## Comparison

| | Obsidian Sync | Notion | Google Docs | **Team Relay** |
|---|---|---|---|---|
| Real-time collab | ✗ | ✅ | ✅ | ✅ |
| Works in Obsidian | ✅ | ✗ | ✗ | ✅ |
| Web publish | via Publish | ✅ | ✅ | ✅ |
| Self-hosted option | ✗ | ✗ | ✗ | ✅ |
| Offline editing | ✅ | ✗ | ✗ | ✅ |
| Your data, your server | ✗ | ✗ | ✗ | ✅ |

---

## Feedback

- [Report a bug →](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=bug-report.yml)
- [Request a feature →](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=feature-request.yml)
- [Report a web publish issue →](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=web-publish.yml)

---

## Solo Workflow? No Server Needed

→ [**EVC Local Sync**](https://github.com/entire-vc/evc-local-sync-plugin) — bidirectional vault ↔ local folder sync for AI-assisted coding workflows.

---



## Network Usage

This plugin makes network requests to **user-configured servers only**. No data is sent to third parties.

| Connection | Protocol | Purpose | When |
|------------|----------|---------|------|
| Control plane server | HTTPS | Authentication (login, token refresh), share management (list, create, invite), server info, billing | On login, share operations, periodic token refresh |
| Relay server | WebSocket (WSS) | Real-time CRDT document synchronization between collaborators | While editing shared documents |
| Control plane server | HTTPS | Relay token issuance (Ed25519-signed) | Before opening a WebSocket connection |
| OAuth callback (localhost) | HTTP | Receives OAuth redirect on `127.0.0.1` (desktop only) | During OAuth login flow |

**All server URLs are configured by the user** in plugin settings. The default configuration includes `https://cp.tr.entire.vc` (EVC Team Relay hosted), but the user can add, remove, or change servers.

**No telemetry or analytics data is collected.** The plugin does not phone home, track usage, or send any data to third-party services.

## Community

- 🌐 [entire.vc](https://entire.vc)
- 💬 [Discussions](https://github.com/entire-vc/.github/discussions)
- 📧 in@entire.vc

## License

MIT — Copyright (c) 2026 Entire VC
