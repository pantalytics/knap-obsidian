# EVC Team Relay

[![GitHub release](https://img.shields.io/github/v/release/entire-vc/evc-team-relay-obsidian-plugin?style=flat-square)](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

> **[Download Latest Release](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/releases/latest)** | [Changelog](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/releases)

Enterprise **multiplayer mode** for Obsidian with self-hosted infrastructure.

-   **Collaborate in real time** with live cursors.
-   **Edit offline** and sync seamlessly when you're back on.
-   **Share folders** and manage access to updates.
-   **Self-hosted** relay infrastructure for enterprise security.
-   **On-premise deployment** with complete data control.
-   **Multi-server support** for distributed teams.

EVC Team Relay is an enterprise-grade collaborative editing plugin for Obsidian. It uses CRDTs to enable snappy, local-first, real-time and asynchronous collaboration with your own self-hosted relay infrastructure.

Originally based on [System 3 Relay](https://system3.md/), enhanced with enterprise features and on-premise deployment capabilities.

## Key Features

### Relay On-Premise Mode
- **Self-hosted control plane** - Deploy your own authentication and authorization server
- **Email/password authentication** - Enterprise-grade login instead of OAuth
- **Custom relay servers** - Run your own y-sweet relay infrastructure
- **Data sovereignty** - Keep all collaboration data within your infrastructure
- **Enterprise security** - Full control over access, encryption, and compliance

### Multi-Server Support (v1.1)
- **Multiple relay servers** - Connect to several evc-team-relay instances simultaneously
- **Per-server authentication** - Separate login for each server
- **Server auto-detection** - Automatic configuration via `/server/info` endpoint
- **Default server setting** - Set preferred server for new shares
- **Server-bound shares** - Each share linked to its specific server

### Context Menu Integration
- **Quick share** - Right-click folder → "EVC Relay: Share folder"
- **Quick unshare** - Right-click shared folder → "EVC Relay: Unshare folder"
- **Seamless workflow** - Manage shares without leaving the file explorer

### User Experience
- **Folder browser** - Browse button for folder selection
- **Folder suggestions** - Autocomplete when typing folder paths
- **Email-based invites** - Add team members by email address
- **Settings persistence** - Settings survive plugin disable/enable cycles
- **Auth persistence** - Stay logged in across sessions

### System 3 Cloud Mode (Legacy)
- **OAuth2 authentication** - Quick setup with Google/GitHub
- **Managed infrastructure** - System 3 hosts relay servers
- **Quick start** - No infrastructure setup required

## How does Relay work?

In a nutshell, Relay:

1. **Tracks updates to designated folders**. The plugin uses conflict-free replicated data types (CRDTs) to track updates to folders that you designate within your vault.
2. **Relays updates.** It sends those updates up to Relay servers, which then echo the updates out to all collaborators on the relay.
3. **Integrates updates.** Your collaborator receives the updates and integrates them seamlessly as they come in.

### What's a CRDT?

Great question. CRDT stands for **conflict-free replicated data type** and it's a technology that's critical to making local-first real-time collaboration work.

> The fundamental idea is this: You have data. This data is stored on multiple replicas. CRDTs describe how to coordinate these replicas to always arrive at a consistent state.

For more information about CRDTs, check out [Yjs](https://docs.yjs.dev/), the open source CRDT library used in EVC Team Relay.

## Getting Started

### Option 1: Relay On-Premise (Recommended for Enterprises)

1. **Deploy evc-team-relay control plane**
   - Follow the [evc-team-relay deployment guide](https://github.com/entire-vc/evc-team-relay)
   - Set up your control plane server (v1.1+ recommended)
   - Deploy y-sweet relay servers

2. **Add a server in the plugin**
   - Open Obsidian settings → "EVC Team Relay"
   - Click "Add Server"
   - Enter your control plane URL (e.g., `https://relay.yourcompany.com`)
   - Server name and relay URL auto-detected from v1.1 servers

3. **Login**
   - Click "Login" on the server card
   - Enter your email and password
   - Start collaborating!

4. **Share a folder**
   - Right-click a folder → "EVC Relay: Share folder"
   - Or use the Relay panel in settings
   - Add team members by email

### Option 2: System 3 Cloud Mode (Legacy)

1. Go to Obsidian settings (gear icon in lower left)
2. Go to Relay settings (on the left, at the bottom)
3. Login with OAuth2 (Google/GitHub)
4. Create new relay
5. Add shared folder(s) to the relay

## Architecture

### Relay On-Premise Mode

```
┌─────────────┐      ┌──────────────────┐      ┌──────────────┐
│   Obsidian  │◄────►│  Control Plane   │◄────►│  Relay Server│
│   Plugin    │      │  (Authentication)│      │  (y-sweet)   │
└─────────────┘      └──────────────────┘      └──────────────┘
                              │
                              ▼
                      ┌──────────────┐
                      │  PostgreSQL  │
                      └──────────────┘
```

### Multi-Server Architecture

```
                    ┌──────────────────┐      ┌──────────────┐
               ┌───►│ Control Plane A  │◄────►│ Relay A      │
               │    └──────────────────┘      └──────────────┘
┌─────────────┐│
│   Obsidian  ├┤    ┌──────────────────┐      ┌──────────────┐
│   Plugin    ├┼───►│ Control Plane B  │◄────►│ Relay B      │
└─────────────┘│    └──────────────────┘      └──────────────┘
               │
               │    ┌──────────────────┐      ┌──────────────┐
               └───►│ Control Plane C  │◄────►│ Relay C      │
                    └──────────────────┘      └──────────────┘
```

### Components

- **Obsidian Plugin** - This plugin, runs in Obsidian
- **Control Plane** - FastAPI server handling authentication and share management
- **Relay Server** - y-sweet server for CRDT synchronization
- **PostgreSQL** - Database for users, shares, and audit logs

## Development

### Building

```bash
npm install
npm run build
```

### Development Mode

```bash
npm run dev
```

This will watch for changes and rebuild automatically.

### Testing

```bash
npm test
```

## Configuration

### Multi-Server Settings

The plugin stores server configurations in settings:

```json
{
  "servers": [
    {
      "id": "server-uuid",
      "name": "Production Server",
      "controlPlaneUrl": "https://relay.yourcompany.com",
      "relayServerUrl": "wss://relay-ws.yourcompany.com",
      "isDefault": true
    },
    {
      "id": "another-uuid",
      "name": "Development Server",
      "controlPlaneUrl": "https://relay-dev.yourcompany.com",
      "relayServerUrl": "wss://relay-ws-dev.yourcompany.com",
      "isDefault": false
    }
  ]
}
```

### Server Info Endpoint (v1.1)

Control plane v1.1+ provides auto-configuration via:

```
GET /server/info
```

Response:
```json
{
  "name": "My Relay Server",
  "version": "1.1.0",
  "relay_url": "wss://relay-ws.yourcompany.com"
}
```

## API Integration

### Authentication Endpoints

- `POST /api/auth/login` - Email/password login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

### Share Management Endpoints

- `GET /api/shares` - List user's shares
- `POST /api/shares` - Create new share
- `PATCH /api/shares/{id}` - Update share
- `DELETE /api/shares/{id}` - Delete share
- `POST /api/shares/{id}/members` - Add member by email
- `DELETE /api/shares/{id}/members/{user_id}` - Remove member

### Token Endpoints

- `POST /api/tokens/relay` - Request relay access token

### Server Info Endpoint (v1.1)

- `GET /server/info` - Get server name and relay URL

## Security

### Relay On-Premise
- **JWT Authentication** - HS256 for access tokens, Ed25519 for relay tokens
- **Token Expiration** - Configurable token lifetimes
- **Audit Logging** - Comprehensive audit trail of all operations
- **HTTPS Required** - Enforce encrypted connections in production
- **Data Sovereignty** - All data stays within your infrastructure
- **Per-Server Auth** - Separate credentials per server instance

### System 3 Cloud
- **OAuth2** - Secure authentication with trusted providers
- **Encrypted Transit** - TLS for all communications
- **Managed Security** - System 3 handles infrastructure security

## Troubleshooting

### Connection Issues

1. **Check control plane URL** - Ensure it's accessible from your network
2. **Verify relay server URL** - Test WebSocket connectivity
3. **Check authentication** - Ensure valid credentials
4. **Review logs** - Check Obsidian console for errors

### Multi-Server Issues

1. **Server not appearing** - Check control plane URL is correct
2. **Auto-detection failed** - Server may be pre-v1.1, enter details manually
3. **Wrong server for share** - Check default server setting

### Authentication Errors

1. **Token expired** - Re-login to refresh
2. **Invalid credentials** - Verify email/password
3. **Control plane down** - Check server status

### Sync Issues

1. **Network connectivity** - Ensure relay server is reachable
2. **Token expiration** - Tokens are refreshed automatically
3. **Conflict resolution** - CRDTs handle conflicts automatically

## Contributing

This is a fork of System 3 Relay enhanced for enterprise use. Contributions welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - See LICENSE file for details

## Credits

- Original [System 3 Relay](https://system3.md/) by Daniel Grossmann-Kavanagh
- Enhanced for enterprise by EVC Team
- Built on [Yjs](https://docs.yjs.dev/) CRDT library
- Uses [y-sweet](https://github.com/drifting-in-space/y-sweet) relay server

## Support

For issues and questions:
- GitHub Issues: [Report a bug](https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues)
- Documentation: [evc-team-relay docs](https://github.com/entire-vc/evc-team-relay)

---

**EVC Team Relay** - Enterprise collaboration for Obsidian
