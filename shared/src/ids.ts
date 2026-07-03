// Tiny id helpers shared by client and server. No logic beyond a plain counter —
// deterministic and dependency-free (no Date.now()/crypto needed for v0.1 scope).

/**
 * Returns a factory that produces incrementing ids prefixed with `prefix`,
 * e.g. makeIdFactory("enemy") -> "enemy-1", "enemy-2", ...
 */
export function makeIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

/**
 * Fixed shop offer ids (DESIGN §7). Both halves of shared/ agree on these
 * literal strings: this file defines them for the protocol side, and
 * shared/src/constants.ts (owned separately) keys its catalog table by the
 * same ids.
 */
export const OFFER_IDS = [
  "buy-tongue",
  "buy-bubble",
  "buy-croak",
  "upgrade-slot",
  "stat-hp",
  "stat-damage",
  "stat-speed",
] as const satisfies readonly string[];

export type OfferId = (typeof OFFER_IDS)[number];
