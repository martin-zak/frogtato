// Per-frame entity rendering: turns the interpolated snapshot state into
// pooled Phaser GameObjects. Renders exactly what the snapshot says — no
// gameplay rules live here.
//
// `diffEntities` is a pure function (no Phaser) so it's unit-testable in
// isolation; `EntityRenderer` is the Phaser-aware wrapper that calls it once
// per entity category each frame and creates/updates/destroys sprites.

import Phaser from "phaser";
import {
  PLAYER_COLORS,
  PLAYER_COLOR_ORDER,
} from "@frogtato/shared";
import type { PlayerSnap, EnemySnap, ProjectileSnap, FlySnap, EnemyKind, ProjectileKind } from "@frogtato/shared";
import type { InterpolatedState } from "../interp.js";
import { SPRITE_KEYS, SFX_KEYS, WASP_FRAME, SNAIL_FRAME, HERON_FRAME, SNAILKING_SCALE } from "./assetKeys.js";
import { diffEntities } from "./diff.js";
import { displayName } from "../ui/nameField.js";

export type { EntityDiff } from "./diff.js";
export { diffEntities } from "./diff.js";

// ---------------------------------------------------------------------------
// Shared color helper (moved here from GameScene so entities.ts and
// GameScene both use the same implementation).
// ---------------------------------------------------------------------------

export function colorHexInt(colorIndex: number): number {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return Phaser.Display.Color.HexStringToColor(PLAYER_COLORS[name]).color;
}

const DOWNED_ALPHA = 0.5;
const FROG_DISPLAY_SIZE = 46; // px diameter, close to the old FROG_RADIUS*2 (44) circle placeholder
const ENEMY_FRAME_TOGGLE_MS = 200;

const HP_BAR_WIDTH = 40;
const HP_BAR_HEIGHT = 5;
const HP_BAR_OFFSET_Y = FROG_DISPLAY_SIZE / 2 + 14;
const FLY_LABEL_OFFSET_Y = HP_BAR_OFFSET_Y + 12;
/** Name label sits just above the fly-count label (Phase 2 §5). */
const NAME_LABEL_OFFSET_Y = FLY_LABEL_OFFSET_Y + 14;

const ENEMY_HP_BAR_WIDTH = 28;
const ENEMY_HP_BAR_HEIGHT = 4;
/** Snail King boss HP bar (Phase 2 §4/P5): wider than a regular enemy's so
 * the finale's health is readable at its much larger display size. */
const BOSS_HP_BAR_WIDTH = 110;
const BOSS_HP_BAR_HEIGHT = 8;

/** Snail King shell-phase tint (Phase 2 §4): darker while shelled (Armor 5,
 * "visibly tucked in") — multiplied against the sprite's normal color. */
const SHELLED_TINT = 0x6b6b6b;
const NORMAL_TINT = 0xffffff;
/** Slight scale squash while shelled, on top of the ×3 boss scale. */
const SHELLED_SCALE_MULT = 0.9;

/** Telegraph danger-line style (Phase 2 §4/P5: heron dive-swoop warning). */
const TELEGRAPH_COLOR = 0xff3b30;
const TELEGRAPH_WIDTH = 3;
const TELEGRAPH_PULSE_HZ = 4; // full fade cycles per second, purely cosmetic

interface PlayerEntry {
  sprite: Phaser.GameObjects.Sprite;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
  flyLabel: Phaser.GameObjects.Text;
  nameLabel: Phaser.GameObjects.Text;
}

interface EnemyEntry {
  sprite: Phaser.GameObjects.Sprite;
  kind: EnemyKind;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
  /** Snail King only: the crown accent sprite drawn above the boss body. */
  crown?: Phaser.GameObjects.Sprite;
  /** Heron only: fading danger line drawn along EnemySnap.telegraph while
   * present. Created lazily on first telegraph, reused/hidden afterward. */
  telegraphLine?: Phaser.GameObjects.Graphics;
  /** Tracks whether `telegraph` was present on the *previous* applyEnemy
   * call, so the warning SFX plays exactly once per telegraph appearance
   * (on the false -> true transition), not once per snapshot. */
  wasTelegraphing: boolean;
}

interface SimpleEntry {
  sprite: Phaser.GameObjects.Sprite;
}

// Heron gets its own 2-frame sprite sheet; the Snail King boss reuses the
// snail texture/frames at a much larger display size plus a crown overlay
// (see applyEnemy) rather than a distinct texture.
const ENEMY_TEXTURE: Readonly<Record<EnemyKind, string>> = {
  wasp: SPRITE_KEYS.wasp,
  snail: SPRITE_KEYS.snail,
  heron: SPRITE_KEYS.heron,
  snailking: SPRITE_KEYS.snail,
};

const ENEMY_FRAME_SIZE: Readonly<Record<EnemyKind, { width: number; height: number }>> = {
  wasp: WASP_FRAME,
  snail: SNAIL_FRAME,
  heron: HERON_FRAME,
  snailking: { width: SNAIL_FRAME.width * SNAILKING_SCALE, height: SNAIL_FRAME.height * SNAILKING_SCALE },
};

function enemyHpBarSize(kind: EnemyKind): { width: number; height: number } {
  return kind === "snailking"
    ? { width: BOSS_HP_BAR_WIDTH, height: BOSS_HP_BAR_HEIGHT }
    : { width: ENEMY_HP_BAR_WIDTH, height: ENEMY_HP_BAR_HEIGHT };
}

const PROJECTILE_TEXTURE: Readonly<Record<ProjectileKind, string>> = {
  acid: SPRITE_KEYS.acidGlob,
  bubble: SPRITE_KEYS.bubble,
};

export class EntityRenderer {
  private scene: Phaser.Scene;

  private players = new Map<string, PlayerEntry>();
  private enemies = new Map<string, EnemyEntry>();
  private projectiles = new Map<string, SimpleEntry>();
  private flies = new Map<string, SimpleEntry>();

  private warnedKinds = new Set<string>();

  private enemyFrameToggleAccumMs = 0;
  private enemyFrame = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Called once per render frame with the interpolated state and the
   * local player's id (used only to decide nothing special here — kept for
   * parity/future use, e.g. highlighting own frog). */
  update(state: InterpolatedState, _localPlayerId: string | null, deltaMs: number): void {
    this.enemyFrameToggleAccumMs += deltaMs;
    if (this.enemyFrameToggleAccumMs >= ENEMY_FRAME_TOGGLE_MS) {
      this.enemyFrameToggleAccumMs = 0;
      this.enemyFrame = this.enemyFrame === 0 ? 1 : 0;
    }

    this.updatePlayers(state.players);
    this.updateEnemies(state.enemies);
    this.updateProjectiles(state.projectiles);
    this.updateFlies(state.flies);
  }

  getPlayerSprite(playerId: string): Phaser.GameObjects.Sprite | undefined {
    return this.players.get(playerId)?.sprite;
  }

  destroy(): void {
    for (const entry of this.players.values()) {
      entry.sprite.destroy();
      entry.hpBarBg.destroy();
      entry.hpBarFill.destroy();
      entry.flyLabel.destroy();
      entry.nameLabel.destroy();
    }
    for (const entry of this.enemies.values()) {
      entry.sprite.destroy();
      entry.hpBarBg.destroy();
      entry.hpBarFill.destroy();
      entry.crown?.destroy();
      entry.telegraphLine?.destroy();
    }
    for (const entry of this.projectiles.values()) entry.sprite.destroy();
    for (const entry of this.flies.values()) entry.sprite.destroy();
    this.players.clear();
    this.enemies.clear();
    this.projectiles.clear();
    this.flies.clear();
  }

  // -- players ---------------------------------------------------------

  private updatePlayers(snaps: readonly PlayerSnap[]): void {
    const diff = diffEntities(new Set(this.players.keys()), snaps);

    for (const id of diff.destroy) {
      const entry = this.players.get(id);
      if (!entry) continue;
      entry.sprite.destroy();
      entry.hpBarBg.destroy();
      entry.hpBarFill.destroy();
      entry.flyLabel.destroy();
      entry.nameLabel.destroy();
      this.players.delete(id);
    }

    for (const snap of diff.create) {
      const sprite = this.scene.add.sprite(snap.x, snap.y, SPRITE_KEYS.frog);
      sprite.setDisplaySize(FROG_DISPLAY_SIZE, FROG_DISPLAY_SIZE);
      const hpBarBg = this.scene.add.rectangle(snap.x, snap.y - HP_BAR_OFFSET_Y, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x2a0a0a);
      const hpBarFill = this.scene.add.rectangle(
        snap.x - HP_BAR_WIDTH / 2,
        snap.y - HP_BAR_OFFSET_Y,
        HP_BAR_WIDTH,
        HP_BAR_HEIGHT,
        0x4caf50,
      );
      hpBarFill.setOrigin(0, 0.5);
      const flyLabel = this.scene.add
        .text(snap.x, snap.y - FLY_LABEL_OFFSET_Y, "0", {
          fontFamily: "sans-serif",
          fontSize: "12px",
          color: "#fff9c4",
        })
        .setOrigin(0.5);
      const nameLabel = this.scene.add
        .text(snap.x, snap.y - NAME_LABEL_OFFSET_Y, "", {
          fontFamily: "sans-serif",
          fontSize: "12px",
          fontStyle: "bold",
          color: "#e8f5e9",
        })
        .setOrigin(0.5);
      this.players.set(snap.id, { sprite, hpBarBg, hpBarFill, flyLabel, nameLabel });
    }

    for (const snap of [...diff.create, ...diff.update]) {
      const entry = this.players.get(snap.id);
      if (!entry) continue;
      // Index within the current snapshot's player order, used only for the
      // "Frog N" fallback (see ui/nameField.ts's displayName).
      const index = snaps.indexOf(snap);
      this.applyPlayer(entry, snap, index);
    }
  }

  private applyPlayer(entry: PlayerEntry, snap: PlayerSnap, index: number): void {
    entry.sprite.setPosition(snap.x, snap.y);
    entry.sprite.setTint(colorHexInt(snap.color));
    entry.sprite.setAlpha(snap.downed ? DOWNED_ALPHA : 1);

    entry.hpBarBg.setPosition(snap.x, snap.y - HP_BAR_OFFSET_Y);
    entry.hpBarFill.setPosition(snap.x - HP_BAR_WIDTH / 2, snap.y - HP_BAR_OFFSET_Y);
    const hpPct = snap.maxHp > 0 ? Phaser.Math.Clamp(snap.hp / snap.maxHp, 0, 1) : 0;
    entry.hpBarFill.width = HP_BAR_WIDTH * hpPct;

    entry.flyLabel.setPosition(snap.x, snap.y - FLY_LABEL_OFFSET_Y);
    entry.flyLabel.setText(`${snap.flies} 🪰`.trim());

    entry.nameLabel.setPosition(snap.x, snap.y - NAME_LABEL_OFFSET_Y);
    entry.nameLabel.setText(displayName(snap, index));
  }

  // -- enemies -----------------------------------------------------------

  private updateEnemies(snaps: readonly EnemySnap[]): void {
    const diff = diffEntities(new Set(this.enemies.keys()), snaps);

    for (const id of diff.destroy) {
      const entry = this.enemies.get(id);
      if (!entry) continue;
      entry.sprite.destroy();
      entry.hpBarBg.destroy();
      entry.hpBarFill.destroy();
      entry.crown?.destroy();
      entry.telegraphLine?.destroy();
      this.enemies.delete(id);
    }

    for (const snap of diff.create) {
      const texture = ENEMY_TEXTURE[snap.kind];
      if (!texture) {
        this.warnUnknownKind("enemy", snap.kind);
        continue;
      }
      const frameSize = ENEMY_FRAME_SIZE[snap.kind];
      const sprite = this.scene.add.sprite(snap.x, snap.y, texture, 0);
      sprite.setDisplaySize(frameSize.width, frameSize.height);
      const hpBarSize = enemyHpBarSize(snap.kind);
      const hpBarBg = this.scene.add.rectangle(
        snap.x,
        snap.y - frameSize.height / 2 - 8,
        hpBarSize.width,
        hpBarSize.height,
        0x2a0a0a,
      );
      const hpBarFill = this.scene.add.rectangle(
        snap.x - hpBarSize.width / 2,
        snap.y - frameSize.height / 2 - 8,
        hpBarSize.width,
        hpBarSize.height,
        0xe53935,
      );
      hpBarFill.setOrigin(0, 0.5);
      hpBarBg.setVisible(false);
      hpBarFill.setVisible(false);

      // Snail King boss (Phase 2 §4/P5): crown accent drawn above the ×3
      // scaled snail body, marking it as the finale enemy.
      const crown =
        snap.kind === "snailking"
          ? this.scene.add.sprite(snap.x, snap.y - frameSize.height / 2 - 2, SPRITE_KEYS.crown)
          : undefined;

      this.enemies.set(snap.id, { sprite, kind: snap.kind, hpBarBg, hpBarFill, crown, wasTelegraphing: false });
    }

    for (const snap of [...diff.create, ...diff.update]) {
      const entry = this.enemies.get(snap.id);
      if (!entry) continue;
      this.applyEnemy(entry, snap);
    }
  }

  private applyEnemy(entry: EnemyEntry, snap: EnemySnap): void {
    entry.sprite.setPosition(snap.x, snap.y);
    entry.sprite.setFrame(this.enemyFrame);

    const frameSize = ENEMY_FRAME_SIZE[entry.kind];
    const hpBarSize = enemyHpBarSize(entry.kind);
    const barY = snap.y - frameSize.height / 2 - 8;
    entry.hpBarBg.setPosition(snap.x, barY);
    entry.hpBarFill.setPosition(snap.x - hpBarSize.width / 2, barY);

    const damaged = snap.hp < snap.maxHp;
    entry.hpBarBg.setVisible(damaged);
    entry.hpBarFill.setVisible(damaged);
    if (damaged) {
      const hpPct = snap.maxHp > 0 ? Phaser.Math.Clamp(snap.hp / snap.maxHp, 0, 1) : 0;
      entry.hpBarFill.width = hpBarSize.width * hpPct;
    }

    // Snail King shell phase (Phase 2 §4): darker tint + a slight scale
    // squash (flattened, "tucked in") while `shelled`, on top of the boss's
    // normal ×3 display size.
    if (entry.kind === "snailking") {
      const shelled = snap.shelled === true;
      entry.sprite.setTint(shelled ? SHELLED_TINT : NORMAL_TINT);
      const displayHeight = shelled ? frameSize.height * SHELLED_SCALE_MULT : frameSize.height;
      const displayWidth = shelled ? frameSize.width * (1 / SHELLED_SCALE_MULT) : frameSize.width;
      entry.sprite.setDisplaySize(displayWidth, displayHeight);
      entry.crown?.setPosition(snap.x, snap.y - displayHeight / 2 - 2);
    }

    this.applyTelegraph(entry, snap);
  }

  /** Heron dive-swoop warning (Phase 2 §4): draws a fading danger line along
   * EnemySnap.telegraph while it's present, and plays the telegraph SFX
   * exactly once per appearance (on the "just started telegraphing"
   * transition), keyed off `entry.wasTelegraphing` per enemy id. */
  private applyTelegraph(entry: EnemyEntry, snap: EnemySnap): void {
    const telegraph = snap.telegraph;

    if (!telegraph) {
      entry.telegraphLine?.setVisible(false);
      entry.wasTelegraphing = false;
      return;
    }

    if (!entry.telegraphLine) {
      entry.telegraphLine = this.scene.add.graphics();
    }

    if (!entry.wasTelegraphing) {
      this.playSfxOnce(SFX_KEYS.telegraph);
    }
    entry.wasTelegraphing = true;

    const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.scene.time.now * (TELEGRAPH_PULSE_HZ * 2 * Math.PI) / 1000));
    const line = entry.telegraphLine;
    line.clear();
    line.setVisible(true);
    line.lineStyle(TELEGRAPH_WIDTH, TELEGRAPH_COLOR, pulse);
    line.beginPath();
    line.moveTo(telegraph.x1, telegraph.y1);
    line.lineTo(telegraph.x2, telegraph.y2);
    line.strokePath();
  }

  private playSfxOnce(key: string): void {
    if (this.scene.sound.locked) return;
    this.scene.sound.play(key);
  }

  // -- projectiles ---------------------------------------------------------

  private updateProjectiles(snaps: readonly ProjectileSnap[]): void {
    const diff = diffEntities(new Set(this.projectiles.keys()), snaps);

    for (const id of diff.destroy) {
      const entry = this.projectiles.get(id);
      if (!entry) continue;
      entry.sprite.destroy();
      this.projectiles.delete(id);
    }

    for (const snap of diff.create) {
      const texture = PROJECTILE_TEXTURE[snap.kind];
      if (!texture) {
        this.warnUnknownKind("projectile", snap.kind);
        continue;
      }
      const sprite = this.scene.add.sprite(snap.x, snap.y, texture);
      this.projectiles.set(snap.id, { sprite });
    }

    for (const snap of [...diff.create, ...diff.update]) {
      const entry = this.projectiles.get(snap.id);
      if (!entry) continue;
      entry.sprite.setPosition(snap.x, snap.y);
    }
  }

  // -- flies ---------------------------------------------------------

  private updateFlies(snaps: readonly FlySnap[]): void {
    const diff = diffEntities(new Set(this.flies.keys()), snaps);

    for (const id of diff.destroy) {
      const entry = this.flies.get(id);
      if (!entry) continue;
      entry.sprite.destroy();
      this.flies.delete(id);
    }

    for (const snap of diff.create) {
      const sprite = this.scene.add.sprite(snap.x, snap.y, SPRITE_KEYS.flyPickup);
      this.flies.set(snap.id, { sprite });
    }

    for (const snap of [...diff.create, ...diff.update]) {
      const entry = this.flies.get(snap.id);
      if (!entry) continue;
      entry.sprite.setPosition(snap.x, snap.y);
    }
  }

  private warnUnknownKind(category: string, kind: string): void {
    const key = `${category}:${kind}`;
    if (this.warnedKinds.has(key)) return;
    this.warnedKinds.add(key);
    console.warn(`[entities] unknown ${category} kind, not rendering: ${kind}`);
  }
}
