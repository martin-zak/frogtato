// Single Room per server process (DESIGN §8: one game room, no lobbies/matchmaking
// in v0.1). Owns the player set, the fixed-timestep sim loop, and snapshot
// broadcasting. Phase is hardcoded to "wave" for T3 — the phase machine (lobby/shop/
// scoreboard transitions) is T8's job; this just needs frogs to move.
//
// T5 adds enemies, projectiles, flies and their per-tick simulation, wired in
// here as the glue between the standalone sim/*.ts modules (each of which stays
// decoupled from the others where possible — see module doc-comments).

import {
  ENEMY_DEFS,
  MAX_PLAYERS,
  PLAYER_COLOR_ORDER,
  SIM_HZ,
  SNAPSHOT_HZ,
  makeIdFactory,
  type ClientDebugMsg,
  type ClientMsg,
  type GameEvent,
  type Phase,
  type ServerMsg,
} from '@frogtato/shared';
import { applyInput, createPlayer, setWeaponSlot, stepPlayerMovement, toPlayerSnap, type PlayerState } from './sim/players.js';
import * as combat from './sim/combat.js';
import {
  createInterimSpawnerState,
  ENEMY_KIND_BY_TYPE,
  stepEnemyAi,
  stepInterimSpawner,
  toEnemySnap,
  type EnemyState,
} from './sim/enemies.js';
import { spawnFliesAt, stepFlies, toFlySnap, type FlyState } from './sim/flies.js';
import {
  circlesOverlap,
  isOutsideArena,
  stepProjectile,
  toProjectileSnap,
  type ProjectileState,
} from './sim/projectiles.js';
import { stepPlayerWeapons } from './sim/weapons.js';

export interface RoomCallbacks {
  broadcast(msg: ServerMsg): void;
}

// DESIGN §9 literally says "every 3rd tick" for snapshot broadcast, but that text
// predates SIM_HZ/SNAPSHOT_HZ being pinned in constants.ts: at SIM_HZ=30 every 3rd
// tick is 10 Hz, not the SNAPSHOT_HZ=20 the same doc and constants.ts specify (and
// not enough to satisfy skeleton-check's 15-25/s band). constants.ts is the source
// of truth per the task brief, so broadcast cadence here is derived from
// SIM_HZ/SNAPSHOT_HZ (a fixed-point-safe 1.5 ticks/broadcast, alternating 1-tick and
// 2-tick gaps) instead of the hardcoded "3".
const TICKS_PER_SNAPSHOT = SIM_HZ / SNAPSHOT_HZ;

const FIXED_DT_SEC = 1 / SIM_HZ;
// Sample the accumulator faster than the tick rate so real elapsed time (not
// setInterval's own jitter) drives how many fixed steps run — this is what keeps
// the 30 Hz sim from drifting under load.
const ACCUMULATOR_SAMPLE_MS = 1000 / SIM_HZ / 2;
// Guard against a huge stall (e.g. debugger pause) causing a catch-up spiral.
const MAX_FRAME_SEC = 0.25;

export class Room {
  readonly phase: Phase = 'wave';

  private players = new Map<string, PlayerState>();
  private enemies = new Map<string, EnemyState>();
  private projectiles = new Map<string, ProjectileState>();
  private flies = new Map<string, FlyState>();
  private spawner = createInterimSpawnerState();
  // Debug-only (T5): NODE_ENV gate lives at the message-routing layer (net.ts).
  private invinciblePlayers = new Set<string>();

  private nextEnemyId = makeIdFactory('enemy');
  private nextProjectileId = makeIdFactory('projectile');
  private nextFlyId = makeIdFactory('fly');

  private tick = 0;
  private accumulatorSec = 0;
  private snapshotAccumulatorTicks = 0;
  private lastSampleMs = 0;
  private intervalHandle: NodeJS.Timeout | undefined;

  constructor(private callbacks: RoomCallbacks) {}

  get playerCount(): number {
    return this.players.size;
  }

  isFull(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  private nextFreeColorIndex(): number {
    const used = new Set(Array.from(this.players.values(), (p) => p.colorIndex));
    for (let i = 0; i < PLAYER_COLOR_ORDER.length; i++) {
      if (!used.has(i)) return i;
    }
    return 0; // unreachable: callers must check isFull() before addPlayer()
  }

  addPlayer(id: string, token: string): PlayerState {
    const player = createPlayer(id, this.nextFreeColorIndex(), token);
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  handleClientMsg(playerId: string, msg: ClientMsg): void {
    const player = this.players.get(playerId);
    if (!player) return;
    switch (msg.type) {
      case 'input':
        applyInput(player, msg);
        break;
      case 'debug':
        // NODE_ENV gating happens in net.ts before this is ever called.
        this.handleDebugMsg(player, msg);
        break;
      // "start" / "buy" / "ready": no phase machine or shop exist yet (T8/T9).
      // Valid-but-not-yet-implemented messages are ignored quietly rather than
      // treated as protocol errors.
      default:
        break;
    }
  }

  private emit(event: GameEvent): void {
    this.callbacks.broadcast({ type: 'event', event });
  }

  private handleDebugMsg(player: PlayerState, msg: ClientDebugMsg): void {
    if (msg.kill !== undefined) this.debugKillEnemy(msg.kill);
    if (msg.grantFlies !== undefined) player.flies += msg.grantFlies;
    if (msg.invincible !== undefined) {
      if (msg.invincible) this.invinciblePlayers.add(player.id);
      else this.invinciblePlayers.delete(player.id);
    }
    if (msg.give !== undefined) setWeaponSlot(player, msg.give.slot, msg.give.weapon, msg.give.level);
    if (msg.timescale !== undefined) console.warn('[frogtato] debug "timescale" not implemented until T8');
  }

  private debugKillEnemy(enemyId: string): void {
    const enemy = this.enemies.get(enemyId);
    if (!enemy) return;
    const died = combat.damageEnemy(
      enemy,
      ENEMY_KIND_BY_TYPE[enemy.type],
      ENEMY_DEFS[enemy.type].flyDrop,
      Infinity,
      (event) => this.emit(event),
      (x, y, count) => spawnFliesAt(this.nextFlyId, x, y, count, this.flies),
    );
    if (died) this.enemies.delete(enemyId);
  }

  start(): void {
    this.lastSampleMs = performance.now();
    this.intervalHandle = setInterval(() => this.sample(), ACCUMULATOR_SAMPLE_MS);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  private sample(): void {
    const now = performance.now();
    let frameSec = (now - this.lastSampleMs) / 1000;
    this.lastSampleMs = now;
    if (frameSec > MAX_FRAME_SEC) frameSec = MAX_FRAME_SEC;

    this.accumulatorSec += frameSec;
    while (this.accumulatorSec >= FIXED_DT_SEC) {
      this.tickOnce();
      this.accumulatorSec -= FIXED_DT_SEC;
    }
  }

  private tickOnce(): void {
    this.tick += 1;
    for (const player of this.players.values()) {
      stepPlayerMovement(player, FIXED_DT_SEC);
    }

    stepInterimSpawner(this.spawner, FIXED_DT_SEC, this.enemies, this.players.values(), this.nextEnemyId);
    this.stepEnemies();
    this.stepWeapons();
    this.stepProjectiles();
    stepFlies(this.flies, this.players.values(), FIXED_DT_SEC);

    this.snapshotAccumulatorTicks += 1;
    if (this.snapshotAccumulatorTicks >= TICKS_PER_SNAPSHOT) {
      this.snapshotAccumulatorTicks -= TICKS_PER_SNAPSHOT;
      this.broadcastSnapshot();
    }
  }

  private stepEnemies(): void {
    for (const enemy of this.enemies.values()) {
      stepEnemyAi(enemy, {
        players: this.players.values(),
        dtSec: FIXED_DT_SEC,
        onContactDamage: (_wasp, target) => {
          if (this.invinciblePlayers.has(target.id)) return;
          combat.damagePlayer(target, ENEMY_DEFS.wasp.contactDamage, (event) => this.emit(event));
        },
        spawnProjectile: (projectile) => this.projectiles.set(projectile.id, projectile),
        nextProjectileId: this.nextProjectileId,
      });
    }
  }

  private stepWeapons(): void {
    for (const player of this.players.values()) {
      stepPlayerWeapons(player, {
        enemies: this.enemies,
        dtSec: FIXED_DT_SEC,
        emit: (event) => this.emit(event),
        spawnProjectile: (projectile) => this.projectiles.set(projectile.id, projectile),
        nextProjectileId: this.nextProjectileId,
        spawnFlies: (x, y, count) => spawnFliesAt(this.nextFlyId, x, y, count, this.flies),
      });
    }
  }

  private stepProjectiles(): void {
    for (const projectile of Array.from(this.projectiles.values())) {
      stepProjectile(projectile, FIXED_DT_SEC);

      if (isOutsideArena(projectile.x, projectile.y)) {
        this.projectiles.delete(projectile.id);
        continue;
      }

      // Collision target set is data-driven by `source`: enemy projectiles (acid)
      // hit players, player projectiles (bubble) hit enemies. Kept as one loop
      // so future projectile kinds only need a new branch here, not a new caller.
      if (projectile.source === 'enemy') {
        for (const player of this.players.values()) {
          if (player.downed || player.spectator || this.invinciblePlayers.has(player.id)) continue;
          if (!circlesOverlap(projectile.x, projectile.y, projectile.radius, player.x, player.y, combat.PLAYER_RADIUS)) {
            continue;
          }
          combat.damagePlayer(player, projectile.damage, (event) => this.emit(event));
          this.projectiles.delete(projectile.id);
          break;
        }
      } else if (projectile.source === 'player') {
        for (const enemy of this.enemies.values()) {
          const radius = combat.ENEMY_RADIUS[ENEMY_KIND_BY_TYPE[enemy.type]];
          if (!circlesOverlap(projectile.x, projectile.y, projectile.radius, enemy.x, enemy.y, radius)) continue;
          const died = combat.damageEnemy(
            enemy,
            ENEMY_KIND_BY_TYPE[enemy.type],
            ENEMY_DEFS[enemy.type].flyDrop,
            projectile.damage,
            (event) => this.emit(event),
            (x, y, count) => spawnFliesAt(this.nextFlyId, x, y, count, this.flies),
          );
          if (died) this.enemies.delete(enemy.id);
          this.projectiles.delete(projectile.id);
          break;
        }
      }
    }
  }

  private broadcastSnapshot(): void {
    const msg: ServerMsg = {
      type: 'snapshot',
      tick: this.tick,
      phase: this.phase,
      players: Array.from(this.players.values(), toPlayerSnap),
      enemies: Array.from(this.enemies.values(), toEnemySnap),
      projectiles: Array.from(this.projectiles.values(), toProjectileSnap),
      flies: Array.from(this.flies.values(), toFlySnap),
    };
    this.callbacks.broadcast(msg);
  }
}
