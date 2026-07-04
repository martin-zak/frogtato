# P6 Balance Probe Findings (v0.2.0, pre-playtest)

Bot-measured numbers from `scripts/balance-probe.mjs` (timescale ×10). These are
*signals for the human playtest*, not verdicts — bots stand still; players don't.
All fixes are `shared/src/constants.ts` edits.

## 1. The Snail King is (probably) too safe — HIGH priority
Both probe scenarios ended at the 30s **hard-cap survival victory**, never a kill:
- 1 player, croak III ×2 (strong endgame loadout): boss not killed
- 4 players, all croak III ×2 (vs ×2.8 HP): boss not killed

Why, mechanically:
- Boss spawns at the **farthest** arena edge and walks at speed 40 → ~15s of the
  30s cap is spent out of everyone's range (probe bots camped mid-arena; croak
  range is only 150).
- Shell phase (armor 5, every 8s for 2s) reduces croak III hits from 4.8 → 1
  (min-1 rule) — a ~79% damage cut during ~25% of the fight.

Suggested knobs (pick 1–2, not all): hard cap 30s → 60s · boss spawn ≥400px from
players instead of farthest edge · shell armor 5 → 3 · boss speed 40 → 55.
Note: runs still END correctly today (hard cap = victory), so this is about
making the kill *achievable and satisfying*, not about broken runs.

## 2. Dartfrog's +15% damage crosses no early breakpoint — MEDIUM
Standing-still survival, wave 1: treefrog 39.7s · bullfrog 10.7s · dartfrog 5.1s.
The spread is driven by starting weapons, not survivability stats:
- Treefrog's tongue **one-shots** wave-1 wasps (5 dmg vs 4 HP).
- Dartfrog's bubble does 3 × 1.15 = **3.45 vs 4 HP — still 2 hits**, so its
  entire class bonus is invisible against the first thing you fight.
- Bullfrog's croak needs 2 hits on a 2.5s cooldown → swarmed despite armor.

Suggested knobs: bubble Lv I damage 3 → 3.5 (dartfrog crosses to 4.02 and
one-shots; base players don't — nice class moment) · or wasp HP 4 → 3.5.
Bullfrog early game is worth a feel-check in the playtest; on paper it's weak
solo in wave 1 but its kit is team/late oriented.

## 3. P3's inferred tuning values — check in playtest
Not in the design doc, picked by agents, all marked `// TUNING` in constants:
heron circle/swoop speeds (150/500) and orbit radius (350) · boss shell interval
(8s) · boss spread glob dmg/speed (4/250) · wave-5 heron spawn weights (0.1–0.2)
· boss fly reward (30).

## Probe caveats
- "Standing still" is a lower bound on survival; moving players do far better.
- Boss kill-times were measured with camping bots; kiting toward the boss or
  bubble range (400) engages ~6–9s sooner. Re-run after tuning:
  `node scripts/balance-probe.mjs`.
