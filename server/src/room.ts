// Single Room per server process (DESIGN §8: one game room, no lobbies/matchmaking
// in v0.1). Owns the player set, the fixed-timestep sim loop, snapshot
// broadcasting, and — as of T8 — the phase machine (lobby -> wave(1..5) -> shop
// -> ... -> victory|gameover -> scoreboard -> lobby), the wave director, and
// downed/revive/join-rule handling. Per-transition mutations live in
// game/phases.ts and game/waves.ts; this class is the tick-loop orchestrator
// that ties them together with the sim/*.ts step functions.

import {
  ENEMY_DEFS,
  MAX_PLAYERS,
  PLAYER_COLOR_ORDER,
  RECONNECT_GRACE_SEC,
  SCOREBOARD_DURATION_SEC,
  SHOP_DURATION_SEC,
  SIM_HZ,
  SNAPSHOT_HZ,
  WAVES,
  WAVE_COUNT,
  makeIdFactory,
  type ClientDebugMsg,
  type ClientMsg,
  type GameEvent,
  type Phase,
  type ServerMsg,
} from '@frogtato/shared';
import { applyInput, createPlayer, setWeaponSlot, stepPlayerMovement, toPlayerSnap, type PlayerState } from './sim/players.js';
import * as combat from './sim/combat.js';
import { ENEMY_KIND_BY_TYPE, stepEnemyAi, toEnemySnap, type EnemyState } from './sim/enemies.js';
import { spawnFliesAt, stepFlies, toFlySnap, type FlyState } from './sim/flies.js';
import {
  circlesOverlap,
  isOutsideArena,
  stepProjectile,
  toProjectileSnap,
  type ProjectileState,
} from './sim/projectiles.js';
import { stepPlayerWeapons } from './sim/weapons.js';
import { createWaveDirectorState, resetWaveDirectorState, stepWaveDirector, type WaveDirectorState } from './game/waves.js';
import { handleBuy, resetShopCounts } from './game/shop.js';
import {
  activateSpectators,
  allActivePlayersDowned,
  allActivePlayersReady,
  buildScoreboard,
  clampTimescale,
  healActivePlayers,
  resetPlayerForNewRun,
  resetReadyFlags,
  reviveDownedPlayers,
  vacuumFliesToNearestPlayer,
} from './game/phases.js';

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
  phase: Phase = 'lobby';
  /** Current wave number (1..WAVE_COUNT while in/around a wave; 0 in lobby). */
  private wave = 0;
  /** Simulated seconds remaining in the current timed phase; undefined in lobby (untimed). */
  private phaseRemainingSec: number | undefined;

  private players = new Map<string, PlayerState>();
  private enemies = new Map<string, EnemyState>();
  private projectiles = new Map<string, ProjectileState>();
  private flies = new Map<string, FlyState>();
  private waveDirector: WaveDirectorState = createWaveDirectorState();
  // Debug-only (T5): NODE_ENV gate lives at the message-routing layer (net.ts).
  private invinciblePlayers = new Set<string>();
  /** Debug-only (T8): multiplies simulated dt per tick, clamped 1..20. */
  private timescale = 1;

  private nextEnemyId = makeIdFactory('enemy');
  private nextProjectileId = makeIdFactory('projectile');
  private nextFlyId = makeIdFactory('fly');

  /** Pending full-removal timers for disconnected players, keyed by playerId
   * (T11 reconnect grace: RECONNECT_GRACE_SEC after a disconnect, cleared on
   * either reconnect or grace expiry). */
  private disconnectTimers = new Map<string, NodeJS.Timeout>();

  private tick = 0;
  private accumulatorSec = 0;
  private snapshotAccumulatorTicks = 0;
  private lastSampleMs = 0;
  private intervalHandle: NodeJS.Timeout | undefined;

  constructor(private callbacks: RoomCallbacks) {}

  /** Count of *connected* players — used for wave-difficulty scaling
   * (playerFactor) and the room-full check. A player sitting in reconnect
   * grace (T11, disconnected but not yet expired) shouldn't inflate
   * difficulty for everyone else, and shouldn't block a new player from
   * taking a live seat either — their reserved color/state just waits for
   * them, uncounted, until they reconnect or the grace timer removes them. */
  get playerCount(): number {
    let count = 0;
    for (const p of this.players.values()) if (p.connected) count += 1;
    return count;
  }

  isFull(): boolean {
    return this.playerCount >= MAX_PLAYERS;
  }

  private nextFreeColorIndex(): number {
    const used = new Set(Array.from(this.players.values(), (p) => p.colorIndex));
    for (let i = 0; i < PLAYER_COLOR_ORDER.length; i++) {
      if (!used.has(i)) return i;
    }
    return 0; // unreachable: callers must check isFull() before addPlayer()
  }

  /**
   * Join rules (DESIGN §8): joiners during lobby/shop spawn immediately with
   * the default loadout and 0 flies; joiners mid-wave/scoreboard spectate
   * until the next shop/lobby (game/phases.ts's `activateSpectators` clears
   * this at the right transitions).
   */
  addPlayer(id: string, token: string): PlayerState {
    const player = createPlayer(id, this.nextFreeColorIndex(), token);
    player.spectator = this.phase === 'wave' || this.phase === 'scoreboard';
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string): void {
    const timer = this.disconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(id);
    }
    this.players.delete(id);
    this.invinciblePlayers.delete(id);
    resetShopCounts(id);
  }

  /**
   * Websocket dropped mid-run (T11 reconnect, DESIGN §8): keep the player's
   * full sim state (weapons/stats/flies/downed/playerId) in memory, marked
   * `connected: false` so it's excluded from snapshots and every
   * active-player gameplay check, for RECONNECT_GRACE_SEC. If no matching
   * `hello {token}` arrives in that window, fully drop the state.
   */
  disconnectPlayer(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(id);
      this.removePlayer(id);
    }, RECONNECT_GRACE_SEC * 1000);
    this.disconnectTimers.set(id, timer);
  }

  /**
   * `hello {token}` arriving within the grace window: restores the same
   * playerId with all preserved state. Returns undefined for an unknown/
   * expired/already-connected token, which net.ts treats as a normal fresh
   * join.
   */
  reconnectPlayer(token: string): PlayerState | undefined {
    for (const player of this.players.values()) {
      if (player.token !== token || player.connected) continue;
      const timer = this.disconnectTimers.get(player.id);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(player.id);
      player.connected = true;
      return player;
    }
    return undefined;
  }

  /** Routing-layer defense in depth (T11): whether `input` from this player
   * should be applied at all — false for unknown, downed, spectating, or
   * disconnected-slot players. */
  canAcceptInput(id: string): boolean {
    const player = this.players.get(id);
    if (!player) return false;
    return !player.downed && !player.spectator && player.connected;
  }

  handleClientMsg(playerId: string, msg: ClientMsg): void {
    const player = this.players.get(playerId);
    if (!player) return;
    switch (msg.type) {
      case 'input':
        applyInput(player, msg);
        break;
      case 'start':
        if (this.phase === 'lobby') this.beginRun();
        break;
      case 'ready':
        if (this.phase === 'shop' && !player.spectator) player.ready = true;
        break;
      case 'debug':
        // NODE_ENV gating happens in net.ts before this is ever called.
        this.handleDebugMsg(player, msg);
        break;
      case 'buy':
        this.emit(handleBuy(this.phase, player, msg));
        break;
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
    if (msg.timescale !== undefined) this.timescale = clampTimescale(msg.timescale);
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

  // ---------------------------------------------------------------------
  // Phase machine (DESIGN §2/§8)
  // ---------------------------------------------------------------------

  /** `start` from lobby: full reset, then begin wave 1. */
  private beginRun(): void {
    for (const player of this.players.values()) {
      resetPlayerForNewRun(player);
      resetShopCounts(player.id);
    }
    this.enemies.clear();
    this.projectiles.clear();
    this.flies.clear();
    this.wave = 1;
    this.enterWavePhase();
  }

  private enterWavePhase(): void {
    this.phase = 'wave';
    resetWaveDirectorState(this.waveDirector);
    const waveDef = WAVES[this.wave - 1]!;
    this.phaseRemainingSec = waveDef.durationSec;
    this.emit({ type: 'waveStart', wave: this.wave });
  }

  /** Wave timer elapsed: despawn enemies/enemy-projectiles, vacuum flies, heal, advance. */
  private endWave(): void {
    this.enemies.clear();
    for (const [id, projectile] of this.projectiles) {
      if (projectile.source === 'enemy') this.projectiles.delete(id);
    }
    vacuumFliesToNearestPlayer(this.flies, this.players.values());
    this.emit({ type: 'waveEnd', wave: this.wave });
    healActivePlayers(this.players.values());

    if (this.wave >= WAVE_COUNT) {
      this.emit({ type: 'victory', scoreboard: buildScoreboard(this.players.values()) });
      this.enterScoreboardPhase();
    } else {
      this.enterShopPhase();
    }
  }

  private enterShopPhase(): void {
    this.phase = 'shop';
    activateSpectators(this.players.values());
    resetReadyFlags(this.players.values());
    this.phaseRemainingSec = SHOP_DURATION_SEC;
  }

  /** Shop timer elapsed, or every active player readied up: revive downed, advance to the next wave. */
  private endShop(): void {
    reviveDownedPlayers(this.players.values());
    this.wave += 1;
    this.enterWavePhase();
  }

  /** All active players downed mid-wave (DESIGN §2 wipe): immediate game over. */
  private triggerGameOver(): void {
    this.enemies.clear();
    this.projectiles.clear();
    this.flies.clear();
    this.emit({ type: 'gameOver', scoreboard: buildScoreboard(this.players.values()) });
    this.enterScoreboardPhase();
  }

  private enterScoreboardPhase(): void {
    this.phase = 'scoreboard';
    this.phaseRemainingSec = SCOREBOARD_DURATION_SEC;
  }

  /** Scoreboard timer elapsed: activate any remaining spectators, full reset, back to lobby. */
  private endScoreboard(): void {
    activateSpectators(this.players.values());
    for (const player of this.players.values()) {
      resetPlayerForNewRun(player);
      resetShopCounts(player.id);
    }
    this.wave = 0;
    this.phase = 'lobby';
    this.phaseRemainingSec = undefined;
  }

  /** Ticks the current phase's countdown (simulated time, scaled by debug timescale) and transitions on expiry. */
  private stepPhaseTimer(dtSec: number): void {
    if (this.phaseRemainingSec === undefined) return;
    this.phaseRemainingSec -= dtSec;
    if (this.phaseRemainingSec > 0) return;

    switch (this.phase) {
      case 'wave':
        this.endWave();
        break;
      case 'shop':
        this.endShop();
        break;
      case 'scoreboard':
        this.endScoreboard();
        break;
      case 'lobby':
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Tick loop
  // ---------------------------------------------------------------------

  private tickOnce(): void {
    this.tick += 1;
    const dt = FIXED_DT_SEC * this.timescale;

    for (const player of this.players.values()) {
      stepPlayerMovement(player, dt);
    }

    if (this.phase === 'shop' && allActivePlayersReady(this.players.values())) {
      this.endShop();
    }

    if (this.phase === 'wave') {
      this.stepWaveSim(dt);
    }

    stepFlies(this.flies, this.players.values(), dt);
    this.stepPhaseTimer(dt);

    this.snapshotAccumulatorTicks += 1;
    if (this.snapshotAccumulatorTicks >= TICKS_PER_SNAPSHOT) {
      this.snapshotAccumulatorTicks -= TICKS_PER_SNAPSHOT;
      this.broadcastSnapshot();
    }
  }

  private stepWaveSim(dt: number): void {
    const waveDef = WAVES[this.wave - 1]!;
    stepWaveDirector(this.waveDirector, waveDef, dt, this.playerCount, this.enemies, this.players.values(), this.nextEnemyId);
    this.stepEnemies(dt);
    this.stepWeapons(dt);
    this.stepProjectiles(dt);

    if (allActivePlayersDowned(this.players.values())) {
      this.triggerGameOver();
    }
  }

  private stepEnemies(dt: number): void {
    for (const enemy of this.enemies.values()) {
      stepEnemyAi(enemy, {
        players: this.players.values(),
        dtSec: dt,
        onContactDamage: (_wasp, target) => {
          if (this.invinciblePlayers.has(target.id)) return;
          combat.damagePlayer(target, ENEMY_DEFS.wasp.contactDamage, (event) => this.emit(event));
        },
        spawnProjectile: (projectile) => this.projectiles.set(projectile.id, projectile),
        nextProjectileId: this.nextProjectileId,
      });
    }
  }

  private stepWeapons(dt: number): void {
    for (const player of this.players.values()) {
      stepPlayerWeapons(player, {
        enemies: this.enemies,
        dtSec: dt,
        emit: (event) => this.emit(event),
        spawnProjectile: (projectile) => this.projectiles.set(projectile.id, projectile),
        nextProjectileId: this.nextProjectileId,
        spawnFlies: (x, y, count) => spawnFliesAt(this.nextFlyId, x, y, count, this.flies),
      });
    }
  }

  private stepProjectiles(dt: number): void {
    for (const projectile of Array.from(this.projectiles.values())) {
      stepProjectile(projectile, dt);

      if (isOutsideArena(projectile.x, projectile.y)) {
        this.projectiles.delete(projectile.id);
        continue;
      }

      // Collision target set is data-driven by `source`: enemy projectiles (acid)
      // hit players, player projectiles (bubble) hit enemies. Kept as one loop
      // so future projectile kinds only need a new branch here, not a new caller.
      if (projectile.source === 'enemy') {
        for (const player of this.players.values()) {
          if (player.downed || player.spectator || !player.connected || this.invinciblePlayers.has(player.id)) continue;
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
          const owner = this.players.get(projectile.ownerId);
          if (owner) owner.damageDealt += projectile.damage;
          const died = combat.damageEnemy(
            enemy,
            ENEMY_KIND_BY_TYPE[enemy.type],
            ENEMY_DEFS[enemy.type].flyDrop,
            projectile.damage,
            (event) => this.emit(event),
            (x, y, count) => spawnFliesAt(this.nextFlyId, x, y, count, this.flies),
          );
          if (died) {
            if (owner) owner.killCount += 1;
            this.enemies.delete(enemy.id);
          }
          this.projectiles.delete(projectile.id);
          break;
        }
      }
    }
  }

  private broadcastSnapshot(): void {
    // Lobby has no combat, and disconnected (reconnect-grace) players' frogs
    // are despawned from every client's view (T11) — both are cheap wins on
    // snapshot payload size and keep the wire format honest about what's
    // actually "there".
    const isLobby = this.phase === 'lobby';
    const msg: ServerMsg = {
      type: 'snapshot',
      tick: this.tick,
      phase: this.phase,
      ...(this.wave > 0 ? { wave: this.wave } : {}),
      ...(this.phaseRemainingSec !== undefined ? { phaseEndsAt: Date.now() + this.phaseRemainingSec * 1000 } : {}),
      players: Array.from(this.players.values())
        .filter((p) => p.connected)
        .map(toPlayerSnap),
      enemies: isLobby ? [] : Array.from(this.enemies.values(), toEnemySnap),
      projectiles: isLobby ? [] : Array.from(this.projectiles.values(), toProjectileSnap),
      flies: isLobby ? [] : Array.from(this.flies.values(), toFlySnap),
    };
    this.callbacks.broadcast(msg);
  }
}
