// Ally edge-of-screen arrows (DESIGN §9: "off-screen allies get
// edge-of-screen indicator arrows"). Basic version per PLAN T10a — polish
// (nicer art, distance label, fade) is T11's job. Screen-fixed (scroll
// factor 0) overlay; geometry lives in the pure edgeIndicator.ts.

import Phaser from "phaser";
import { PLAYER_COLORS, PLAYER_COLOR_ORDER } from "@frogtato/shared";
import type { PlayerSnap } from "@frogtato/shared";
import { clampToEdge, isOffCamera } from "./edgeIndicator.js";

const ARROW_MARGIN = 28; // px inset from the screen edge
const ARROW_SIZE = 14;
const DEPTH = 999;

function colorHexInt(colorIndex: number): number {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return Phaser.Display.Color.HexStringToColor(PLAYER_COLORS[name]).color;
}

export class AllyIndicators {
  private scene: Phaser.Scene;
  private arrows = new Map<string, Phaser.GameObjects.Triangle>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** `players` should be the current (interpolated) player array; `ownId`
   * is excluded. Spectators are skipped — nothing useful to point at. */
  update(players: readonly PlayerSnap[], ownId: string | null): void {
    const camera = this.scene.cameras.main;
    const view = camera.worldView;

    const allies = players.filter((p) => p.id !== ownId && !p.spectator);
    const liveIds = new Set(allies.map((p) => p.id));

    for (const [id, arrow] of this.arrows) {
      if (!liveIds.has(id)) {
        arrow.destroy();
        this.arrows.delete(id);
      }
    }

    const width = this.scene.scale.width;
    const height = this.scene.scale.height;
    const centerX = width / 2;
    const centerY = height / 2;

    for (const ally of allies) {
      if (!isOffCamera(view, ally.x, ally.y)) {
        const existing = this.arrows.get(ally.id);
        if (existing) {
          existing.destroy();
          this.arrows.delete(ally.id);
        }
        continue;
      }

      // Project the ally's world position into screen space relative to
      // the camera center (unclamped — may lie far outside the screen
      // rect), then clamp that to the screen edge.
      const zoom = camera.zoom;
      const screenX = centerX + (ally.x - camera.midPoint.x) * zoom;
      const screenY = centerY + (ally.y - camera.midPoint.y) * zoom;
      const edge = clampToEdge(centerX, centerY, screenX, screenY, centerX, centerY, ARROW_MARGIN);

      let arrow = this.arrows.get(ally.id);
      if (!arrow) {
        arrow = this.scene.add
          .triangle(0, 0, 0, -ARROW_SIZE, ARROW_SIZE * 0.7, ARROW_SIZE, -ARROW_SIZE * 0.7, ARROW_SIZE)
          .setScrollFactor(0)
          .setDepth(DEPTH);
        this.arrows.set(ally.id, arrow);
      }
      arrow.setPosition(edge.x, edge.y);
      arrow.setRotation(edge.angle + Math.PI / 2); // triangle points +Y at rotation 0
      arrow.setFillStyle(colorHexInt(ally.color));
    }
  }

  destroy(): void {
    for (const arrow of this.arrows.values()) arrow.destroy();
    this.arrows.clear();
  }
}
