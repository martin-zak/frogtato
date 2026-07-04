// Game scene: renders the pond arena and every player, purely from
// server snapshots (via the interp utility). Sends WASD/arrow input at
// INPUT_HZ (and immediately on change). No gameplay rules live here.

import Phaser from "phaser";
import { ARENA, INPUT_HZ, INTERP_DELAY_MS } from "@frogtato/shared";
import { interpolateSnapshot } from "../interp.js";
import type { NetClient } from "../net.js";
import { EntityRenderer } from "../render/entities.js";
import { EffectsController } from "../render/effects.js";
import { SPRITE_KEYS } from "../render/assetKeys.js";
import { Hud } from "../ui/hud.js";
import { AllyIndicators } from "../ui/allyIndicators.js";
import { routeToPhase } from "../ui/phaseRouter.js";
import { captureEndScreenEvent } from "../ui/endScreenStore.js";

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const SAME_STATE = (a: InputState, b: InputState): boolean =>
  a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right;

/** Depth for the static pond decoration — below every entity sprite
 * (players/enemies/projectiles/flies all render at the default depth 0),
 * so lilypads always sit under gameplay regardless of add-order. */
const LILYPAD_DEPTH = -1;

/** Pure decoration: a hand-picked, deterministic scatter of lily pads
 * inside the pond ellipse (see drawArena — cx=800,cy=600,rx=800,ry=600, so
 * every point below is well within (dx/rx)^2+(dy/ry)^2 < 1). Cycles the 3
 * lilypad art variants and varies rotation/scale a little by hand for a
 * natural, non-repeating look — no randomness, so the layout is stable
 * across reloads. */
const LILYPAD_LAYOUT: ReadonlyArray<{ x: number; y: number; key: string; size: number; rotationDeg: number }> = [
  { x: 500, y: 400, key: SPRITE_KEYS.lilypad, size: 80, rotationDeg: 15 },
  { x: 1100, y: 380, key: SPRITE_KEYS.lilypad2, size: 70, rotationDeg: 100 },
  { x: 650, y: 750, key: SPRITE_KEYS.lilypad3, size: 90, rotationDeg: 200 },
  { x: 950, y: 800, key: SPRITE_KEYS.lilypad, size: 75, rotationDeg: 260 },
  { x: 760, y: 560, key: SPRITE_KEYS.lilypad2, size: 60, rotationDeg: 40 },
  { x: 400, y: 650, key: SPRITE_KEYS.lilypad3, size: 85, rotationDeg: 320 },
  { x: 1200, y: 650, key: SPRITE_KEYS.lilypad, size: 78, rotationDeg: 160 },
  { x: 800, y: 900, key: SPRITE_KEYS.lilypad2, size: 68, rotationDeg: 60 },
];

export class GameScene extends Phaser.Scene {
  private net!: NetClient;

  private arenaGfx!: Phaser.GameObjects.Graphics;
  private followTarget!: Phaser.GameObjects.Rectangle;

  private entityRenderer!: EntityRenderer;
  private effects!: EffectsController;
  private hud!: Hud;
  private allyIndicators!: AllyIndicators;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribePhase: (() => void) | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };

  private lastSent: InputState = { up: false, down: false, left: false, right: false };
  private sendAccumMs = 0;
  private lastOwnFlies: number | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.lastSent = { up: false, down: false, left: false, right: false };
    this.sendAccumMs = 0;
    this.lastOwnFlies = null;

    this.cameras.main.setBackgroundColor("#0a1a12");

    this.arenaGfx = this.add.graphics().setDepth(LILYPAD_DEPTH - 1); // below lilypads, which are below entities
    this.drawArena();
    this.drawLilypads();

    this.entityRenderer = new EntityRenderer(this);
    this.effects = new EffectsController(this, this.entityRenderer, this.net);
    this.hud = new Hud(this, this.net);
    this.allyIndicators = new AllyIndicators(this);
    this.unsubscribeEvents = this.net.onEvent((event) => {
      const renderTime = Date.now() - INTERP_DELAY_MS;
      const state = interpolateSnapshot(this.net.getSnapshots(), renderTime);
      this.effects.handleEvent(event, state.players);
      // gameOver/victory fire while this scene is still active (the
      // server flips phase to "scoreboard" only on the *next* snapshot);
      // capture it here so GameOverScene has the scoreboard once phase
      // routing lands there a moment later.
      captureEndScreenEvent(event);
    });

    this.unsubscribePhase = this.net.onSnapshot((snap) => routeToPhase(this, snap.phase));

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
      this.unsubscribePhase?.();
      this.unsubscribePhase = null;
      this.entityRenderer.destroy();
      this.hud.destroy();
      this.allyIndicators.destroy();
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
      // Seq lives on the NetClient, not this scene: a recreated GameScene
      // (rematch) restarting from 0 would look stale to the server.
      this.net.send({ type: "input", seq: this.net.nextInputSeq(), ...state });
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
    this.hud.update();
    this.allyIndicators.update(state.players, this.net.playerId);
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

  /** Static, non-interactive lily pad scatter — pure decoration, drawn
   * once and never touched again. See LILYPAD_LAYOUT for the fixed
   * positions/variants. */
  private drawLilypads(): void {
    for (const pad of LILYPAD_LAYOUT) {
      this.add
        .sprite(pad.x, pad.y, pad.key)
        .setDisplaySize(pad.size, pad.size)
        .setAngle(pad.rotationDeg)
        .setDepth(LILYPAD_DEPTH);
    }
  }
}
