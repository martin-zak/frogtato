// Phase machine transition helpers (DESIGN §2/§8, PLAN.md T8).
//
// Room owns the authoritative `phase`/`wave`/timing state and the tick loop
// (it's the natural owner of the enemies/projectiles/flies maps and id
// factories those loops touch); this module holds the per-transition
// mutations as small, mostly-pure functions over `players`/`flies` iterables,
// mirroring the sim/*.ts step-function style so room.ts's tick loop and
// message handlers stay thin orchestration.

import { ARENA, FROG_BASE_STATS, REVIVE_HP_PCT, STARTING_WEAPON_SLOTS, type ScoreRow } from '@frogtato/shared';
import type { FlyState } from '../sim/flies.js';
import type { PlayerState } from '../sim/players.js';

/** Clamps the debug `timescale` message to the allowed 1..20 range. */
export function clampTimescale(value: number): number {
  return Math.min(20, Math.max(1, value));
}

/** True iff at least one non-spectator player exists and every one of them is downed (DESIGN §2 wipe). */
export function allActivePlayersDowned(players: Iterable<PlayerState>): boolean {
  let any = false;
  for (const p of players) {
    if (p.spectator || !p.connected) continue;
    any = true;
    if (!p.downed) return false;
  }
  return any;
}

/** Heals every non-downed, non-spectator player to full HP (DESIGN §7: full heal each wave). */
export function healActivePlayers(players: Iterable<PlayerState>): void {
  for (const p of players) {
    if (p.downed || p.spectator || !p.connected) continue;
    p.hp = p.maxHp;
  }
}

/** Revives downed players at REVIVE_HP_PCT of max HP (DESIGN §2: happens when the next wave starts). */
export function reviveDownedPlayers(players: Iterable<PlayerState>): void {
  for (const p of players) {
    if (!p.downed || !p.connected) continue;
    p.downed = false;
    p.hp = Math.max(1, Math.round(p.maxHp * REVIVE_HP_PCT));
  }
}

/**
 * Activates mid-wave/scoreboard joiners once the next shop or lobby phase
 * begins (DESIGN §8: they spectate "until the shop"). Also used for the
 * scoreboard -> lobby transition, where every remaining spectator is
 * activated for the next run's lobby.
 */
export function activateSpectators(players: Iterable<PlayerState>): void {
  for (const p of players) {
    if (!p.spectator) continue;
    p.spectator = false;
    p.hp = p.maxHp;
  }
}

/** Clears every player's shop `ready` flag (called at the start of each shop phase). */
export function resetReadyFlags(players: Iterable<PlayerState>): void {
  for (const p of players) p.ready = false;
}

/** True once every non-spectator player has readied up (and at least one exists) — ends the shop early. */
export function allActivePlayersReady(players: Iterable<PlayerState>): boolean {
  let any = false;
  for (const p of players) {
    if (p.spectator || !p.connected) continue;
    any = true;
    if (!p.ready) return false;
  }
  return any;
}

/**
 * Full reset of one player's run state for a fresh lobby (DESIGN §2/§8:
 * "Full reset of run state on return to lobby"): weapons back to the
 * starting loadout, stats/hp/flies reset, scoreboard counters cleared, and
 * spectator status cleared (the new run's lobby treats everyone connected as
 * an active joiner, per the lobby join rule).
 */
export function resetPlayerForNewRun(player: PlayerState): void {
  player.x = ARENA.width / 2;
  player.y = ARENA.height / 2;
  player.hp = FROG_BASE_STATS.maxHp;
  player.maxHp = FROG_BASE_STATS.maxHp;
  player.flies = 0;
  player.downed = false;
  player.spectator = false;
  player.weapons = [...STARTING_WEAPON_SLOTS];
  player.weaponCooldowns = STARTING_WEAPON_SLOTS.map(() => 0);
  player.stats = {
    damagePct: FROG_BASE_STATS.damagePct,
    moveSpeed: FROG_BASE_STATS.moveSpeed,
    maxHp: FROG_BASE_STATS.maxHp,
    armor: FROG_BASE_STATS.armor,
    regen: FROG_BASE_STATS.regen,
    pickupRadius: FROG_BASE_STATS.pickupRadius,
  };
  player.ready = false;
  player.killCount = 0;
  player.damageDealt = 0;
  player.fliesCollected = 0;
}

/**
 * Vacuums every uncollected fly to the nearest living, active player at wave
 * end (DESIGN §7). No-op (flies just vanish) if no living active player
 * exists — shouldn't normally happen since an all-downed wipe ends the wave
 * via gameover before the timer, not this path.
 */
export function vacuumFliesToNearestPlayer(flies: Map<string, FlyState>, players: Iterable<PlayerState>): void {
  const living = Array.from(players).filter((p) => !p.downed && !p.spectator && p.connected);
  if (living.length > 0) {
    for (const fly of flies.values()) {
      let best = living[0]!;
      let bestDist = Infinity;
      for (const p of living) {
        const d = Math.hypot(p.x - fly.x, p.y - fly.y);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      best.flies += 1;
      best.fliesCollected += 1;
    }
  }
  flies.clear();
}

/** Builds the end-of-run scoreboard (DESIGN §8) from every currently-connected player's counters. */
export function buildScoreboard(players: Iterable<PlayerState>): ScoreRow[] {
  return Array.from(players, (p) => ({
    playerId: p.id,
    kills: p.killCount,
    damageDealt: p.damageDealt,
    fliesCollected: p.fliesCollected,
  }));
}
