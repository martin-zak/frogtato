// Single Room per server process (DESIGN §8: one game room, no lobbies/matchmaking
// in v0.1). Owns the player set, the fixed-timestep sim loop, and snapshot
// broadcasting. Phase is hardcoded to "wave" for T3 — the phase machine (lobby/shop/
// scoreboard transitions) is T8's job; this just needs frogs to move.

import {
  MAX_PLAYERS,
  PLAYER_COLOR_ORDER,
  SIM_HZ,
  SNAPSHOT_HZ,
  type ClientMsg,
  type EnemySnap,
  type FlySnap,
  type Phase,
  type ProjectileSnap,
  type ServerMsg,
} from '@frogtato/shared';
import { applyInput, createPlayer, stepPlayerMovement, toPlayerSnap, type PlayerState } from './sim/players.js';

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
      // "start" / "buy" / "ready" / "debug": no phase machine, shop, or debug hooks
      // exist yet (T8/T9). Valid-but-not-yet-implemented messages are ignored quietly
      // rather than treated as protocol errors.
      default:
        break;
    }
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

    this.snapshotAccumulatorTicks += 1;
    if (this.snapshotAccumulatorTicks >= TICKS_PER_SNAPSHOT) {
      this.snapshotAccumulatorTicks -= TICKS_PER_SNAPSHOT;
      this.broadcastSnapshot();
    }
  }

  private broadcastSnapshot(): void {
    // Enemies/projectiles/flies don't exist until T5 — always empty for now.
    const enemies: EnemySnap[] = [];
    const projectiles: ProjectileSnap[] = [];
    const flies: FlySnap[] = [];
    const msg: ServerMsg = {
      type: 'snapshot',
      tick: this.tick,
      phase: this.phase,
      players: Array.from(this.players.values(), toPlayerSnap),
      enemies,
      projectiles,
      flies,
    };
    this.callbacks.broadcast(msg);
  }
}
