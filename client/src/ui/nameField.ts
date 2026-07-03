// Pure name-entry helpers — no Phaser import, no DOM assumptions beyond a
// best-effort localStorage read/write (guarded exactly like net.ts's
// token persistence, so this stays plain-Node testable and safe under
// private-mode/no-localStorage environments).
//
// DESIGN-PHASE2.md §5: lobby text field (max MAX_NAME_LENGTH chars), and
// player rows elsewhere (lobby, scoreboard) fall back to "Frog N" when a
// player has no name set.

import { MAX_NAME_LENGTH } from "@frogtato/shared";

const NAME_STORAGE_KEY = "frogtato.name";

/** Trims and truncates to MAX_NAME_LENGTH — the same client-side limit the
 * server enforces authoritatively (constants.ts owns the number). */
export function sanitizeName(raw: string): string {
  return raw.trim().slice(0, MAX_NAME_LENGTH);
}

export function loadStoredName(): string {
  try {
    return globalThis.localStorage?.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeName(name: string): void {
  try {
    globalThis.localStorage?.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // localStorage unavailable (e.g. private mode) — persistence is best-effort only.
  }
}

/** "Frog N" fallback, 1-indexed by the player's position in whatever list
 * is being rendered (lobby player list, scoreboard rows). */
export function fallbackName(index: number): string {
  return `Frog ${index + 1}`;
}

/** The name to render for a player row: their own name if set (trimmed,
 * non-empty), otherwise the "Frog N" fallback. */
export function displayName(player: { name?: string }, index: number): string {
  const trimmed = player.name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallbackName(index);
}
