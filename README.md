# NEXUS CLUSTER

Local-first multi-server chat cluster by [@Pranjal240](https://github.com/Pranjal240).

This project runs multiple localhost chat servers (3 or 4) that are separate by port but linked together in real time. If one user sends a message on one server, that message appears on the others.

## Repository

- GitHub: https://github.com/Pranjal240/NEXUS-CLUSTER

## What Works Right Now

- Multi-server cluster mode on localhost
- Choose 3 or 4 linked servers
- Real-time cross-server message sync (Socket.IO cluster adapter)
- Local SQLite message persistence (`chat.db`)
- Chat history replay on reconnect
- Clear chat for all connected clients
- Busy-port detection with clear startup errors

## Offline Mode

- Works without internet in localhost mode
- No cloud database required
- Data remains on your machine (`chat.db`)

## Planned Features (Roadmap)

These features are planned and not fully implemented yet:

- Beacon Link auto-discovery layer (Bluetooth / Wi-Fi / LAN fallback)
- Peer-to-peer device bridge beyond localhost
- End-to-end encrypted rooms
- File transfer in chat
- Push notifications
- Mobile companion app

## Requirements

- Node.js 18+ (recommended latest LTS)
- npm 9+
- Windows, macOS, or Linux

## Installation

1. Clone the repository

```bash
git clone https://github.com/Pranjal240/NEXUS-CLUSTER.git
cd NEXUS-CLUSTER
```

2. Install dependencies

```bash
npm install
```

3. Start the app

```bash
npm run dev:3   # 3 linked localhost servers
# or
npm run dev:4   # 4 linked localhost servers
# or
npm run dev     # default
```

4. Open in browser

- http://localhost:3000
- http://localhost:3001
- http://localhost:3002
- http://localhost:3003 (only in 4-server mode)

## Scripts

- `npm run dev` -> start default mode
- `npm run dev:3` -> start 3 linked servers
- `npm run dev:4` -> start 4 linked servers
- `npm start` -> production-style start

## Environment Variables

- `WORKERS` -> allowed values: `3` or `4`
- `BASE_PORT` -> base cluster port (default `3000`)
- `AUTO_OPEN=false` -> disable auto-open browser

## Troubleshooting

### EADDRINUSE

If you see `EADDRINUSE`, ports are already occupied by another running instance.

Fix:

1. Stop old app terminal (`Ctrl + C`).
2. Start again with `npm start` or `npm run dev:3` / `npm run dev:4`.

### Database Notes

- Main DB file: `chat.db`
- Runtime temp files: `chat.db-shm`, `chat.db-wal`
