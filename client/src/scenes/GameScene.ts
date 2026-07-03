// Game scene: renders the pond arena and every player, purely from
// server snapshots (via the interp utility). Sends WASD/arrow input at
// INPUT_HZ (and immediately on change). No gameplay rules live here.

import Phaser from "phaser";
import { ARENA, INPUT_HZ, INTERP_DELAY_MS, PLAYER_COLORS, PLAYER_COLOR_ORDER } from "@frogtato/shared";
import type { PlayerSnap } from "@frogtato/shared";
import { interpolateSnapshot } from "../interp.js";
import type { NetClient } from "../net.js";

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const SAME_STATE = (a: InputState, b: InputState): boolean =>
  a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right;

const FROG_RADIUS = 22;

function colorHexInt(colorIndex: number): number {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return Phaser.Display.Color.HexStringToColor(PLAYER_COLORS[name]).color;
}

export class GameScene extends Phaser.Scene {
  private net!: NetClient;

  private arenaGfx!: Phaser.GameObjects.Graphics;
  private playersGfx!: Phaser.GameObjects.Graphics;
  private followTarget!: Phaser.GameObjects.Rectangle;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };

  private seq = 0;
  private lastSent: InputState = { up: false, down: false, left: false, right: false };
  private sendAccumMs = 0;

  constructor() {
    super("Game");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.seq = 0;
    this.lastSent = { up: false, down: false, left: false, right: false };
    this.sendAccumMs = 0;

    this.cameras.main.setBackgroundColor("#0a1a12");

    this.arenaGfx = this.add.graphics();
    this.drawArena();

    this.playersGfx = this.add.graphics();

    this.followTarget = this.add.rectangle(ARENA.width / 2, ARENA.height / 2, 1, 1, 0x000000, 0);
    this.cameras.main.setBounds(0, 0, ARENA.width, ARENA.height);
    this.cameras.main.startFollow(this.followTarget, true, 0.15, 0.15);
    this.cameras.main.setZoom(0.75);

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.cursors = keyboard.createCursorKeys();
      this.wasd = keyboard.addKeys("W,A,S,D") as typeof this.wasd;
    }
  }

  update(_time: number, delta: number): void {
    this.handleInput(delta);
    this.render();
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

  private render(): void {
    const renderTime = Date.now() - INTERP_DELAY_MS;
    const state = interpolateSnapshot(this.net.getSnapshots(), renderTime);

    const ownPlayer = state.players.find((p) => p.id === this.net.playerId);
    if (ownPlayer) {
      this.followTarget.setPosition(ownPlayer.x, ownPlayer.y);
    }

    this.drawPlayers(state.players);
  }

  private drawPlayers(players: PlayerSnap[]): void {
    const g = this.playersGfx;
    g.clear();

    for (const p of players) {
      const color = colorHexInt(p.color);
      const alpha = p.downed ? 0.35 : 1;

      g.fillStyle(color, alpha);
      g.fillCircle(p.x, p.y, FROG_RADIUS);
      g.lineStyle(2, 0x0a1a12, alpha);
      g.strokeCircle(p.x, p.y, FROG_RADIUS);

      // Eyes: two small white circles with black pupils near the top.
      const eyeOffsetX = FROG_RADIUS * 0.45;
      const eyeOffsetY = -FROG_RADIUS * 0.35;
      const eyeRadius = FROG_RADIUS * 0.28;
      const pupilRadius = eyeRadius * 0.45;

      for (const dir of [-1, 1]) {
        const ex = p.x + dir * eyeOffsetX;
        const ey = p.y + eyeOffsetY;
        g.fillStyle(0xffffff, alpha);
        g.fillCircle(ex, ey, eyeRadius);
        g.fillStyle(0x101418, alpha);
        g.fillCircle(ex, ey, pupilRadius);
      }
    }
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
