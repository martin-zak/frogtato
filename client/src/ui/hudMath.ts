// Pure HUD math — no Phaser import, no side effects, so it's directly
// unit-testable under plain Node/vitest (see the note in
// render/diff.ts: importing Phaser eagerly touches `navigator` at
// module-load time, which blows up outside a browser/DOM environment).

/**
 * Countdown remaining, in seconds, at `nowMs`.
 *
 * `phaseEndsAt` is a server timestamp (server's own clock). Per DESIGN §9
 * the client has no clock-sync guarantee against the server, so instead of
 * repeatedly comparing `phaseEndsAt` against the client's own `Date.now()`
 * (which silently assumes the two clocks agree), we anchor once per
 * snapshot: `remainingAtRecv` is computed from the delta between
 * `phaseEndsAt` and the moment *this client* received that snapshot
 * (`snapshotRecvAt`, itself a `Date.now()` reading), then ticked down using
 * only the client's own elapsed wall-clock time since that receipt. Each
 * new snapshot re-anchors, so any client/server clock offset never
 * accumulates — it's re-derived fresh every ~50ms (SNAPSHOT_HZ).
 *
 * Returns `null` when there's no active phase deadline (e.g. lobby, or a
 * snapshot that omits `phaseEndsAt`).
 */
export function computeRemainingSec(
  phaseEndsAt: number | undefined,
  snapshotRecvAt: number,
  nowMs: number,
): number | null {
  if (phaseEndsAt === undefined) return null;
  const remainingAtRecvMs = phaseEndsAt - snapshotRecvAt;
  const elapsedSinceRecvMs = nowMs - snapshotRecvAt;
  const remainingMs = remainingAtRecvMs - elapsedSinceRecvMs;
  return Math.max(0, remainingMs / 1000);
}

/** Formats a countdown in seconds as e.g. "12s". Rounds up so the display
 * never shows "0s" while time technically remains (ceil, floor at 0). */
export function formatCountdown(remainingSec: number | null): string {
  if (remainingSec === null) return "";
  return `${Math.max(0, Math.ceil(remainingSec))}s`;
}

/**
 * Fraction of a weapon's cooldown still remaining, in `[0, 1]` — 1 right
 * after firing, 0 once the cooldown has fully elapsed (weapon ready).
 * Drives the cooldown-sweep overlay on each weapon slot box.
 *
 * The client never receives real per-weapon cooldown state from the
 * server, so this is a deliberate approximation (per PLAN T10a): track the
 * last `attack` event's local receipt time per slot and compare against
 * that weapon's `cooldownSec` from `WEAPON_DEFS`. It can drift from the
 * server's actual cooldown by up to one network RTT — acceptable for a
 * cosmetic sweep.
 */
export function cooldownSweepFraction(
  lastAttackAtMs: number | null,
  nowMs: number,
  cooldownSec: number,
): number {
  if (lastAttackAtMs === null || cooldownSec <= 0) return 0;
  const elapsedSec = (nowMs - lastAttackAtMs) / 1000;
  if (elapsedSec >= cooldownSec) return 0;
  if (elapsedSec <= 0) return 1;
  return 1 - elapsedSec / cooldownSec;
}
