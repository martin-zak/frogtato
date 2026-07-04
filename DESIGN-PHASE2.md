# Frogtato — Phase 2 Design (v0.2)

> **Status: shipped as v0.2.0.** Design-time spec, kept as written. Live
> playtesting afterwards changed some of it — 2 weapon slots became 3
> (merging now matches any pair among them), the heron's orbit tightened
> to 280px and bubbles lead their shots so it's actually hittable, and
> the fly economy roughly doubled. `shared/src/constants.ts` (search
> `TUNING`) and `BALANCE-NOTES.md` track the current numbers.

Builds directly on the shipped v0.1 (`DESIGN.md`). Same pillars: small enough to
ship, Brotato feel, co-op first. Phase 2 adds the two things v0.1's cuts left
players wanting most — **who am I?** (classes) and **what do I build toward?**
(deeper stats + weapon merging) — plus one piece of content to make the ending
land. Everything else stays cut.

**Scope guard:** 3 classes, 3 new stats, 1 new enemy, 1 boss, weapon merging,
lobby names. Nothing else. No items, no new weapons, no new maps, no endless
mode, no meta-progression between runs.

---

## 1. Frog Classes (3)

Picked per player in the lobby (replaces v0.1's "everyone is the same frog").
A class is **only** a stat-modifier bundle + starting weapon — no unique
abilities, no unique weapons, so the sim needs zero new mechanics.

| Class | Fantasy | Stat mods vs base | Starts with |
|---|---|---|---|
| **Bullfrog** | tanky bruiser | +8 Max HP, −15% move speed, +1 Armor | Croak Nova I |
| **Tree Frog** | fast skirmisher | +15% move speed, −4 Max HP, +20 pickup radius | Tongue Lash I |
| **Dart Frog** | glass cannon | +15% Damage, −6 Max HP | Bubble Blaster I |

- Lobby UI: three class cards; your pick shows on your row (all players see it).
  Default = Tree Frog (v0.1 behavior-ish) if you never click.
- Visual: same frog sprite, class shown by a small icon over the frog + on the
  HUD. (Optional stretch: per-class tint accent — skip if fiddly.)
- Rendered stats all flow through the existing `stats` snapshot field — the
  class choice itself is one new lobby message + one `PlayerSnap.class` field.

## 2. New Attributes (3, completing the stat sheet)

v0.1 shipped Max HP / Damage% / Move speed as buyable. Phase 2 adds exactly
three, chosen because each changes *decisions*, not just numbers:

| Stat | Effect | Base | Shop offer |
|---|---|---|---|
| **Armor** | flat damage reduction per hit (min 1 damage taken) | 0 | +1 Armor — 14 flies, price +8 each, cap 3 |
| **Regen** | HP per 5 s during waves | 0 | +1 Regen — 12 flies, price +6 each, cap 3 |
| **Pickup radius** | fly magnet range (now buyable) | 60 px | +15 px — 8 flies, price +4 each, cap 4 |

Caps keep the fixed catalog from breaking wave-5 balance. All three are plain
fields in the existing stat pipeline (`constants.ts` → shop → sim → snapshot).

## 3. Weapon Merging

Brotato's satisfying "combine" comes back in the smallest possible form:

- In the **shop only**, if both slots hold the **same weapon kind at the same
  level** (I+I or II+II), a **Merge** button appears: combine into ONE weapon
  of the next level, freeing the other slot. Free (no fly cost) — the payoff
  is the freed slot.
- Lv III cannot merge (no Lv IV). Merging is per-player, one new client→server
  message (`merge`), validated server-side like any purchase.
- This finally makes "buy a duplicate" a strategy, and gives the 2-slot loadout
  real decision depth without adding a third slot.

## 4. Content: one new enemy + a finale boss

- **Heron** (new enemy, waves 3+): a lanky bird that circles at long range,
  then telegraphs (0.8 s shadow line) and **dive-swoops** in a straight line
  through the arena, damaging anything on the path (4 dmg), then re-circles.
  8 HP, drops 2 flies. Teaches dodge-on-telegraph — the one skill v0.1's two
  enemies never demand. Reuses the projectile-style line test for its swoop.
- **Snail King** (boss): wave 5's last 20 seconds now spawn the finale —
  a giant snail (scaled sprite ×3, 120 HP × playerFactor, speed 40) that
  fires 3-glob spreads every 2 s and periodically gains a shell phase
  (2 s of Armor 5, visibly tucked in). Regular spawns stop while it lives.
  Kill it (or survive until the wave timer would have ended + 30 s hard cap)
  → victory. Resolves DESIGN.md §13's open question: the plain wave-5 ending
  needed a peak, and this reuses snail art + projectile spread, no new systems.

## 5. Small QoL (only what multiplayer sessions actually hit)

- **Names:** lobby text field (max 12 chars), sent once with class pick;
  `PlayerSnap.name` already exists in the protocol — show it over frogs,
  in the shop ready-list, and on the scoreboard.
- **Rematch keeps classes:** returning to lobby preserves each player's last
  class + name so a rematch is one click.

## 6. Explicitly still out of scope (v0.2)

More weapons · more than 2 weapon slots · items · random shop rolls · endless
mode · PvP · new arenas/obstacles · accounts/persistence · mobile · client
prediction (unless the LAN playtest demands it) · per-class abilities.

---

## 7. Implementation cut (agent-sized tasks, same rules as PLAN.md)

Dependency shape mirrors Phase 1: contract first, then server ∥ client.

| Task | Owns | Summary |
|---|---|---|
| **P1 — Contracts** | `shared/` | Class defs, 3 new stats (+ shop offers/caps), heron + boss defs, `pickClass`/`merge`/name messages, `PlayerSnap.class/name`, boss snapshot fields. Unit tests for new tables. |
| **P2 — Server: classes & stats** | `server/sim`, `game/shop.ts` | Apply class bundles on spawn/reset, armor/regen/pickup-radius in the damage/heal/fly paths, 3 new shop offers, merge validation. Extends `shop-check` + new `class-check`. |
| **P3 — Server: heron & boss** | `server/sim`, `game/waves.ts` | Heron circle/telegraph/swoop AI; wave-5 boss phase in the wave director (spawn stop, shell phase, hard cap). Extends `loop-check` (boss victory path). |
| **P4 — Client: lobby classes & names** | `client/scenes/Lobby`, `ui/` | Class cards, name field, class/name display everywhere (frog labels, shop, scoreboard). |
| **P5 — Client: merge UI + new stats + boss/heron rendering** | `client/ui/shop`, `render/` | Merge button in shop, 3 new stat rows, heron sprite + telegraph line + swoop effect, boss scale/shell-phase visuals. Needs 2 new sprites (heron, crown/shell accent) + 1 telegraph SFX from the synth script. |
| **P6 — Balance & gate** | `shared/constants.ts` only | Human playtest: 5-wave run per class, boss difficulty at 1 and 4 players, merge economy sanity. |

Parallelism: P1 → (P2 ∥ P4) → (P3 ∥ P5) → P6. Estimated at Phase-1 pacing:
**~1.5–2 h of fleet time** plus one human playtest gate.
