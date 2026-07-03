// Public entrypoint for @frogtato/shared: balance data, protocol message
// types, and id helpers — single source of truth for server + client.
export * from './constants.js';
export * from './messages.js';
export * from './ids.js';

// `WeaponLevel` (1 | 2 | 3) and `FrogClassId` (bullfrog | treefrog | dartfrog)
// are each defined identically in both constants.ts and messages.ts;
// disambiguate the wildcard re-export in favor of constants.ts, the
// balance-data source of truth, per TS2308.
export type { WeaponLevel, FrogClassId } from './constants.js';
