import { describe, expect, it } from "vitest";
import { clampToEdge, isOffCamera } from "./edgeIndicator.js";

describe("clampToEdge", () => {
  it("returns the center unchanged (angle 0) when the target is exactly the center", () => {
    const result = clampToEdge(100, 100, 100, 100, 100, 100, 10);
    expect(result).toEqual({ x: 100, y: 100, angle: 0 });
  });

  it("clamps a point directly to the right onto the right edge, inset by margin", () => {
    const result = clampToEdge(100, 100, 10_000, 100, 100, 100, 10);
    expect(result.x).toBeCloseTo(190); // centerX(100) + halfWidth(100) - margin(10)
    expect(result.y).toBeCloseTo(100);
    expect(result.angle).toBeCloseTo(0);
  });

  it("clamps a point directly below onto the bottom edge, inset by margin", () => {
    const result = clampToEdge(100, 100, 100, 10_000, 100, 100, 10);
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(190);
    expect(result.angle).toBeCloseTo(Math.PI / 2);
  });

  it("clamps a diagonal point to whichever edge the ray hits first", () => {
    // Far off to the upper-right, but much further right than up — should
    // hit the right edge, not the top edge.
    const result = clampToEdge(0, 0, 1000, 10, 100, 50, 0);
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(1);
  });

  it("leaves a point already inside the rect on its own ray-clamped position (not identity) — still lands on the edge", () => {
    // clampToEdge always projects to the edge along the ray, regardless of
    // whether the original point was inside; callers (AllyIndicators) are
    // responsible for only calling this for off-camera targets.
    const result = clampToEdge(0, 0, 10, 0, 100, 100, 0);
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(0);
  });
});

describe("isOffCamera", () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };

  it("is false for a point inside the rect", () => {
    expect(isOffCamera(rect, 50, 50)).toBe(false);
  });

  it("is false for a point exactly on the boundary", () => {
    expect(isOffCamera(rect, 0, 0)).toBe(false);
    expect(isOffCamera(rect, 100, 100)).toBe(false);
  });

  it("is true for a point outside on any axis", () => {
    expect(isOffCamera(rect, -1, 50)).toBe(true);
    expect(isOffCamera(rect, 101, 50)).toBe(true);
    expect(isOffCamera(rect, 50, -1)).toBe(true);
    expect(isOffCamera(rect, 50, 101)).toBe(true);
  });
});
