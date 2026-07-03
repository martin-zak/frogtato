import { describe, it, expect } from "vitest";
import { computeShopOffers, mergeEligible, UPGRADE_OFFER_ID } from "./catalog.js";
import type { PlayerSnap } from "@frogtato/shared";

function makeOwn(overrides: Partial<PlayerSnap> = {}): PlayerSnap {
  return {
    id: "p1",
    color: 0,
    class: "treefrog",
    x: 0,
    y: 0,
    hp: 20,
    maxHp: 20,
    flies: 0,
    downed: false,
    spectator: false,
    weapons: [{ kind: "tongue", level: 1 }, null],
    stats: { damagePct: 0, moveSpeed: 220, maxHp: 20, armor: 0, regen: 0, pickupRadius: 60 },
    ready: false,
    ...overrides,
  };
}

function findOffer(views: ReturnType<typeof computeShopOffers>, offerId: string) {
  const v = views.find((o) => o.offerId === offerId);
  if (!v) throw new Error(`offer ${offerId} not found`);
  return v;
}

describe("computeShopOffers — affordability boundary", () => {
  it("is affordable when funds exactly equal price", () => {
    const own = makeOwn({ flies: 12, weapons: [null, null] });
    const views = computeShopOffers({ own });
    const buyTongue = findOffer(views, "buyTongueLash");
    expect(buyTongue.price).toBe(12);
    expect(buyTongue.affordable).toBe(true);
  });

  it("is not affordable when funds are 1 short", () => {
    const own = makeOwn({ flies: 11, weapons: [null, null] });
    const views = computeShopOffers({ own });
    const buyTongue = findOffer(views, "buyTongueLash");
    expect(buyTongue.affordable).toBe(false);
  });
});

describe("computeShopOffers — repeatable stat offer price escalation", () => {
  it("escalates buyMaxHp price by priceIncrement per simulated purchase", () => {
    const own = makeOwn({ flies: 999 });

    const zero = findOffer(computeShopOffers({ own, purchaseCounts: { buyMaxHp: 0 } }), "buyMaxHp");
    expect(zero.price).toBe(10);

    const one = findOffer(computeShopOffers({ own, purchaseCounts: { buyMaxHp: 1 } }), "buyMaxHp");
    expect(one.price).toBe(15);

    const two = findOffer(computeShopOffers({ own, purchaseCounts: { buyMaxHp: 2 } }), "buyMaxHp");
    expect(two.price).toBe(20);
  });

  it("prefers a priceNext override from purchaseResult over the locally computed price", () => {
    const own = makeOwn({ flies: 999 });
    const views = computeShopOffers({
      own,
      purchaseCounts: { buyMaxHp: 1 },
      priceOverrides: { buyMaxHp: 999 },
    });
    expect(findOffer(views, "buyMaxHp").price).toBe(999);
  });
});

describe("computeShopOffers — move-speed cap", () => {
  it("disables buyMoveSpeed once maxPurchases is reached", () => {
    const own = makeOwn({ flies: 999 });
    const underCap = findOffer(
      computeShopOffers({ own, purchaseCounts: { buyMoveSpeed: 2 } }),
      "buyMoveSpeed",
    );
    expect(underCap.disabled).toBe(false);

    const atCap = findOffer(
      computeShopOffers({ own, purchaseCounts: { buyMoveSpeed: 3 } }),
      "buyMoveSpeed",
    );
    expect(atCap.disabled).toBe(true);
    expect(atCap.reason).toBe("move-speed cap reached");
  });
});

describe("computeShopOffers — weapon-buy slot rules", () => {
  it("disables all weapon-buy offers with reason 'slots full' when both slots occupied", () => {
    const own = makeOwn({
      flies: 999,
      weapons: [
        { kind: "tongue", level: 1 },
        { kind: "bubble", level: 1 },
      ],
    });
    const views = computeShopOffers({ own });
    for (const id of ["buyTongueLash", "buyBubbleBlaster", "buyCroakNova"]) {
      const v = findOffer(views, id);
      expect(v.disabled).toBe(true);
      expect(v.reason).toBe("slots full");
    }
  });

  it("auto-fills the single empty slot when only one is free", () => {
    const own = makeOwn({ flies: 999, weapons: [{ kind: "tongue", level: 1 }, null] });
    const v = findOffer(computeShopOffers({ own }), "buyBubbleBlaster");
    expect(v.disabled).toBe(false);
    expect(v.autoSlot).toBe(1);
    expect(v.slotOptions).toBeUndefined();
  });

  it("offers two slot buttons when both slots are empty", () => {
    const own = makeOwn({ flies: 999, weapons: [null, null] });
    const v = findOffer(computeShopOffers({ own }), "buyCroakNova");
    expect(v.disabled).toBe(false);
    expect(v.autoSlot).toBeUndefined();
    expect(v.slotOptions).toEqual([
      { slot: 0, price: 18, affordable: true },
      { slot: 1, price: 18, affordable: true },
    ]);
  });
});

describe("computeShopOffers — weapon-upgrade pricing", () => {
  it("prices an upgrade to level II at 20 for a single eligible level-I slot", () => {
    const own = makeOwn({ flies: 999, weapons: [{ kind: "tongue", level: 1 }, null] });
    const v = findOffer(computeShopOffers({ own }), UPGRADE_OFFER_ID);
    expect(v.disabled).toBe(false);
    expect(v.price).toBe(20);
    expect(v.autoSlot).toBe(0);
  });

  it("prices an upgrade to level III at 35 for a single eligible level-II slot", () => {
    const own = makeOwn({ flies: 999, weapons: [{ kind: "tongue", level: 2 }, null] });
    const v = findOffer(computeShopOffers({ own }), UPGRADE_OFFER_ID);
    expect(v.disabled).toBe(false);
    expect(v.price).toBe(35);
    expect(v.autoSlot).toBe(0);
  });

  it("offers per-slot prices when two slots are eligible at different levels", () => {
    const own = makeOwn({
      flies: 999,
      weapons: [
        { kind: "tongue", level: 1 },
        { kind: "bubble", level: 2 },
      ],
    });
    const v = findOffer(computeShopOffers({ own }), UPGRADE_OFFER_ID);
    expect(v.disabled).toBe(false);
    expect(v.slotOptions).toEqual([
      { slot: 0, price: 20, affordable: true },
      { slot: 1, price: 35, affordable: true },
    ]);
    expect(v.price).toBe(20); // headline price is the cheaper option
  });

  it("disables with 'max level' when the only weapon is already level III", () => {
    const own = makeOwn({ flies: 999, weapons: [{ kind: "tongue", level: 3 }, null] });
    const v = findOffer(computeShopOffers({ own }), UPGRADE_OFFER_ID);
    expect(v.disabled).toBe(true);
    expect(v.reason).toBe("max level");
  });

  it("disables with 'no upgradeable slot' when both slots are empty", () => {
    const own = makeOwn({ flies: 999, weapons: [null, null] });
    const v = findOffer(computeShopOffers({ own }), UPGRADE_OFFER_ID);
    expect(v.disabled).toBe(true);
    expect(v.reason).toBe("no upgradeable slot");
  });
});

describe("computeShopOffers — Phase 2 §2 new stat offers (armor/regen/pickupRadius)", () => {
  it("prices buyArmor at 14 base, +8 per purchase, capped at 3", () => {
    const own = makeOwn({ flies: 999 });
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyArmor: 0 } }), "buyArmor").price).toBe(14);
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyArmor: 1 } }), "buyArmor").price).toBe(22);
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyArmor: 2 } }), "buyArmor").price).toBe(30);

    const underCap = findOffer(computeShopOffers({ own, purchaseCounts: { buyArmor: 2 } }), "buyArmor");
    expect(underCap.disabled).toBe(false);
    const atCap = findOffer(computeShopOffers({ own, purchaseCounts: { buyArmor: 3 } }), "buyArmor");
    expect(atCap.disabled).toBe(true);
    expect(atCap.reason).toBe("max purchases reached");
  });

  it("prices buyRegen at 12 base, +6 per purchase, capped at 3", () => {
    const own = makeOwn({ flies: 999 });
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyRegen: 0 } }), "buyRegen").price).toBe(12);
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyRegen: 1 } }), "buyRegen").price).toBe(18);
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyRegen: 2 } }), "buyRegen").price).toBe(24);

    const atCap = findOffer(computeShopOffers({ own, purchaseCounts: { buyRegen: 3 } }), "buyRegen");
    expect(atCap.disabled).toBe(true);
  });

  it("prices buyPickupRadius at 8 base, +4 per purchase, capped at 4", () => {
    const own = makeOwn({ flies: 999 });
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyPickupRadius: 0 } }), "buyPickupRadius").price).toBe(8);
    expect(findOffer(computeShopOffers({ own, purchaseCounts: { buyPickupRadius: 3 } }), "buyPickupRadius").price).toBe(20);

    const underCap = findOffer(computeShopOffers({ own, purchaseCounts: { buyPickupRadius: 3 } }), "buyPickupRadius");
    expect(underCap.disabled).toBe(false);
    const atCap = findOffer(computeShopOffers({ own, purchaseCounts: { buyPickupRadius: 4 } }), "buyPickupRadius");
    expect(atCap.disabled).toBe(true);
  });
});

describe("mergeEligible (Phase 2 §3)", () => {
  it("is true when both slots hold the same kind + level, at a mergeable level (I or II)", () => {
    expect(mergeEligible([{ kind: "tongue", level: 1 }, { kind: "tongue", level: 1 }])).toBe(true);
    expect(mergeEligible([{ kind: "bubble", level: 2 }, { kind: "bubble", level: 2 }])).toBe(true);
  });

  it("is false when a slot is empty", () => {
    expect(mergeEligible([{ kind: "tongue", level: 1 }, null])).toBe(false);
    expect(mergeEligible([null, null])).toBe(false);
  });

  it("is false when the kinds differ", () => {
    expect(mergeEligible([{ kind: "tongue", level: 1 }, { kind: "bubble", level: 1 }])).toBe(false);
  });

  it("is false when the levels differ", () => {
    expect(mergeEligible([{ kind: "tongue", level: 1 }, { kind: "tongue", level: 2 }])).toBe(false);
  });

  it("is false at level III (no Lv IV to merge into)", () => {
    expect(mergeEligible([{ kind: "croak", level: 3 }, { kind: "croak", level: 3 }])).toBe(false);
  });
});
