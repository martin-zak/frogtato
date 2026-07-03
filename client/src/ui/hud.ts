// In-Game HUD: screen-fixed (scroll factor 0) overlay showing wave +
// countdown, own HP bar, fly count, and the 2 weapon slot boxes with a
// cooldown sweep. Pure rendering of server-sent state — no gameplay rules
// (see hudMath.ts for the pure math this leans on).

import Phaser from "phaser";
import { WEAPON_DEFS, WEAPON_SLOT_COUNT } from "@frogtato/shared";
import type { WeaponKind, WeaponType, WeaponLevel, PlayerSnap } from "@frogtato/shared";
import type { NetClient } from "../net.js";
import { computeRemainingSec, formatCountdown, cooldownSweepFraction } from "./hudMath.js";

/** WeaponKind (protocol, e.g. "croak") -> WeaponType (balance data, e.g.
 * "croakNova"). Duplicated from render/effects.ts (not exported there, and
 * render/** isn't owned by this task) rather than shared — it's 3 lines. */
const WEAPON_KIND_TO_TYPE: Readonly<Record<WeaponKind, WeaponType>> = {
  tongue: "tongueLash",
  bubble: "bubbleBlaster",
  croak: "croakNova",
};

const WEAPON_LABEL: Readonly<Record<WeaponKind, string>> = {
  tongue: "Tongue",
  bubble: "Bubble",
  croak: "Croak",
};

const HP_BAR_WIDTH = 220;
const HP_BAR_HEIGHT = 22;
const HP_BAR_MARGIN = 24;

const SLOT_BOX_SIZE = 56;
const SLOT_BOX_GAP = 10;
const SLOT_BOX_MARGIN = 24;

const DEPTH = 1000;

/** localStorage key for the persisted mute toggle (T12b). Duplicated
 * (one-line string) from scenes/BootScene.ts, which seeds the
 * SoundManager's initial `mute` from the same key before this button
 * exists — see the comment there. */
const MUTE_STORAGE_KEY = "frogtato.audioMuted";

interface SlotUi {
  box: Phaser.GameObjects.Rectangle;
  sweep: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
}

export class Hud {
  private scene: Phaser.Scene;
  private net: NetClient;

  private waveText: Phaser.GameObjects.Text;
  private countdownText: Phaser.GameObjects.Text;

  private hpBarBg: Phaser.GameObjects.Rectangle;
  private hpBarFill: Phaser.GameObjects.Rectangle;
  private hpText: Phaser.GameObjects.Text;

  private flyText: Phaser.GameObjects.Text;

  private slots: SlotUi[];

  private volumeButton: Phaser.GameObjects.Text;

  /** Last local receipt time (`Date.now()`) of an `attack` event for the
   * local player, per weapon slot — drives the cooldown sweep (the client
   * has no real cooldown state; see hudMath.ts). */
  private lastAttackAtMs: (number | null)[] = new Array(WEAPON_SLOT_COUNT).fill(null);

  private unsubscribeEvents: () => void;

  constructor(scene: Phaser.Scene, net: NetClient) {
    this.scene = scene;
    this.net = net;

    const width = scene.scale.width;
    const height = scene.scale.height;

    this.waveText = scene.add
      .text(width / 2, 16, "", {
        fontFamily: "sans-serif",
        fontSize: "20px",
        color: "#e8f5e9",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH);

    this.countdownText = scene.add
      .text(width / 2, 42, "", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#b0bec5",
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH);

    const hpY = height - HP_BAR_MARGIN - HP_BAR_HEIGHT;
    this.hpBarBg = scene.add
      .rectangle(HP_BAR_MARGIN, hpY, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x2a0a0a)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH)
      .setStrokeStyle(2, 0x000000, 0.5);
    this.hpBarFill = scene.add
      .rectangle(HP_BAR_MARGIN, hpY, HP_BAR_WIDTH, HP_BAR_HEIGHT, 0x4caf50)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH + 1);
    this.hpText = scene.add
      .text(HP_BAR_MARGIN + HP_BAR_WIDTH / 2, hpY + HP_BAR_HEIGHT / 2, "", {
        fontFamily: "sans-serif",
        fontSize: "13px",
        color: "#ffffff",
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH + 2);

    this.flyText = scene.add
      .text(HP_BAR_MARGIN, hpY - 22, "0 🪰", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#fff9c4",
      })
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH);

    this.slots = [];
    for (let i = 0; i < WEAPON_SLOT_COUNT; i++) {
      const x = width - SLOT_BOX_MARGIN - SLOT_BOX_SIZE * (WEAPON_SLOT_COUNT - i) - SLOT_BOX_GAP * (WEAPON_SLOT_COUNT - 1 - i);
      const y = height - SLOT_BOX_MARGIN - SLOT_BOX_SIZE;
      const box = scene.add
        .rectangle(x, y, SLOT_BOX_SIZE, SLOT_BOX_SIZE, 0x14201c)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH)
        .setStrokeStyle(2, 0x4caf50, 0.8);
      const sweep = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 1);
      const label = scene.add
        .text(x + SLOT_BOX_SIZE / 2, y + SLOT_BOX_SIZE / 2, "", {
          fontFamily: "sans-serif",
          fontSize: "11px",
          color: "#e8f5e9",
          align: "center",
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(DEPTH + 2);
      this.slots.push({ box, sweep, label });
    }

    this.volumeButton = scene.add
      .text(width - 16, 16, "", {
        fontFamily: "sans-serif",
        fontSize: "22px",
        color: "#e8f5e9",
        backgroundColor: "#14201c",
        padding: { x: 8, y: 4 },
      })
      .setOrigin(1, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH)
      .setInteractive({ useHandCursor: true })
      .on("pointerup", () => this.toggleMute());
    this.refreshVolumeButton();

    this.unsubscribeEvents = net.onEvent((event) => {
      if (event.type === "attack" && event.playerId === net.playerId && event.slot < this.lastAttackAtMs.length) {
        this.lastAttackAtMs[event.slot] = Date.now();
      }
    });
  }

  /** Reads directly off the net client's latest raw snapshot (not the
   * interpolated one) — the HUD shows current numeric state, not smoothed
   * positions, and needs `phaseEndsAt` which interpolateSnapshot doesn't
   * carry through. */
  update(): void {
    const latest = this.net.getLatestSnapshot();
    if (!latest) return;
    const { snapshot, recvAt } = latest;

    this.waveText.setText(snapshot.wave !== undefined ? `Wave ${snapshot.wave}` : "");
    const remaining = computeRemainingSec(snapshot.phaseEndsAt, recvAt, Date.now());
    this.countdownText.setText(formatCountdown(remaining));

    const own: PlayerSnap | undefined = snapshot.players.find((p) => p.id === this.net.playerId);
    this.updateHp(own);
    this.updateFlies(own);
    this.updateSlots(own);
  }

  private updateHp(own: PlayerSnap | undefined): void {
    const hp = own?.hp ?? 0;
    const maxHp = own?.maxHp ?? 1;
    const pct = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;
    this.hpBarFill.width = HP_BAR_WIDTH * pct;
    this.hpText.setText(own ? `${Math.ceil(hp)} / ${Math.ceil(maxHp)}` : "");
  }

  private updateFlies(own: PlayerSnap | undefined): void {
    this.flyText.setText(`${own?.flies ?? 0} 🪰`);
  }

  private updateSlots(own: PlayerSnap | undefined): void {
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const ui = this.slots[i];
      const slot = own?.weapons[i] ?? null;

      if (!slot) {
        ui.label.setText("empty");
        ui.sweep.clear();
        continue;
      }

      const level: WeaponLevel = slot.level;
      ui.label.setText(`${WEAPON_LABEL[slot.kind]}\nLv${level}`);

      const weaponType = WEAPON_KIND_TO_TYPE[slot.kind];
      const cooldownSec = WEAPON_DEFS[weaponType].levels[level].cooldownSec;
      const fraction = cooldownSweepFraction(this.lastAttackAtMs[i], now, cooldownSec);
      this.drawSweep(ui, fraction);
    }
  }

  /** Draws a radial "pie" overlay covering `fraction` of the slot box
   * (1 = just fired/fully on cooldown, 0 = ready), darkening the box until
   * the cooldown elapses. */
  private drawSweep(ui: SlotUi, fraction: number): void {
    ui.sweep.clear();
    if (fraction <= 0) return;

    const bounds = ui.box.getBounds();
    const cx = bounds.centerX;
    const cy = bounds.centerY;
    const radius = SLOT_BOX_SIZE * 0.75; // covers corners of the square box

    const startAngle = -Math.PI / 2; // 12 o'clock
    const endAngle = startAngle + Math.PI * 2 * fraction;

    ui.sweep.fillStyle(0x000000, 0.55);
    ui.sweep.slice(cx, cy, radius, startAngle, endAngle, false);
    ui.sweep.fillPath();
  }

  /** Toggles `this.sound.mute` (a global SoundManager flag — one instance
   * shared by the whole game, so this also silences/restores the T12b
   * background music started in BootScene) and persists the choice. */
  private toggleMute(): void {
    this.scene.sound.mute = !this.scene.sound.mute;
    localStorage.setItem(MUTE_STORAGE_KEY, this.scene.sound.mute ? "1" : "0");
    this.refreshVolumeButton();
  }

  private refreshVolumeButton(): void {
    this.volumeButton.setText(this.scene.sound.mute ? "\u{1F507}" : "\u{1F50A}"); // 🔇 / 🔊
  }

  destroy(): void {
    this.unsubscribeEvents();
    this.waveText.destroy();
    this.countdownText.destroy();
    this.hpBarBg.destroy();
    this.hpBarFill.destroy();
    this.hpText.destroy();
    this.flyText.destroy();
    this.volumeButton.destroy();
    for (const ui of this.slots) {
      ui.box.destroy();
      ui.sweep.destroy();
      ui.label.destroy();
    }
  }
}
