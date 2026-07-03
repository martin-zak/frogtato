// Unit tests for the pure `diffEntities` function only — no Phaser is
// instantiated here, per PLAN T7 ("a vitest DOM-less test that just asserts
// the scene's entity registry matches the fixture").
import { describe, it, expect } from "vitest";
import { diffEntities, type EntityDiff } from "./diff.js";
import fixtures from "../../test/fixtures/combat-snapshots.json";
import bossHeronFixtures from "../../test/fixtures/boss-heron-snapshots.json";

interface FixtureSnapshot {
  players: { id: string }[];
  enemies: { id: string }[];
  projectiles: { id: string }[];
  flies: { id: string }[];
}

interface EnemyFixtureSnap {
  id: string;
  kind: string;
  telegraph?: { x1: number; y1: number; x2: number; y2: number };
  shelled?: boolean;
}

interface BossHeronFixtureSnapshot {
  enemies: EnemyFixtureSnap[];
}

const snapshots = fixtures as FixtureSnapshot[];
const bossHeronSnapshots = bossHeronFixtures as BossHeronFixtureSnapshot[];

/** Replays a sequence of entity arrays through `diffEntities`, tracking the
 * "known ids" set the way EntityRenderer would across frames, and returns
 * the diff produced at each step. */
function replay<T extends { id: string }>(steps: readonly T[][]): EntityDiff<T>[] {
  let known = new Set<string>();
  const diffs: EntityDiff<T>[] = [];
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

// Phase 2 §4/P5: heron + Snail King boss render-registry fixture coverage.
// EntityRenderer itself (the Phaser-aware wrapper that actually draws the
// telegraph line/crown/shell tint) can't be instantiated in this DOM-less
// vitest environment (see the file header + diff.ts's header for why —
// importing Phaser touches `navigator` at module load time), so this only
// exercises the pure `diffEntities` registry logic against fixtures that
// include heron/snailking kinds and the telegraph/shelled fields, same as
// the wasp/snail coverage above.
describe("diffEntities — heron + Snail King boss (Phase 2 §4)", () => {
  it("creates the heron on its first appearance and the boss once it spawns", () => {
    const diffs = replay(bossHeronSnapshots.map((s) => s.enemies));

    // Step 0: only the heron (h1) exists yet, no telegraph.
    expect(diffs[0].create.map((e) => e.id)).toEqual(["h1"]);
    expect(diffs[0].create[0].kind).toBe("heron");
    expect(diffs[0].create[0].telegraph).toBeUndefined();

    // Step 1: the boss (b1, kind "snailking") spawns; the heron persists but
    // now carries a telegraph (about to dive-swoop).
    expect(diffs[1].create.map((e) => e.id)).toEqual(["b1"]);
    expect(diffs[1].create[0].kind).toBe("snailking");
    expect(diffs[1].update.map((e) => e.id)).toEqual(["h1"]);
    const heronStep1 = diffs[1].update.find((e) => e.id === "h1");
    expect(heronStep1?.telegraph).toEqual({ x1: 100, y1: 100, x2: 900, y2: 100 });
  });

  it("keeps the telegraph across consecutive updates while the boss enters its shell phase", () => {
    const diffs = replay(bossHeronSnapshots.map((s) => s.enemies));

    // Step 2: both persist; heron still telegraphing at a new position
    // (mid-swoop), boss now shelled.
    expect(diffs[2].create).toEqual([]);
    expect(diffs[2].update.map((e) => e.id).sort()).toEqual(["b1", "h1"]);
    const heronStep2 = diffs[2].update.find((e) => e.id === "h1");
    const bossStep2 = diffs[2].update.find((e) => e.id === "b1");
    expect(heronStep2?.telegraph).toEqual({ x1: 100, y1: 100, x2: 900, y2: 100 });
    expect(bossStep2?.shelled).toBe(true);
  });

  it("destroys the heron once its swoop finishes and it despawns, boss un-shells and persists", () => {
    const diffs = replay(bossHeronSnapshots.map((s) => s.enemies));

    // Step 3: heron is gone (swoop completed, re-circled off snapshot in
    // this fixture); boss persists with shelled now false.
    expect(diffs[3].destroy).toEqual(["h1"]);
    expect(diffs[3].update.map((e) => e.id)).toEqual(["b1"]);
    const bossStep3 = diffs[3].update.find((e) => e.id === "b1");
    expect(bossStep3?.shelled).toBe(false);
  });
});
