// Pure class-card view-model helpers — no Phaser import, no side effects.
//
// Builds the lobby's 3 class cards data-driven from FROG_CLASSES
// (shared/src/constants.ts is the single source of truth for every class
// fact: fantasy text, stat mods, starting weapon). Nothing about a class is
// hardcoded here beyond display labels for stat keys and weapon types,
// which are just presentation strings for values that already exist.

import { FROG_CLASSES } from "@frogtato/shared";
import type { FrogClassId, FrogClassStatMods, WeaponType } from "@frogtato/shared";

/** Stable render order for the 3 class cards (DESIGN-PHASE2.md §1 table order). */
export const FROG_CLASS_ORDER: readonly FrogClassId[] = ["bullfrog", "treefrog", "dartfrog"];

const WEAPON_DISPLAY_NAMES: Readonly<Record<WeaponType, string>> = {
  tongueLash: "Tongue Lash",
  bubbleBlaster: "Bubble Blaster",
  croakNova: "Croak Nova",
};

const STAT_MOD_LABELS: ReadonlyArray<{
  key: keyof FrogClassStatMods;
  label: string;
  isPct: boolean;
}> = [
  { key: "maxHp", label: "Max HP", isPct: false },
  { key: "moveSpeedPct", label: "Move Speed", isPct: true },
  { key: "damagePct", label: "Damage", isPct: true },
  { key: "armor", label: "Armor", isPct: false },
  { key: "pickupRadius", label: "Pickup Radius", isPct: false },
];

/** "+8 Max HP, -15% Move Speed, +1 Armor" — every nonzero stat mod, in a
 * fixed field order, formatted with an explicit sign. Zero-valued fields
 * are omitted (nothing to say about them). */
export function formatStatMods(mods: FrogClassStatMods): string {
  const parts: string[] = [];
  for (const { key, label, isPct } of STAT_MOD_LABELS) {
    const value = mods[key];
    if (value === 0) continue;
    const sign = value > 0 ? "+" : "";
    const formatted = isPct ? `${sign}${Math.round(value * 100)}%` : `${sign}${value}`;
    parts.push(`${formatted} ${label}`);
  }
  return parts.join(", ");
}

export interface ClassCardView {
  id: FrogClassId;
  displayName: string;
  description: string;
  statSummary: string;
  startingWeaponLabel: string;
}

/** Render model for the lobby's 3 class cards, in FROG_CLASS_ORDER. */
export function buildClassCardViews(): ClassCardView[] {
  return FROG_CLASS_ORDER.map((id) => {
    const def = FROG_CLASSES[id];
    return {
      id: def.id,
      displayName: def.displayName,
      description: def.description,
      statSummary: formatStatMods(def.statMods),
      startingWeaponLabel: WEAPON_DISPLAY_NAMES[def.startingWeapon] ?? def.startingWeapon,
    };
  });
}

/** Single-letter class badge shown next to other players' names in the
 * lobby list (data-driven off displayName, not a hardcoded letter table). */
export function classInitial(classId: FrogClassId): string {
  return FROG_CLASSES[classId].displayName.charAt(0).toUpperCase();
}
