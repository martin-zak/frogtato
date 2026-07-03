# Frogtato

Co-op browser Brotato clone (frog edition). See `DESIGN.md` for the full design and
`PLAN.md` for the implementation task breakdown.

This is an npm-workspaces monorepo with three packages:

- `shared/` — TypeScript types & constants shared by client and server (`@frogtato/shared`)
- `server/` — Node.js + `ws` authoritative game server
- `client/` — Phaser 3 + Vite browser client

## Setup

```
npm install
```

## Commands (run from the repo root)

- `npm run dev` — runs the server (`tsx watch`) and the client (`vite`) together.
  Server listens on `ws://localhost:8080`; client dev server prints its own URL
  (typically `http://localhost:5173`).
- `npm run build` — builds all workspaces (`shared`, `server`, `client`).
- `npm run typecheck` — type-checks all workspaces via `tsc -b` (TypeScript project
  references).
