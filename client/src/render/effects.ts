// Event-driven one-shot combat effects: attack visuals + SFX, hit flashes,
// death poofs, downed sound, and fly-pickup SFX. Wired up once by GameScene
// via `net.onEvent`; purely reactive to server events + snapshots, no
// gameplay rules.

import Phaser from "phaser";
import { WEAPON_DEFS } from "@frogtato/shared";
import type { GameEvent, PlayerSnap, WeaponKind, WeaponType, WeaponLevel } from "@frogtato/shared";
import { SPRITE_KEYS, SFX_KEYS } from "./assetKeys.js";
import type { EntityRenderer } from "./entities.js";

const ATTACK_VISUAL_MS = 130;
const CROAK_TWEEN_MS = 350;
const HIT_FLASH_MS = 100;
const POOF_TWEEN_MS = 250;
const DEFAULT_WEAPON_LEVEL: WeaponLevel = 1;

/** WeaponKind (protocol, e.g. "croak") -> WeaponType (balance data, e.g. "croakNova"). */
const WEAPON_KIND_TO_TYPE: Readonly<Record<WeaponKind, WeaponType>> = {
  tongue: "tongueLash",
  bubble: "bubbleBlaster",
  croak: "croakNova",
};

const SFX_BY_WEAPON_KIND: Readonly<Record<WeaponKind, string>> = {
  tongue: SFX_KEYS.tongue,
  bubble: SFX_KEYS.bubble,
  croak: SFX_KEYS.croak,
};

export class EffectsController {
  private scene: Phaser.Scene;
  private entityRenderer: EntityRenderer;

  constructor(scene: Phaser.Scene, entityRenderer: EntityRenderer) {
    this.scene = scene;
    this.entityRenderer = entityRenderer;
  }

  /** Handles a single server GameEvent. `latestPlayers` is the most recent
   * interpolated player array, needed to look up the attacker's live
   * position/weapon level (the `attack` event itself doesn't carry them). */
  handleEvent(event: GameEvent, latestPlayers: readonly PlayerSnap[]): void {
    switch (event.type) {
      case "attack":
        this.handleAttack(event, latestPlayers);
        break;
      case "playerHit":
        this.handlePlayerHit(event.playerId);
        this.playSfx(SFX_KEYS.hit);
        break;
      case "enemyDied":
        this.handleEnemyDied(event.x, event.y);
        break;
      case "playerDowned":
        this.playSfx(SFX_KEYS.down);
        break;
      default:
        // waveStart/waveEnd/purchaseResult/gameOver/victory/playerJoined/
        // playerLeft have no combat-visual/SFX handling in this task.
        break;
    }
  }

  /** Call when the local player's fly count goes up between snapshots. */
  playPickupSfx(): void {
    this.playSfx(SFX_KEYS.pickup);
  }

  private handleAttack(event: Extract<GameEvent, { type: "attack" }>, players: readonly PlayerSnap[]): void {
    const attacker = players.find((p) => p.id === event.playerId);
    this.playSfx(SFX_BY_WEAPON_KIND[event.kind]);

    if (!attacker) return; // attacker not currently rendered (e.g. disconnected) — nothing to draw from

    switch (event.kind) {
      case "tongue":
        this.spawnTongue(attacker.x, attacker.y, event.targetX, event.targetY);
        break;
      case "croak": {
        const level = attacker.weapons[event.slot]?.level ?? DEFAULT_WEAPON_LEVEL;
        const weaponType = WEAPON_KIND_TO_TYPE[event.kind];
        const radius = WEAPON_DEFS[weaponType].levels[level].range;
        this.spawnCroakRing(attacker.x, attacker.y, radius);
        break;
      }
      case "bubble":
        // Per PLAN: nothing extra to draw — the projectile itself renders
        // from the snapshot via EntityRenderer. SFX already played above.
        break;
    }
  }

  private spawnTongue(fromX: number, fromY: number, targetX: number, targetY: number): void {
    const dx = targetX - fromX;
    const dy = targetY - fromY;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const angle = Math.atan2(dy, dx) - Math.PI / 2; // tongue.svg's long axis is +Y; rotate so +Y points at target

    const sprite = this.scene.add.sprite(fromX, fromY, SPRITE_KEYS.tongue);
    sprite.setOrigin(0.5, 0);
    sprite.setRotation(angle);
    sprite.setDisplaySize(8, distance);

    this.scene.time.delayedCall(ATTACK_VISUAL_MS, () => sprite.destroy());
  }

  private spawnCroakRing(x: number, y: number, radius: number): void {
    // croak-ring.svg is a 64x64 texture; scale 1.0 == 64px diameter, so the
    // target scale to match the weapon's AoE radius is (radius*2)/64.
    const startScale = 0.05;
    const endScale = (radius * 2) / 64;

    const sprite = this.scene.add.sprite(x, y, SPRITE_KEYS.croakRing);
    sprite.setScale(startScale);
    sprite.setAlpha(0.9);

    this.scene.tweens.add({
      targets: sprite,
      scale: endScale,
      alpha: 0,
      duration: CROAK_TWEEN_MS,
      ease: "Cubic.Out",
      onComplete: () => sprite.destroy(),
    });
  }

  private handlePlayerHit(playerId: string): void {
    const sprite = this.entityRenderer.getPlayerSprite(playerId);
    if (!sprite) return;

    sprite.setTintFill(0xff5252);
    this.scene.time.delayedCall(HIT_FLASH_MS, () => {
      // The sprite may have been destroyed (player left) by the time this fires.
      if (!sprite.active) return;
      sprite.clearTint();
    });
  }

  private handleEnemyDied(x: number, y: number): void {
    // Independent poof visual, decoupled from the enemy sprite's own
    // lifecycle (that sprite is destroyed by EntityRenderer once the enemy
    // disappears from the snapshot, which races with any tween we'd try to
    // run on it directly) — reuses the croak-ring texture as a small
    // expanding puff, plus the dedicated sfxPoof "death bloop" (added in
    // T12b — distinct from sfxHit, which stays damage-taken/dealt only).
    this.playSfx(SFX_KEYS.poof);
    const sprite = this.scene.add.sprite(x, y, SPRITE_KEYS.croakRing);
    sprite.setTint(0xffffff);
    sprite.setScale(0.15);
    sprite.setAlpha(0.8);

    this.scene.tweens.add({
      targets: sprite,
      scale: 0.45,
      alpha: 0,
      duration: POOF_TWEEN_MS,
      ease: "Cubic.Out",
      onComplete: () => sprite.destroy(),
    });
  }

  private playSfx(key: string): void {
    // Guard against the WebAudio autoplay/unlock policy: before the first
    // user gesture, Phaser's sound manager reports `locked === true` and
    // play() calls are unreliable/queued oddly. Simplest robust behavior:
    // just drop the sound in that case rather than building a queue.
    if (this.scene.sound.locked) return;
    this.scene.sound.play(key);
  }
}
