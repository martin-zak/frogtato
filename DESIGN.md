# Frogtato — Design Document

A small, browser-based, co-op Brotato clone where you play a **Frog**.
Version: 0.1 (first playable / demo scope)

> **Status: shipped as v0.1.0.** This document is the design-time spec,
> kept as written. Where the shipped game deliberately diverges (from
> playtesting), `shared/src/constants.ts` is authoritative — notable
> divergences: wasp speed 260→200, enemies get a 0.35s hit-stagger,
> snails are clamped inside the pond, weapon slots 2→3 (v0.2 playtest),
> and fly drops were roughly doubled. Phase 2 additions live in
> `DESIGN-PHASE2.md`.

---

## 1. Concept

- **Genre:** Top-down arena survival ("horde survivor" / Brotato-like).
- **Pitch:** Up to 4 frogs stand in a pond arena, auto-attacking waves of bugs.
  Survive 5 waves together and you win. Eat flies to buy upgrades between waves.
- **Platform:** Web browser (desktop, keyboard + mouse). One shared server, multiple
  players join the same run.
- **Session length:** ~5 minutes per run.
- **Key differentiator:** the character is a Frog, not a Potato. The theme drives
  everything: tongue attacks, bubble projectiles, fly-based currency, pond arena.

### Design pillars
1. **Small enough to actually ship.** Every system below is the minimum version of itself.
2. **Brotato's feel:** move to dodge, weapons fire automatically, waves are timed,
   short shop break between waves.
3. **Co-op first:** all mechanics assume 1–4 players in one shared arena; solo is just
   co-op with one player.

---

## 2. Core Loop

```
Lobby → Wave 1 → Shop → Wave 2 → Shop → ... → Wave 5 → Victory screen
                              (team wipe at any point → Game Over screen)
```

1. **Wave (timed):** enemies spawn continuously; players move (WASD) while their
   weapons auto-target and auto-fire. Enemies drop **Flies** (currency) on death.
2. **Shop (30 s, skippable when all players ready):** each player independently spends
   their Flies on weapon purchases/upgrades or stat boosts.
3. Repeat. Survive the end of wave 5 → win.

**Death & team wipe:** a player who hits 0 HP is downed for the rest of the wave
(spectates). Downed players revive automatically at 50% HP when the next wave starts.
If **all** players are downed during a wave, the run ends.

---

## 3. The Frog (player character)

No character selection — everyone is the same frog (color-tinted per player: green,
blue, orange, pink).

### Stats
| Stat | Base | Notes |
|---|---|---|
| Max HP | 20 | |
| Move speed | 220 px/s | |
| Damage % | +0% | Multiplies all weapon damage |
| Pickup radius | 60 px | Flies within radius fly to the player |

Only these four stats exist. Three of them (Max HP, Move speed, Damage %) are buyable
in the shop; pickup radius is fixed.

### Controls
- **WASD / arrow keys:** move.
- That's it. Weapons aim and fire automatically at the nearest enemy in range
  (Brotato-style). No manual aim, no dash, no active abilities in v0.1.

### Weapon slots
Each player has **2 weapon slots** (Brotato has 6 — cut for scope). You start the run
with one **Tongue Lash** in slot 1. Slots can hold any mix of the 3 weapon types,
including duplicates.

---

## 4. Weapons (3 types)

All weapons auto-target the nearest enemy within their range and fire on cooldown.
Each type has 3 levels (I/II/III), upgraded in the shop by buying the same weapon again
(two copies of level N in your slots is fine; upgrading merges is **not** in scope —
you upgrade a specific slot in the shop).

| Weapon | Archetype | Behavior | Lv I damage | Cooldown | Range |
|---|---|---|---|---|---|
| **Tongue Lash** | Melee | Instant tongue snap to target; hits the first enemy on the line | 5 | 0.8 s | 120 px |
| **Bubble Blaster** | Ranged | Fires a slow bubble projectile (350 px/s), pops on first hit | 3 | 1.0 s | 400 px |
| **Croak Nova** | AoE | Shockwave ring around the player, hits all enemies in radius | 2 | 2.5 s | 150 px radius |

**Level scaling (all weapons):** Lv II = +60% damage, −10% cooldown. Lv III = +140%
damage, −20% cooldown (relative to Lv I).

Rationale: one melee, one single-target ranged, one AoE — three genuinely different
choices with almost no shared edge cases. All hit detection is server-side and simple
(line test, circle-vs-circle, radius check).

---

## 5. Enemies (2 types)

| Enemy | HP (base) | Speed | Behavior | Damage | Drops |
|---|---|---|---|---|---|
| **Wasp** | 4 | 260 px/s | Chases nearest player; deals contact damage (0.5 s internal cooldown per wasp) | 2 | 1 Fly |
| **Snail Spitter** | 12 | 60 px/s | Keeps ~300 px distance, spits a slow acid glob (250 px/s) every 2.5 s | 3 (projectile) | 3 Flies |

- **Wasp** = fast, fragile pressure; teaches kiting.
- **Snail Spitter** = slow, tanky, ranged; punishes standing still and gives the AoE/
  ranged weapons a reason to exist.

**Per-wave scaling:** enemy HP and count scale with wave number and player count (see
§6). No elites, no bosses in v0.1.

---

## 6. Waves (5 total)

All waves are timed; surviving the timer clears the wave and despawns remaining enemies
(they drop nothing on despawn).

| Wave | Duration | Spawn mix | Notes |
|---|---|---|---|
| 1 | 30 s | Wasps only, slow trickle | Tutorial pace |
| 2 | 35 s | Wasps + first Snails | |
| 3 | 40 s | Even mix, faster spawns | |
| 4 | 45 s | Heavy wasp swarms + snail ring | |
| 5 | 60 s | Everything, max intensity | Finale |

**Scaling formulas (starting values, tune in playtest):**
- Enemy HP multiplier: `1 + 0.25 × (wave − 1)`
- Concurrent enemy cap: `(8 + 4 × wave) × playerFactor`
- Spawn interval: starts at 1.5 s (wave 1) down to 0.5 s (wave 5)
- `playerFactor = 1 + 0.6 × (playerCount − 1)` — applied to spawn cap and spawn rate,
  **not** to enemy HP (bullet-sponge co-op feels bad at this scale).

Enemies spawn at random points just outside the arena edge, never within 250 px of a
player.

---

## 7. Shop & Economy

- **Currency: Flies.** Dropped by enemies, auto-collected within pickup radius.
  Flies are **per-player** (whoever picks it up owns it). Uncollected flies are
  vacuumed to the nearest living player when the wave ends.
- **Shop phase:** 30 s between waves, or ends early when every player presses "Ready".
  Each player sees the same fixed catalog — **no random shop rolls, no rerolls, no
  item pool** (this is the "no items" scope cut).

### Fixed catalog
| Offer | Cost | Notes |
|---|---|---|
| Buy Tongue Lash (Lv I) | 12 | Requires empty slot |
| Buy Bubble Blaster (Lv I) | 15 | Requires empty slot |
| Buy Croak Nova (Lv I) | 18 | Requires empty slot |
| Upgrade a weapon slot to next level | 20 / 35 (→II / →III) | Per slot |
| +3 Max HP (also heals 3) | 10 | Repeatable, price +5 each purchase |
| +8% Damage | 12 | Repeatable, price +6 each purchase |
| +10% Move speed | 12 | Max 3 purchases, price +6 each |

Prices are starting values for playtesting. Everyone is fully healed at the start of
each wave.

---

## 8. Multiplayer Design

- **Model:** co-op, shared arena, **1–4 players**, one game room per server process
  (no lobbies/rooms/matchmaking in v0.1 — you deploy a server, friends connect to it).
- **Joining:** players who connect while a run is in the **lobby or shop** phase join
  immediately (mid-run joiners start with the default loadout and 0 Flies). Players who
  connect **mid-wave** wait in spectator mode until the shop.
- **Lobby:** connected players see each other + a Start button; any player can start.
- **Disconnects:** a disconnected player's frog despawns; their progress is kept in
  memory for 2 minutes keyed by a client-stored token, so a refresh reconnects them
  with weapons/stats intact.
- **Friendly fire:** none. Croak Nova and bubbles pass through allies.
- **After game over / victory:** 10 s scoreboard (flies collected, damage dealt,
  kills per player), then back to lobby for a rematch.

---

## 9. Architecture

### Overview
```
┌────────────────────────┐        WebSocket (JSON v0.1)        ┌──────────────────────────┐
│  Browser client        │  ── input msgs (30/s) ──────────▶   │  Node.js server          │
│  Phaser 3 + TypeScript │  ◀───── snapshot msgs (20/s) ──     │  TypeScript, authoritative│
│  render + input only   │  ◀───── event msgs (on change) ──   │  fixed 30 Hz sim loop     │
└────────────────────────┘                                     └──────────────────────────┘
```

- **Server-authoritative.** The server runs the entire simulation: movement, targeting,
  cooldowns, hits, HP, drops, waves, shop purchases. Clients render state and send
  inputs. This eliminates cheating concerns and, more importantly for scope, means
  game logic lives in exactly one place.
- **Client = Phaser 3 (TypeScript, Vite).** Phaser handles the render loop, sprites,
  input, audio, and UI scenes. The client contains **no gameplay rules** — it
  interpolates snapshots and plays effects when events arrive.
- **Server = Node.js (TypeScript) + `ws`.** No game engine, no physics engine — the
  sim is circles on a plane with hand-rolled math. Fixed-timestep loop at 30 Hz,
  snapshots broadcast at 20 Hz.
- **Shared package:** message type definitions and game constants (stats tables from
  this doc) live in a `shared/` package imported by both sides — single source of
  truth for balance numbers.

### Repo layout (npm workspaces monorepo)
```
frogtato/
├── shared/          # TS types for protocol msgs + constants.ts (all balance tables)
├── server/          # Node + ws; sim loop, rooms of one, wave director, shop logic
├── client/          # Phaser 3 + Vite; scenes: Boot, Lobby, Game, Shop, GameOver
└── DESIGN.md
```

### Netcode (deliberately simple)
- **Client → server:** `{ type: "input", seq, up, down, left, right }` sent at 30/s
  (and on change). Shop actions: `{ type: "buy", offerId, slot? }`, `{ type: "ready" }`.
- **Server → client:**
  - `snapshot` (20/s): positions/HP of all players, positions/HP of all enemies,
    projectile positions, fly-pickup positions. Full snapshots, no delta compression —
    entity cap (~40 enemies, 4 players) keeps these small (a few KB); fine for v0.1.
  - `event` (as they happen): `waveStart`, `waveEnd`, `playerDowned`, `enemyDied`,
    `purchaseResult`, `gameOver`, `victory` — things the client needs for sounds,
    popups, and UI transitions.
- **Client-side smoothing:** render everything ~100 ms in the past, interpolating
  between the two most recent snapshots. **No client-side prediction** for own
  movement in v0.1 — at LAN/regional latencies (<80 ms) with interpolation this feels
  acceptable, and prediction+reconciliation is the single biggest complexity trap for
  this project. Add it in v0.2 only if movement feels bad.
- **Protocol format:** JSON in v0.1 (debuggable in the browser console). Switch to
  binary only if bandwidth actually becomes a problem.

### Server simulation (30 Hz tick)
Per tick: apply latest input per player → move players (clamped to arena) → move
enemies (steering: chase / keep-distance) → tick weapon cooldowns, acquire targets,
spawn attacks → move projectiles, resolve collisions (circle tests) → apply damage,
deaths, fly drops → wave director (spawn timers, wave timer) → check wipe/victory →
broadcast snapshot at `SNAPSHOT_HZ` (20 Hz, i.e. every 1.5 sim ticks on average).

### Arena
Single static map: an elliptical pond ~1600×1200 px with a solid edge (players and
enemies clamped inside). A few lily-pad sprites as pure decoration — **no obstacles or
collision geometry** in v0.1. Camera follows your own frog with slight zoom-out;
off-screen allies get edge-of-screen indicator arrows.

---

## 10. Art & Audio (placeholder-grade)

- **Style:** flat-color 2D sprites, ~top-down-ish side view like Brotato. Frog ≈ 48 px
  circle-with-eyes; recolor per player. Wasp and Snail are single sprites with a 2-frame
  wobble. Attacks: tongue = stretched rectangle, bubble = circle, croak = expanding ring.
- Generated/hand-drawn placeholder art is fine for the whole v0.1; nothing animates
  beyond wobble/flip.
- **Audio:** ~6 sounds (tongue, bubble, croak, hit, pickup, player down) + one
  background loop. Source from free packs (e.g. Kenney) or jsfxr.

---

## 11. Explicitly Out of Scope (v0.1)

Character selection · items · more than 3 weapons or 2 enemies · elites/bosses ·
random shop rolls & rerolls · weapon merging · client-side prediction · lag
compensation · multiple rooms/matchmaking · persistence/accounts · mobile/touch ·
PvP/friendly fire · map obstacles · endless mode · balancing beyond "feels okay in
playtest".

---

## 12. Milestones

1. **M1 — Walking skeleton (netcode proof):** monorepo builds; 2 browsers connect;
   colored circles move around the arena via server-authoritative input→snapshot loop.
   *Riskiest part done first.*
2. **M2 — Combat:** wasps spawn and chase, Tongue Lash auto-fires, HP/damage/death,
   fly drops and pickup.
3. **M3 — Full loop:** all 3 weapons, snail spitter, 5-wave director, shop phase,
   downed/revive, wipe & victory screens. **Game is complete here.**
4. **M4 — Polish:** real sprites, sound, scoreboard, reconnect grace, edge indicators,
   balance pass.

---

## 13. Open Questions (for later, not blockers)

- Deployment target for the server (Pluto? a VPS?) — affects nothing in the design.
- Whether 2 weapon slots is enough for the shop to stay interesting across 5 waves —
  playtest M3 and consider 3 slots.
- Whether wave 5 needs a "finale" twist (e.g. one giant snail) to feel like an ending —
  cheap to add as a scaled-up existing enemy if the plain wave falls flat.
