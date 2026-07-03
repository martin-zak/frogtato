// Game scene: renders the pond arena and every player, purely from
// server snapshots (via the interp utility). Sends WASD/arrow input at
// INPUT_HZ (and immediately on change). No gameplay rules live here.

import Phaser from "phaser";
import { ARENA, INPUT_HZ, INTERP_DELAY_MS } from "@frogtato/shared";
import { interpolateSnapshot } from "../interp.js";
import type { NetClient } from "../net.js";
import { EntityRenderer } from "../render/entities.js";
import { EffectsController } from "../render/effects.js";

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const SAME_STATE = (a: InputState, b: InputState): boolean =>
  a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right;

export class GameScene extends Phaser.Scene {
  private net!: NetClient;

  private arenaGfx!: Phaser.GameObjects.Graphics;
  private followTarget!: Phaser.GameObjects.Rectangle;

  private entityRenderer!: EntityRenderer;
  private effects!: EffectsController;
  private unsubscribeEvents: (() => void) | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };

  private seq = 0;
  private lastSent: InputState = { up: false, down: false, left: false, right: false };
  private sendAccumMs = 0;
  private lastOwnFlies: number | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.seq = 0;
    this.lastSent = { up: false, down: false, left: false, right: false };
    this.sendAccumMs = 0;
    this.lastOwnFlies = null;

    this.cameras.main.setBackgroundColor("#0a1a12");

    this.arenaGfx = this.add.graphics();
    this.drawArena();

    this.entityRenderer = new EntityRenderer(this);
    this.effects = new EffectsController(this, this.entityRenderer);
    this.unsubscribeEvents = this.net.onEvent((event) => {
      const renderTime = Date.now() - INTERP_DELAY_MS;
      const state = interpolateSnapshot(this.net.getSnapshots(), renderTime);
      this.effects.handleEvent(event, state.players);
    });

    this.followTarget = this.add.rectangle(ARENA.width / 2, ARENA.height / 2, 1, 1, 0x000000, 0);
    this.cameras.main.setBounds(0, 0, ARENA.width, ARENA.height);
    this.cameras.main.startFollow(this.followTarget, true, 0.15, 0.15);
    this.cameras.main.setZoom(0.75);

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys("W,A,S,D") as typeof this.wasd;
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = null;
      this.entityRenderer.destroy();
    });
  }

  update(_time: number, delta: number): void {
    this.handleInput(delta);
    this.render(delta);
  }

  private readInputState(): InputState {
    const up = Boolean(this.cursors?.up.isDown || this.wasd?.W.isDown);
    const down = Boolean(this.cursors?.down.isDown || this.wasd?.S.isDown);
    const left = Boolean(this.cursors?.left.isDown || this.wasd?.A.isDown);
    const right = Boolean(this.cursors?.right.isDown || this.wasd?.D.isDown);
    return { up, down, left, right };
  }

  private handleInput(delta: number): void {
    const state = this.readInputState();
    const changed = !SAME_STATE(state, this.lastSent);
    this.sendAccumMs += delta;
    const intervalMs = 1000 / INPUT_HZ;

    if (changed || this.sendAccumMs >= intervalMs) {
      this.seq += 1;
      this.net.send({ type: "input", seq: this.seq, ...state });
      this.lastSent = state;
      this.sendAccumMs = 0;
    }
  }

  private render(deltaMs: number): void {
    const renderTime = Date.now() - INTERP_DELAY_MS;
    const state = interpolateSnapshot(this.net.getSnapshots(), renderTime);

    const ownPlayer = state.players.find((p) => p.id === this.net.playerId);
    if (ownPlayer) {
      this.followTarget.setPosition(ownPlayer.x, ownPlayer.y);

      // Pure client-side bookkeeping (not a gameplay rule): detect the
      // local player's fly count going up between snapshots to trigger the
      // pickup SFX, since there's no dedicated `pickup` GameEvent.
      if (this.lastOwnFlies !== null && ownPlayer.flies > this.lastOwnFlies) {
        this.effects.playPickupSfx();
      }
      this.lastOwnFlies = ownPlayer.flies;
    }

    this.entityRenderer.update(state, this.net.playerId, deltaMs);
  }

  private drawArena(): void {
    const g = this.arenaGfx;
    g.clear();

    const cx = ARENA.width / 2;
    const cy = ARENA.height / 2;
    const rx = ARENA.width / 2;
    const ry = ARENA.height / 2;

    // Dark surroundings, lighter pond ellipse. Pad well past the arena
    // bounds so panning near the edge never reveals an unpainted void.
    const pad = 800;
    g.fillStyle(0x0a1a12, 1);
    g.fillRect(-pad, -pad, ARENA.width + pad * 2, ARENA.height + pad * 2);

    g.fillStyle(0x1b4d3e, 1);
    g.fillEllipse(cx, cy, rx * 2, ry * 2);

    g.lineStyle(6, 0x2e7d5b, 1);
    g.strokeEllipse(cx, cy, rx * 2, ry * 2);
  }
}
