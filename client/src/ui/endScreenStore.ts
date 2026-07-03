// Tiny module-level store bridging GameScene (which observes the
// `gameOver`/`victory` GameEvent as it happens, while still the active
// scene — the server only flips `phase` to "scoreboard" on the *next*
// snapshot) and GameOverScene (which needs that event's scoreboard once
// phase routing lands it there a moment later).
//
// Deliberately not part of NetClient (net.ts is owned by a different task
// area) — this is pure client-side UI bookkeeping (what to show), not
// protocol plumbing (what was received). No Phaser import, no side effects
// beyond the module-level cache, so it's plain-Node testable.

import type { GameEvent, ScoreRow } from "@frogtato/shared";

export interface EndScreenResult {
  kind: "gameOver" | "victory";
  scoreboard: ScoreRow[];
}

let lastResult: EndScreenResult | null = null;

/** Feed every observed GameEvent through this; no-op for anything other
 * than gameOver/victory. */
export function captureEndScreenEvent(event: GameEvent): void {
  if (event.type === "gameOver" || event.type === "victory") {
    lastResult = { kind: event.type, scoreboard: event.scoreboard };
  }
}

/** The most recently captured gameOver/victory result, or `null` if none
 * has been observed yet this session (e.g. a client that joins mid-scoreboard). */
export function getLastEndScreenResult(): EndScreenResult | null {
  return lastResult;
}

/** Test-only reset hook (module state persists across tests otherwise). */
export function resetEndScreenStoreForTest(): void {
  lastResult = null;
}
