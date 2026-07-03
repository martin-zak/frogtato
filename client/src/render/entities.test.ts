// Unit tests for the pure `diffEntities` function only — no Phaser is
// instantiated here, per PLAN T7 ("a vitest DOM-less test that just asserts
// the scene's entity registry matches the fixture").
import { describe, it, expect } from "vitest";
import { diffEntities } from "./diff.js";
import fixtures from "../../test/fixtures/combat-snapshots.json";

interface FixtureSnapshot {
  players: { id: string }[];
  enemies: { id: string }[];
  projectiles: { id: string }[];
  flies: { id: string }[];
}

const snapshots = fixtures as FixtureSnapshot[];

/** Replays a sequence of entity arrays through `diffEntities`, tracking the
 * "known ids" set the way EntityRenderer would across frames, and returns
 * the diff produced at each step. */
function replay<T extends { id: string }>(steps: readonly T[][]): ReturnType<typeof diffEntities>[] {
  let known = new Set<string>();
  const diffs: ReturnType<typeof diffEntities>[] = [];
  for (const step of steps) {
    const diff = diffEntities(known, step);
    diffs.push(diff);
    known = new Set(step.map((e) => e.id));
  }
  return diffs;
}

describe("diffEntities", () => {
  it("creates every entity on the very first snapshot", () => {
    const diffs = replay(snapshots.map((s) => s.players));
    expect(diffs[0].create.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(diffs[0].update).toEqual([]);
    expect(diffs[0].destroy).toEqual([]);
  });

  it("treats persisting players as updates on later frames", () => {
    const diffs = replay(snapshots.map((s) => s.players));
    for (let i = 1; i < diffs.length; i++) {
      expect(diffs[i].create).toEqual([]);
      expect(diffs[i].update.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
      expect(diffs[i].destroy).toEqual([]);
    }
  });

  it("creates enemies as they first appear and destroys them once gone", () => {
    const diffs = replay(snapshots.map((s) => s.enemies));

    // Step 0: only the wasp (e1) exists.
    expect(diffs[0].create.map((e) => e.id)).toEqual(["e1"]);

    // Step 1: the snail (e2) appears; e1 persists (update).
    expect(diffs[1].create.map((e) => e.id)).toEqual(["e2"]);
    expect(diffs[1].update.map((e) => e.id)).toEqual(["e1"]);

    // Step 2: both persist (update only).
    expect(diffs[2].create).toEqual([]);
    expect(diffs[2].update.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect(diffs[2].destroy).toEqual([]);

    // Step 3: the wasp (e1) died and drops out; the snail persists.
    expect(diffs[3].create).toEqual([]);
    expect(diffs[3].update.map((e) => e.id)).toEqual(["e2"]);
    expect(diffs[3].destroy).toEqual(["e1"]);
  });

  it("creates and destroys a projectile as it appears then disappears", () => {
    const diffs = replay(snapshots.map((s) => s.projectiles));

    expect(diffs[0].create).toEqual([]); // no projectile yet
    expect(diffs[1].create.map((p) => p.id)).toEqual(["pr1"]); // appears
    expect(diffs[2].update.map((p) => p.id)).toEqual(["pr1"]); // persists
    expect(diffs[3].destroy).toEqual(["pr1"]); // disappears
  });

  it("creates and destroys flies as they appear then get collected", () => {
    const diffs = replay(snapshots.map((s) => s.flies));

    expect(diffs[0].create.map((f) => f.id)).toEqual(["f1"]);
    expect(diffs[1].create.map((f) => f.id)).toEqual(["f2"]);
    expect(diffs[1].update.map((f) => f.id)).toEqual(["f1"]);
    // f1 collected between step 1 and step 2.
    expect(diffs[2].destroy).toEqual(["f1"]);
    expect(diffs[2].update.map((f) => f.id)).toEqual(["f2"]);
    // f2 collected between step 2 and step 3.
    expect(diffs[3].destroy).toEqual(["f2"]);
    expect(diffs[3].create).toEqual([]);
    expect(diffs[3].update).toEqual([]);
  });
});
