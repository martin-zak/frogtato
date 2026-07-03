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
- `npm run test -w shared` / `-w client` — unit tests (vitest).
- `npm run check:skeleton | check:combat | check:weapons | check:loop | check:shop`
  — headless end-to-end checks driving bot clients against a live server.
  `loop`/`shop` spawn their own server; the other three expect one running
  (set `FROGTATO_PORT` to target a non-default port, `PORT` for the server).

## How to play

1. `npm run dev` on the host machine.
2. Every player opens `http://<host-ip>:5173` (the dev server listens on the LAN).
   Up to 4 players; everyone lands in the lobby, anyone can press **Start**.
3. Move with **WASD** or arrow keys — your weapons aim and fire automatically.
4. Survive 5 timed waves. Enemies drop flies; between waves, spend them in the
   shop on weapons (Tongue Lash / Bubble Blaster / Croak Nova), upgrades, and
   stats. Downed frogs revive when the next wave starts — if everyone goes
   down at once, the run ends.
5. Speaker icon (top right) toggles sound. Refreshing the page mid-run
   reconnects you with your build intact (2-minute grace).

Balance lives in `shared/src/constants.ts` — every number in one file.

Next phase (classes, new stats, weapon merging, a boss): `DESIGN-PHASE2.md`.
