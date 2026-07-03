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
import { SPRITE_KEYS, WASP_FRAME, SNAIL_FRAME } from "./assetKeys.js";
import { diffEntities } from "./diff.js";

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

const ENEMY_HP_BAR_WIDTH = 28;
const ENEMY_HP_BAR_HEIGHT = 4;

interface PlayerEntry {
  sprite: Phaser.GameObjects.Sprite;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
  flyLabel: Phaser.GameObjects.Text;
}

interface EnemyEntry {
  sprite: Phaser.GameObjects.Sprite;
  kind: EnemyKind;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
}

interface SimpleEntry {
  sprite: Phaser.GameObjects.Sprite;
}

// Phase 2 P1 mechanical addition: heron/snailking placeholder textures
// (reusing wasp/snail art) so this Record<EnemyKind, ...> stays exhaustive
// for tsc -b. Real sprites are P5's job (client heron & boss rendering).
const ENEMY_TEXTURE: Readonly<Record<EnemyKind, string>> = {
  wasp: SPRITE_KEYS.wasp,
  snail: SPRITE_KEYS.snail,
  heron: SPRITE_KEYS.wasp,
  snailking: SPRITE_KEYS.snail,
};

const ENEMY_FRAME_SIZE: Readonly<Record<EnemyKind, { width: number; height: number }>> = {
  wasp: WASP_FRAME,
  snail: SNAIL_FRAME,
  heron: WASP_FRAME,
  snailking: SNAIL_FRAME,
};

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
    }
    for (const entry of this.enemies.values()) {
      entry.sprite.destroy();
      entry.hpBarBg.destroy();
      entry.hpBarFill.destroy();
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
      this.players.set(snap.id, { sprite, hpBarBg, hpBarFill, flyLabel });
    }

    for (const snap of [...diff.create, ...diff.update]) {
      const entry = this.players.get(snap.id);
      if (!entry) continue;
      this.applyPlayer(entry, snap);
    }
  }

  private applyPlayer(entry: PlayerEntry, snap: PlayerSnap): void {
    entry.sprite.setPosition(snap.x, snap.y);
    entry.sprite.setTint(colorHexInt(snap.color));
    entry.sprite.setAlpha(snap.downed ? DOWNED_ALPHA : 1);

    entry.hpBarBg.setPosition(snap.x, snap.y - HP_BAR_OFFSET_Y);
    entry.hpBarFill.setPosition(snap.x - HP_BAR_WIDTH / 2, snap.y - HP_BAR_OFFSET_Y);
    const hpPct = snap.maxHp > 0 ? Phaser.Math.Clamp(snap.hp / snap.maxHp, 0, 1) : 0;
    entry.hpBarFill.width = HP_BAR_WIDTH * hpPct;

    entry.flyLabel.setPosition(snap.x, snap.y - FLY_LABEL_OFFSET_Y);
    entry.flyLabel.setText(`${snap.flies} 🪰`.trim());
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
      const hpBarBg = this.scene.add.rectangle(
        snap.x,
        snap.y - frameSize.height / 2 - 8,
        ENEMY_HP_BAR_WIDTH,
        ENEMY_HP_BAR_HEIGHT,
        0x2a0a0a,
      );
      const hpBarFill = this.scene.add.rectangle(
        snap.x - ENEMY_HP_BAR_WIDTH / 2,
        snap.y - frameSize.height / 2 - 8,
        ENEMY_HP_BAR_WIDTH,
        ENEMY_HP_BAR_HEIGHT,
        0xe53935,
      );
      hpBarFill.setOrigin(0, 0.5);
      hpBarBg.setVisible(false);
      hpBarFill.setVisible(false);
      this.enemies.set(snap.id, { sprite, kind: snap.kind, hpBarBg, hpBarFill });
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
    const barY = snap.y - frameSize.height / 2 - 8;
    entry.hpBarBg.setPosition(snap.x, barY);
    entry.hpBarFill.setPosition(snap.x - ENEMY_HP_BAR_WIDTH / 2, barY);

    const damaged = snap.hp < snap.maxHp;
    entry.hpBarBg.setVisible(damaged);
    entry.hpBarFill.setVisible(damaged);
    if (damaged) {
      const hpPct = snap.maxHp > 0 ? Phaser.Math.Clamp(snap.hp / snap.maxHp, 0, 1) : 0;
      entry.hpBarFill.width = ENEMY_HP_BAR_WIDTH * hpPct;
    }
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
