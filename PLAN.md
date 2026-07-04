# Frogtato — Implementation Plan

> **Status: completed.** All tasks T1–T12 shipped in v0.1.0 (T2, T8, T10 and
> T12 were split into sub-tasks in execution); Phase 2's P1–P6 (defined in
> `DESIGN-PHASE2.md` §7) shipped in v0.2.0. Kept as the record of the
> agent-orchestration approach: contract-first ordering, strict file
> ownership, and machine-verifiable acceptance via the check scripts.

Companion to `DESIGN.md`. The work is cut into **12 tasks (T1–T12)**, each sized to be
completed by a single Sonnet agent in one context: a clear goal, a bounded file set,
explicit acceptance criteria, and no design decisions left open (those live in
DESIGN.md — agents implement, they don't redesign).

---

## How to run these tasks (orchestrator notes)

- **Every agent prompt must include:** "Read `DESIGN.md` and `PLAN.md` (your task
  card) first. `shared/src/constants.ts` and `shared/src/messages.ts` are the source
  of truth for all balance numbers and protocol shapes — never hardcode a number or
  message shape locally, never modify `shared/` unless your task card says you own it."
- **File ownership:** each task card lists the files it creates/edits. Tasks scheduled
  in parallel never share files; if an agent believes it must touch a file outside its
  list, it should stop and report instead.
- **Definition of done (all tasks):** `npm run typecheck` and `npm run build` pass at
  the repo root, plus the task's own acceptance checks. Agents must run these, not
  assume them.
- **Stubs policy:** where a task depends on a later system (e.g. server sim exists
  before the client renders it), the earlier task exposes the interface from
  `shared/` types; no task invents temporary protocol shapes.
- Tasks marked **[verify]** include a scripted end-to-end check the agent must run
  (headless ws client scripts under `scripts/` — Phaser rendering itself is verified
  by a human playtest at each phase gate).

### Dependency graph

```
T1 ── T2 ──┬── T3 ──┬── T5 ── T6 ──┬── T8 ── T9 ──┬── T11
           │        │              │              │
           └── T4 ──┴──── T7 ──────┴───── T10 ────┴── T12
```

| Phase | Tasks | Parallelizable? |
|---|---|---|
| 0 Foundation | T1 → T2 | strictly sequential |
| 1 Walking skeleton (M1) | T3 ∥ T4 | yes (server vs client dirs) |
| 2 Combat (M2) | T5 → T6, T7 | T7 ∥ (T5→T6) |
| 3 Full loop (M3) | T8 → T9, T10 | T10 ∥ (T8→T9) |
| 4 Polish (M4) | T11 ∥ T12 | yes |

**Phase gates:** after each phase, a human (or the orchestrator) runs the game
(`npm run dev`, two browser tabs) and confirms the phase's playable outcome before
starting the next phase. Balance tuning happens at gates, only by editing
`shared/src/constants.ts`.

---

## Phase 0 — Foundation

### T1 — Monorepo scaffold
**Depends on:** nothing **Owns:** repo root, empty package skeletons

Create the npm-workspaces monorepo exactly as DESIGN §9:

- Root `package.json` (workspaces: `shared`, `server`, `client`), root scripts:
  `dev` (concurrently: server tsx watch + client vite), `build`, `typecheck`
  (tsc -b all packages).
- `shared/`: plain TS package (no bundler), `src/index.ts` placeholder export.
- `server/`: TS + `ws` + `tsx` for dev; `src/index.ts` starts an HTTP+ws server on
  `:8080`, logs connections, echoes nothing yet.
- `client/`: Vite + TS + Phaser 3; `src/main.ts` boots Phaser with a single empty
  scene showing the text "Frogtato" on a dark background; opens a ws connection to
  `ws://localhost:8080` and logs `open`.
- Strict TS everywhere; `shared` consumed via workspace dependency + TS project
  references (client and server import `@frogtato/shared`).
- `.gitignore`, `README.md` with the three commands.

**Accept:** `npm install && npm run typecheck && npm run build` pass; `npm run dev`
serves the client, browser console logs ws `open`, server logs the connection.

### T2 — Shared contracts: constants + protocol
**Depends on:** T1 **Owns:** `shared/src/**`

Transcribe DESIGN into code. This task writes **no logic**, only data and types:

- `constants.ts`: every table in DESIGN §3–§7 — frog stats, weapon defs (3 types × 3
  levels: damage, cooldown, range/radius, projectile speed), enemy defs, wave table
  (durations, spawn mix weights, spawn intervals), scaling formulas as named functions
  (`enemyHpMultiplier(wave)`, `enemyCap(wave, playerCount)`, `playerFactor(n)`), shop
  catalog (offer ids, base prices, price increments, caps), arena dims (1600×1200
  ellipse), tick rates (SIM_HZ=30, SNAPSHOT_HZ=20, INTERP_DELAY_MS=100), player colors.
- `messages.ts`: discriminated unions `ClientMsg` (`input`, `buy`, `ready`, `start`,
  `hello {token?}`) and `ServerMsg` (`welcome {playerId, token, phase}`, `snapshot`,
  `event`), with `Snapshot` (players, enemies, projectiles, flies — id/x/y/hp/kind
  fields) and `GameEvent` union exactly per DESIGN §9. Include `seq` on input,
  server `tick` on snapshot.
- `ids.ts`: entity-id and offer-id helpers.

**Accept:** typecheck passes; a unit test (`vitest` in shared) asserts the scaling
functions return the DESIGN example values (e.g. `enemyCap(5, 1) === 28`,
`playerFactor(4) === 2.8`).

---

## Phase 1 — Walking skeleton (M1)

*T3 and T4 run in parallel; the protocol frozen in T2 is their contract.*

### T3 — Server core: connections, sim loop, movement **[verify]**
**Depends on:** T2 **Owns:** `server/src/**`, `scripts/skeleton-check.mjs`

- Connection lifecycle: `hello` → assign playerId + color + reconnect token → `welcome`;
  track players in a single `Room` (one per process, per DESIGN §8); despawn on close
  (reconnect grace is T11, not now).
- Fixed 30 Hz sim loop (accumulator over `setInterval`, no drift): apply each player's
  latest input, integrate movement (base speed, normalized diagonals), clamp to the
  arena ellipse.
- Broadcast full JSON `snapshot` every 3rd tick to all clients.
- Structure for growth: `room.ts`, `sim/players.ts`, `net.ts` — but **no** enemies,
  weapons, waves, or phases yet. Room phase is hardcoded `"wave"` so frogs can move.

**Accept:** `scripts/skeleton-check.mjs` (written by this task): connects two ws
clients, sends `hello` + opposing `input` messages for 2 s, asserts both receive
snapshots at ~20/s containing two players whose x-positions diverge, and that a
client sending malformed JSON is dropped without crashing the loop.

### T4 — Client core: scenes, input, interpolated rendering
**Depends on:** T2 **Owns:** `client/src/**`

- `net.ts`: ws wrapper — connect, `hello`, typed send/receive of `ClientMsg`/`ServerMsg`,
  snapshot buffer.
- Scenes: `Boot` (asset stubs) → `Lobby` (connected player list from snapshots +
  Start button sending `start`; until T8 exists server is always in `"wave"`, so Lobby
  auto-skips to Game if phase is `"wave"`) → `Game`.
- `Game` scene: WASD/arrows → `input` msgs at 30/s (and on change, with `seq`); render
  each player as a colored circle-with-eyes placeholder; **interpolation**: render all
  entities at `now − INTERP_DELAY_MS` by lerping between the two bracketing snapshots
  (single utility in `interp.ts`, reused for every entity type later).
- Camera follows own frog, slight zoom-out; arena ellipse drawn as background.

**Accept:** typecheck/build; with T3 running, two browser tabs each show both frogs
moving smoothly (human check at phase gate). Interp utility has a vitest unit test
(given two snapshots, position at t is the lerp).

**Phase 1 gate:** two tabs, two frogs, smooth movement, no gameplay.

---

## Phase 2 — Combat (M2)

### T5 — Server: enemies, damage, deaths, fly economy **[verify]**
**Depends on:** T3 **Owns:** `server/src/sim/enemies.ts`, `sim/combat.ts`, `sim/flies.ts`, edits `room.ts`, `scripts/combat-check.mjs`

- Spawner (interim, replaced in T8): spawn wasps + snail spitters on a fixed interval
  up to a small cap, at arena-edge points ≥250 px from every player.
- Enemy AI per DESIGN §5: wasp chases nearest player, contact damage with 0.5 s
  per-wasp cooldown; snail keeps ~300 px distance and fires acid-glob projectiles.
- Server projectiles (acid globs now; bubbles reuse this in T6): move, circle-collide,
  despawn on hit/out-of-bounds.
- Player HP, damage intake, `playerDowned` event at 0 HP (downed = input ignored,
  invisible flag in snapshot; revive logic is T8's).
- Enemy death → fly drops; fly pickup within pickup radius → per-player fly count
  (in snapshot); `enemyDied` events.

**Accept:** `scripts/combat-check.mjs`: one bot client stands still; asserts its HP
decreases from wasp contact; a second scripted check with a debug ws message
`{type:"debug", kill: enemyId}` (guarded behind `NODE_ENV!=="production"`) asserts a
fly spawns and, after the bot moves onto it, its fly count increments.

### T6 — Server: weapons & auto-targeting **[verify]**
**Depends on:** T5 **Owns:** `server/src/sim/weapons.ts`, edits to `sim/combat.ts`, `scripts/weapons-check.mjs`

- Weapon slots on players (2, per DESIGN §3), starting loadout = Tongue Lash Lv I.
- Per-slot cooldown ticking; on ready: acquire nearest enemy in range, fire per
  archetype — tongue: instant first-enemy-on-line segment test; bubble: projectile
  (reuses T5 projectile system); croak: radius hit on all enemies in range.
- Damage = weapon level damage × (1 + player Damage%); enemy HP/death flows through
  T5's combat path. Attack events in snapshot/events so the client can draw effects
  (`attack {playerId, slot, kind, targetX, targetY}`).
- Level scaling from constants only.

**Accept:** `scripts/weapons-check.mjs`: bot with debug-granted one weapon of each
type (debug msg `{type:"debug", give:{slot, weapon, level}}`) near debug-spawned
enemies; asserts each weapon kind kills within expected time bounds derived from
constants (damage/cooldown), and that croak hits multiple enemies in one fire.

### T7 — Client: combat rendering & feedback
**Depends on:** T4 (parallel with T5→T6) **Owns:** `client/src/render/**`, edits `Game` scene

- Render from snapshot via the T4 interp utility: enemies (wasp/snail placeholder
  sprites with 2-frame wobble), projectiles (acid glob, bubble), flies, per-entity
  HP bars (enemies: only when damaged; players: always + fly count label).
- Event-driven effects: tongue = stretched rectangle tween to target, croak =
  expanding ring, hit flashes, death poof, downed frog = grayed + X eyes.
- Placeholder sounds via jsfxr-style generated blips for: tongue, bubble, croak, hit,
  pickup, downed (asset files in `client/assets/`, loaded in Boot).
- Must handle entity kinds appearing in snapshots **before** this task's server
  counterparts exist in a running build (render only what's present; unknown kinds
  ignored with a console.warn once).

**Accept:** typecheck/build; renders a synthetic recorded snapshot sequence (a small
fixture JSON checked into `client/test/fixtures/`) in a vitest DOM-less test that
just asserts the scene's entity registry matches the fixture (creation/removal logic,
not pixels). Visuals confirmed at phase gate.

**Phase 2 gate:** two tabs; wasps and snails attack, all three weapons (via debug
grant) kill things, flies collect, a frog can go down.

---

## Phase 3 — Full loop (M3)

### T8 — Server: phases, wave director, downed/revive, end states **[verify]**
**Depends on:** T6 **Owns:** `server/src/game/phases.ts`, `game/waves.ts`, edits `room.ts` (removes T5 interim spawner), `scripts/loop-check.mjs`

- Room phase machine per DESIGN §2/§8: `lobby → wave(n) → shop → … → wave(5) →
  victory | gameover → scoreboard(10 s) → lobby`. `start` msg valid only in lobby,
  from any player.
- Wave director per DESIGN §6: per-wave duration, spawn mix, spawn interval ramp,
  concurrent cap & playerFactor scaling, enemy HP multiplier; wave-end despawns
  leftovers (no drops), vacuums uncollected flies to nearest living player.
- Downed/revive per DESIGN §2: downed players spectate; at next wave start revive at
  50% HP; full heal at each wave start; all downed mid-wave → `gameover`.
- Join rules per DESIGN §8: joiners during lobby/shop spawn immediately with default
  loadout; mid-wave joiners spectate until shop. Scoreboard data (kills, damage,
  flies) accumulated per player and sent in `gameOver`/`victory` events.

**Accept:** `scripts/loop-check.mjs` runs an accelerated full game (debug msg
`{type:"debug", timescale: 10}`): asserts phase-event sequence lobby→wave1→shop→…→
wave5→victory for an invincible debug bot, and a separate run where the bot takes
damage normally asserts a `gameOver` path ends back in lobby.

### T9 — Server: shop **[verify]**
**Depends on:** T8 **Owns:** `server/src/game/shop.ts`, `scripts/shop-check.mjs`

- Fixed catalog from constants (DESIGN §7): weapon purchases (require empty slot),
  per-slot upgrades (level gating, II/III prices), repeatable stat buys with
  escalating per-player prices and the move-speed cap.
- Validate every `buy` server-side (phase = shop, funds, slot rules); respond with
  `purchaseResult` (success + new state, or typed error reason); deduct flies.
- `ready` handling: shop ends at 30 s or when all living players ready.

**Accept:** `scripts/shop-check.mjs`: drives a bot to shop phase (timescale), then
asserts: successful weapon buy into empty slot; rejection on full slots; rejection on
insufficient flies; stat price escalation across two buys; move-speed cap enforced;
all-ready ends the shop early.

### T10 — Client: HUD, shop UI, lobby & end screens
**Depends on:** T7 (parallel with T8→T9) **Owns:** `client/src/ui/**`, `Shop`/`GameOver` scenes, edits `Lobby`/`Game`

- HUD in Game: wave number + countdown, own HP bar, fly count, weapon slot icons with
  cooldown sweep, ally edge-of-screen arrows (basic version here, polish in T11).
- Real Lobby: player list with colors, Start button, "waiting for players" state.
- Shop scene (phase-driven): catalog grid with prices/affordability, own stats panel,
  weapon slots with upgrade buttons, Ready button + who's-ready indicators, 30 s timer.
  Sends `buy`/`ready`; renders `purchaseResult` errors as toasts.
- Victory/GameOver scene: per-player scoreboard from the end event, auto-return on the
  server's `phase` change back to lobby.
- Phase transitions purely event/snapshot-driven — the client never assumes a phase.

**Accept:** typecheck/build; scene-registry vitest as in T7 for the shop catalog
rendering (offers×affordability from a fixture snapshot). Full UX confirmed at gate.

**Phase 3 gate — the game is complete:** full 5-wave co-op run, shop between waves,
downs/revives, wipe and victory both reachable. Balance pass by editing constants.

---

## Phase 4 — Polish (M4)

### T11 — Reconnect, robustness, feel
**Depends on:** T9 **Owns:** `server/src/net.ts` reconnect parts, `client/src/net.ts` retry parts, small edits both sides

- Reconnect per DESIGN §8: server keeps disconnected player state 2 min keyed by
  token; client stores token in `localStorage`, auto-reconnects with backoff and
  resumes seamlessly; joining a full room (4) or mid-wave → spectator messaging.
- Server hardening: per-connection message-rate cap, ignore inputs from
  downed/spectating players, snapshot only what changed phase-appropriately (lobby
  needs no enemy array).
- Feel: camera lerp smoothing, hit-pause-free but with slight screen shake on own
  damage, fly magnet animation.

**Accept:** extend `skeleton-check.mjs`: disconnect a bot mid-run, reconnect with the
same token within grace, assert restored weapons/flies. Typecheck/build.

### T12 — Art & audio pass
**Depends on:** T10 (parallel with T11) **Owns:** `client/assets/**`, sprite-loading edits in `Boot` + render modules only

- Replace placeholders per DESIGN §10: frog sprite (48 px, tintable), wasp, snail,
  tongue/bubble/croak effects, lily-pad decorations scattered on the pond, fly pickup
  sprite. Flat-color style; SVG-authored → PNG or hand-drawn, committed to repo.
- Background music loop + the 6 SFX from real free assets (Kenney or generated),
  with attribution file `client/assets/CREDITS.md`; volume toggle in HUD.

**Accept:** typecheck/build; all assets load with no 404s (Boot scene logs a loaded
manifest); no gameplay/network code touched.

---

## Sizing & risk notes

- **Biggest-risk-first:** T3+T4 prove the entire netcode approach in phase 1; every
  later task is additive gameplay on a working pipe.
- **Largest tasks** are T8 and T10 (~500–700 LOC each). If an agent reports T8 is too
  big, split at the pre-marked seam: T8a phase machine + join/downed rules, T8b wave
  director. T10's seam: T10a HUD+lobby+end screens, T10b shop scene.
- **The debug ws message** (`{type:"debug", ...}`, dev-only) introduced in T5 and
  reused in T6/T8/T9 is what makes the whole plan machine-verifiable — keep it working.
- Total: 12 tasks, max parallel width 2, critical path T1→T2→T3→T5→T6→T8→T9→T11
  (8 tasks).
