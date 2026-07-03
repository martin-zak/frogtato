import { describe, expect, it } from "vitest";
import { FROG_CLASSES } from "@frogtato/shared";
import { buildClassCardViews, formatStatMods, classInitial, FROG_CLASS_ORDER } from "./classCards.js";

describe("buildClassCardViews", () => {
  it("returns one card per FROG_CLASSES entry, in FROG_CLASS_ORDER", () => {
    const views = buildClassCardViews();
    expect(views.map((v) => v.id)).toEqual(FROG_CLASS_ORDER);
    expect(views).toHaveLength(Object.keys(FROG_CLASSES).length);
  });

  it("pulls displayName/description straight from FROG_CLASSES (data-driven, not hardcoded)", () => {
    const views = buildClassCardViews();
    for (const view of views) {
      const def = FROG_CLASSES[view.id];
      expect(view.displayName).toBe(def.displayName);
      expect(view.description).toBe(def.description);
    }
  });

  it("includes a non-empty starting weapon label for every class", () => {
    for (const view of buildClassCardViews()) {
      expect(view.startingWeaponLabel.length).toBeGreaterThan(0);
    }
  });

  it("includes a non-empty stat summary for every class (each class has at least one nonzero mod)", () => {
    for (const view of buildClassCardViews()) {
      expect(view.statSummary.length).toBeGreaterThan(0);
    }
  });
});

describe("formatStatMods", () => {
  it("formats flat stats with an explicit sign", () => {
    expect(formatStatMods({ maxHp: 8, moveSpeedPct: 0, damagePct: 0, armor: 1, pickupRadius: 0 })).toBe(
      "+8 Max HP, +1 Armor",
    );
  });

  it("formats percentage stats as rounded whole-number percents", () => {
    expect(
      formatStatMods({ maxHp: 0, moveSpeedPct: -0.15, damagePct: 0, armor: 0, pickupRadius: 0 }),
    ).toBe("-15% Move Speed");
  });

  it("omits zero-valued fields entirely", () => {
    expect(formatStatMods({ maxHp: 0, moveSpeedPct: 0, damagePct: 0, armor: 0, pickupRadius: 0 })).toBe("");
  });

  it("preserves field order: maxHp, moveSpeedPct, damagePct, armor, pickupRadius", () => {
    const result = formatStatMods({ maxHp: 1, moveSpeedPct: 0.1, damagePct: 0.1, armor: 1, pickupRadius: 10 });
    expect(result).toBe("+1 Max HP, +10% Move Speed, +10% Damage, +1 Armor, +10 Pickup Radius");
  });

  it("matches each real class def's expected mods (bullfrog)", () => {
    expect(formatStatMods(FROG_CLASSES.bullfrog.statMods)).toBe("+8 Max HP, -15% Move Speed, +1 Armor");
  });
});

describe("classInitial", () => {
  it("derives the badge letter from displayName, not a hardcoded table", () => {
    for (const id of FROG_CLASS_ORDER) {
      expect(classInitial(id)).toBe(FROG_CLASSES[id].displayName.charAt(0).toUpperCase());
    }
  });
});
