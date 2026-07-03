import { describe, expect, it } from "vitest";
import { interpolateEntities, findBracket, interpolateSnapshot } from "./interp.js";
import type { TimedSnapshot } from "./net.js";
import type { PlayerSnap } from "@frogtato/shared";

function makePlayer(overrides: Partial<PlayerSnap> & { id: string; x: number; y: number }): PlayerSnap {
  return {
    color: 0,
    class: "treefrog",
    hp: 20,
    maxHp: 20,
    flies: 0,
    downed: false,
    spectator: false,
    weapons: [],
    stats: { damagePct: 0, moveSpeed: 220, maxHp: 20, armor: 0, regen: 0, pickupRadius: 60 },
    ready: false,
    ...overrides,
  };
}

function makeSnapshot(recvAt: number, players: PlayerSnap[]): TimedSnapshot {
  return {
    recvAt,
    snapshot: {
      type: "snapshot",
      tick: recvAt,
      phase: "wave",
      players,
      enemies: [],
      projectiles: [],
      flies: [],
    },
  };
}

describe("interpolateEntities", () => {
  it("lerps position halfway between two bracketing entities", () => {
    const older = [makePlayer({ id: "p1", x: 0, y: 0 })];
    const newer = [makePlayer({ id: "p1", x: 100, y: 0 })];
    const [result] = interpolateEntities(older, newer, 0.5);
    expect(result.x).toBe(50);
    expect(result.y).toBe(0);
  });

  it("renders an entity present only in the newer snapshot at its own position, unlerped", () => {
    const older: PlayerSnap[] = [];
    const newer = [makePlayer({ id: "p2", x: 42, y: 7 })];
    const result = interpolateEntities(older, newer, 0.5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "p2", x: 42, y: 7 });
  });

  it("renders an entity present only in the older snapshot at its own position, unlerped", () => {
    const older = [makePlayer({ id: "p3", x: 9, y: 9 })];
    const newer: PlayerSnap[] = [];
    const result = interpolateEntities(older, newer, 0.5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "p3", x: 9, y: 9 });
  });

  it("omits an entity absent from both bracketing snapshots", () => {
    const older = [makePlayer({ id: "other", x: 0, y: 0 })];
    const newer = [makePlayer({ id: "other", x: 1, y: 1 })];
    const result = interpolateEntities(older, newer, 0.5);
    expect(result.find((e) => e.id === "missing")).toBeUndefined();
  });
});

describe("findBracket + interpolateSnapshot (full snapshot buffer)", () => {
  const buffer: TimedSnapshot[] = [
    makeSnapshot(1000, [makePlayer({ id: "p1", x: 0, y: 0 })]),
    makeSnapshot(1050, [makePlayer({ id: "p1", x: 100, y: 0 })]),
  ];

  it("position at the render time halfway between two snapshots is the lerp", () => {
    const state = interpolateSnapshot(buffer, 1025);
    const p1 = state.players.find((p) => p.id === "p1");
    expect(p1?.x).toBe(50);
  });

  it("clamps to the earliest snapshot when render time is before the buffer", () => {
    const state = interpolateSnapshot(buffer, 900);
    const p1 = state.players.find((p) => p.id === "p1");
    expect(p1?.x).toBe(0);
  });

  it("clamps to the latest snapshot when render time is after the buffer", () => {
    const state = interpolateSnapshot(buffer, 2000);
    const p1 = state.players.find((p) => p.id === "p1");
    expect(p1?.x).toBe(100);
  });

  it("returns null bracket and empty state for an empty buffer", () => {
    expect(findBracket([], 1000)).toBeNull();
    const state = interpolateSnapshot([], 1000);
    expect(state.players).toEqual([]);
  });

  it("an entity appearing only in the newer of two bracketing snapshots renders at its position", () => {
    const buf: TimedSnapshot[] = [
      makeSnapshot(1000, []),
      makeSnapshot(1050, [makePlayer({ id: "new", x: 5, y: 6 })]),
    ];
    const state = interpolateSnapshot(buf, 1025);
    expect(state.players).toHaveLength(1);
    expect(state.players[0]).toMatchObject({ id: "new", x: 5, y: 6 });
  });
});
