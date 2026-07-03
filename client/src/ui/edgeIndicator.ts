// Pure geometry for ally edge-of-screen arrows (DESIGN §9: "off-screen
// allies get edge-of-screen indicator arrows"). No Phaser import here (see
// render/diff.ts for why) — the Phaser-aware wrapper that turns this into
// arrow sprites lives in allyIndicators.ts. Basic version per PLAN T10a
// (polish pass is T11).

export interface EdgeArrow {
  x: number;
  y: number;
  /** Radians; direction from `centerX/Y` toward the (possibly off-rect)
   * target point. Use directly as a sprite rotation for an arrow whose art
   * points along +X at rotation 0. */
  angle: number;
}

/**
 * Clamps a point that may lie outside a centered rectangle (`2*halfWidth` x
 * `2*halfHeight`, inset by `margin`) to the rectangle's edge, along the ray
 * from the rectangle's center toward the point. Coordinates are all in the
 * same space (e.g. screen pixels, with `centerX/Y` = screen center);
 * `targetX/Y` is the point's *unclamped* position in that space and may lie
 * far outside the rectangle.
 */
export function clampToEdge(
  centerX: number,
  centerY: number,
  targetX: number,
  targetY: number,
  halfWidth: number,
  halfHeight: number,
  margin: number,
): EdgeArrow {
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  if (dx === 0 && dy === 0) {
    return { x: centerX, y: centerY, angle: 0 };
  }
  const angle = Math.atan2(dy, dx);
  const maxX = Math.max(0, halfWidth - margin);
  const maxY = Math.max(0, halfHeight - margin);
  const scaleX = dx !== 0 ? maxX / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? maxY / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale, angle };
}

/** Duck-typed world-space view rect (matches the shape of a Phaser
 * camera's `.worldView`), kept structural so this file stays Phaser-free. */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True if the world point falls outside the given world-space view rect. */
export function isOffCamera(rect: WorldRect, worldX: number, worldY: number): boolean {
  return worldX < rect.x || worldX > rect.x + rect.width || worldY < rect.y || worldY > rect.y + rect.height;
}
