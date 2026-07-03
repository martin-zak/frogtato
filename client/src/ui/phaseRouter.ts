// Centralizes phase -> scene routing (DESIGN §8/§9: "the client never
// assumes a phase" — every scene transition is purely event/snapshot
// driven). Every scene that needs to react to a phase change (Lobby, Game,
// Shop, GameOver) calls `routeToPhase(this, phase)` from its
// welcome/snapshot listeners rather than hand-rolling its own rule, so
// there is exactly one place that maps phase -> scene key.
//
// `import type` only below: this file must stay import-safe under plain
// Node/vitest (no DOM), and Phaser's module touches `navigator` at
// module-load time if actually evaluated (see render/diff.ts) — a
// type-only import is erased by TS and never executes that code.
import type Phaser from "phaser";
import type { Phase } from "@frogtato/shared";

/** The scene key each phase routes to. Kept as a `satisfies Record<Phase,
 * string>` so adding a new `Phase` value is a compile error here until this
 * table is updated. */
export const SCENE_KEY_FOR_PHASE = {
  lobby: "Lobby",
  wave: "Game",
  shop: "ShopScene",
  scoreboard: "GameOver",
} as const satisfies Record<Phase, string>;

/** Pure: which scene key a given phase should route to. */
export function sceneKeyForPhase(phase: Phase): string {
  return SCENE_KEY_FOR_PHASE[phase];
}

/** Minimal structural shape of the bits of Phaser's scene plugin this needs
 * — lets tests exercise `routeToPhase` with a plain object instead of a
 * real `Phaser.Scene` (which can't be constructed outside a DOM). Doubles
 * as documentation of exactly what this function touches. */
export interface PhaseRoutableScene {
  scene: {
    key: string;
    start: (key: string) => unknown;
    manager: { keys: Record<string, unknown> };
  };
}

/**
 * Starts the scene for `phase`, unless we're already showing it (no-op —
 * makes it safe to call on every snapshot without re-triggering
 * `create()`).
 *
 * Guards the shop scene specifically: `ShopScene` is owned by a concurrent
 * task and may not be registered with the scene manager yet. If phase
 * "shop" arrives before that registration lands, this logs a warning and
 * stays on the current scene instead of crashing on an unknown scene key.
 */
export function routeToPhase(scene: PhaseRoutableScene | Phaser.Scene, phase: Phase): void {
  const s = scene as PhaseRoutableScene;
  const targetKey = sceneKeyForPhase(phase);
  if (s.scene.key === targetKey) return;

  if (!s.scene.manager.keys[targetKey]) {
    console.warn(
      `[phaseRouter] phase "${phase}" routes to scene "${targetKey}", which isn't registered yet; staying on "${s.scene.key}"`,
    );
    return;
  }

  s.scene.start(targetKey);
}
