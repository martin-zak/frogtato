// Wave director (DESIGN §6, PLAN.md T8): spawns enemies for the currently
// active wave per WAVES' spawn mix, ramps the spawn interval within the wave,
// enforces the playerFactor-scaled concurrent-enemy cap, and applies the
// per-wave enemy HP multiplier. Replaces T5's interim spawner in
// sim/enemies.ts wholesale (deleted there); reuses that module's
// `pickEnemySpawnPoint` for the arena-edge / min-distance spawn rule.
//
// Mirrors the structure of sim/enemies.ts's old interim spawner and
// sim/weapons.ts's per-tick step-function style: plain state + one step
// function, driven from room.ts once per tick while phase === "wave".

import { enemyCap, enemyHpMultiplier, type WaveDef } from '@frogtato/shared';
import { createEnemy, pickEnemySpawnPoint, type EnemyState, type EnemyTypeInternal } from '../sim/enemies.js';
import type { PlayerState } from '../sim/players.js';

export interface WaveDirectorState {
  /** Simulated seconds elapsed since the current wave started (drives the spawn-interval ramp). */
  waveElapsedSec: number;
  /** Simulated seconds remaining before the next spawn attempt. */
  spawnCooldownSec: number;
}

export function createWaveDirectorState(): WaveDirectorState {
  return { waveElapsedSec: 0, spawnCooldownSec: 0 };
}

/** Resets the director for the start of a new wave; the first spawn can happen almost immediately. */
export function resetWaveDirectorState(state: WaveDirectorState): void {
  state.waveElapsedSec = 0;
  state.spawnCooldownSec = 0;
}

/**
 * Linear ramp of the spawn interval across the wave's duration, from
 * `spawnIntervalStartSec` to `spawnIntervalEndSec` (WaveDef, constants.ts). If
 * a wave def ever defines a flat (non-ramping) interval, start === end and
 * this degenerates to that constant value automatically.
 */
function currentSpawnIntervalSec(waveDef: WaveDef, waveElapsedSec: number): number {
  const t = Math.min(1, Math.max(0, waveElapsedSec / waveDef.durationSec));
  return waveDef.spawnIntervalStartSec + (waveDef.spawnIntervalEndSec - waveDef.spawnIntervalStartSec) * t;
}

function pickEnemyType(spawnMix: WaveDef['spawnMix']): EnemyTypeInternal {
  const total = spawnMix.wasp + spawnMix.snailSpitter + spawnMix.heron;
  if (total <= 0) return 'wasp';
  const r = Math.random() * total;
  if (r < spawnMix.wasp) return 'wasp';
  if (r < spawnMix.wasp + spawnMix.snailSpitter) return 'snailSpitter';
  return 'heron';
}

/**
 * Steps the wave director by dtSec: spawns at most one enemy per call once
 * its ramping cooldown elapses and the playerFactor-scaled concurrent cap
 * (`enemyCap`) isn't reached, weighted by the wave's spawn mix
 * (`pickEnemyType`), with HP/maxHp scaled by `enemyHpMultiplier(wave)`.
 */
export function stepWaveDirector(
  state: WaveDirectorState,
  waveDef: WaveDef,
  dtSec: number,
  playerCount: number,
  enemies: Map<string, EnemyState>,
  players: Iterable<PlayerState>,
  nextEnemyId: () => string,
): void {
  state.waveElapsedSec += dtSec;
  state.spawnCooldownSec -= dtSec;
  if (state.spawnCooldownSec > 0) return;
  state.spawnCooldownSec += currentSpawnIntervalSec(waveDef, state.waveElapsedSec);

  const cap = enemyCap(waveDef.wave, playerCount);
  if (enemies.size >= cap) return;

  const type = pickEnemyType(waveDef.spawnMix);
  const point = pickEnemySpawnPoint(players);
  const enemy = createEnemy(nextEnemyId(), type, point.x, point.y);
  const hpMult = enemyHpMultiplier(waveDef.wave);
  enemy.hp *= hpMult;
  enemy.maxHp *= hpMult;
  enemies.set(enemy.id, enemy);
}
