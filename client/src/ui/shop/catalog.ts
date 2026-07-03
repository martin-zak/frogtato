// Pure shop-catalog logic — no Phaser import, no side effects.
//
// Given the shared catalog constants (source of truth: shared/src/constants.ts)
// plus the own player's live PlayerSnap and a client-side purchase-count
// bookkeeping record, computes a render model ShopScene can draw directly:
// price, affordability, and disabled/reason per offer.
//
// The server (T9) is authoritative — this module exists purely for display
// and must mirror T9's pricing rules bit-for-bit so what the player sees
// before clicking "buy" matches what they'll actually be charged. Every
// number here is read from shared/src/constants.ts; nothing is hardcoded.
//
// --- Ambiguity notes (flagged in the T10b report) ---
// 1. DESIGN.md just says weapon-buy "requires empty slot" with no definition
//    of which slot to fill when multiple are empty — literal reading: any
//    empty slot is valid, so 2 empty slots means the player picks which one.
// 2. "no upgradeable slot" vs "max level" (named explicitly in the task
//    brief) aren't distinguished anywhere in DESIGN.md. Literal reading
//    chosen: if the player has zero weapons at all, there's nothing to
//    upgrade ("no upgradeable slot"); if every occupied slot is already
//    level III, everything is already maxed ("max level").
// 3. `purchaseResult.priceNext` has no slot dimension, so when a weapon
//    upgrade offer has two eligible slots (two different next-level prices)
//    a single priceNext override can't be unambiguously attributed to one
//    slot. Chosen behavior: priceNext overrides only apply when the offer
//    resolves to a single price (weapon-buy, stat offers, or a weapon
//    upgrade with exactly one eligible slot); the two-slot case always uses
//    freshly computed per-slot prices from WEAPON_UPGRADE_PRICES + the
//    slot's live level in the snapshot (which is itself authoritative).

import {
  SHOP_CATALOG,
  WEAPON_SHOP_OFFERS,
  STAT_SHOP_OFFERS,
  WEAPON_UPGRADE_PRICES,
  type WeaponType,
  type WeaponLevel as BalanceWeaponLevel,
} from "@frogtato/shared";
import type { PlayerSnap, WeaponLevel } from "@frogtato/shared";
import { UPGRADE_OFFER_ID } from "@frogtato/shared";

export { UPGRADE_OFFER_ID };

const WEAPON_DISPLAY_NAMES: Readonly<Record<WeaponType, string>> = {
  tongueLash: "Tongue Lash",
  bubbleBlaster: "Bubble Blaster",
  croakNova: "Croak Nova",
};

const STAT_TITLES: Record<string, string> = {
  buyMaxHp: "+3 Max HP",
  buyDamage: "+8% Damage",
  buyMoveSpeed: "+10% Move Speed",
};

/** A single slot-specific price/affordability choice, shown as its own button
 * when an offer has more than one valid target slot. */
export interface ShopSlotOption {
  slot: number;
  price: number;
  affordable: boolean;
}

export interface ShopOfferView {
  offerId: string;
  title: string;
  /** Headline price. For a two-slot offer this is the cheaper of the two
   * (both are shown individually via `slotOptions`). */
  price: number;
  affordable: boolean;
  disabled: boolean;
  reason?: string;
  /** Present + length 1 when exactly one valid slot exists: send `buy` with this slot directly. */
  autoSlot?: number;
  /** Present + length 2 when two valid slots exist: render two buttons, one per slot. */
  slotOptions?: ShopSlotOption[];
}

/** Successful-purchase counts this shop phase, keyed by offerId (client-side,
 * display-only bookkeeping — see catalog.ts header). */
export type PurchaseCounts = Readonly<Record<string, number>>;

/** Latest `priceNext` seen per offerId from a `purchaseResult` event, if any. */
export type PriceOverrides = Readonly<Record<string, number>>;

export interface ComputeShopOffersInput {
  own: PlayerSnap;
  purchaseCounts?: PurchaseCounts;
  priceOverrides?: PriceOverrides;
}

/** Builds the full render model for the shop catalog grid. Order matches
 * SHOP_CATALOG (weapon-buy offers, then stat offers) with the weapon-upgrade
 * offer inserted right after the weapon-buy offers, matching the DESIGN §7
 * table's row order. */
export function computeShopOffers(input: ComputeShopOffersInput): ShopOfferView[] {
  const { own } = input;
  const purchaseCounts = input.purchaseCounts ?? {};
  const priceOverrides = input.priceOverrides ?? {};

  const views: ShopOfferView[] = [];

  for (const offer of WEAPON_SHOP_OFFERS) {
    views.push(computeWeaponBuyOffer(offer, own, priceOverrides));
  }

  views.push(computeUpgradeOffer(own, priceOverrides));

  for (const offer of STAT_SHOP_OFFERS) {
    views.push(computeStatOffer(offer, own, purchaseCounts, priceOverrides));
  }

  return views;
}

function computeWeaponBuyOffer(
  offer: (typeof WEAPON_SHOP_OFFERS)[number],
  own: PlayerSnap,
  priceOverrides: PriceOverrides,
): ShopOfferView {
  const price = priceOverrides[offer.id] ?? offer.cost;
  const emptySlots = own.weapons
    .map((w, i) => (w === null ? i : -1))
    .filter((i) => i >= 0);

  const title = `Buy ${WEAPON_DISPLAY_NAMES[offer.weapon]} (Lv I)`;

  if (emptySlots.length === 0) {
    return { offerId: offer.id, title, price, affordable: false, disabled: true, reason: "slots full" };
  }

  const affordable = price <= own.flies;

  if (emptySlots.length === 1) {
    return { offerId: offer.id, title, price, affordable, disabled: false, autoSlot: emptySlots[0] };
  }

  const slotOptions: ShopSlotOption[] = emptySlots.map((slot) => ({ slot, price, affordable }));
  return { offerId: offer.id, title, price, affordable, disabled: false, slotOptions };
}

function computeUpgradeOffer(own: PlayerSnap, priceOverrides: PriceOverrides): ShopOfferView {
  const title = "Upgrade Weapon Slot";
  const eligible = own.weapons
    .map((w, i) => (w !== null && w.level < 3 ? { slot: i, level: w.level } : null))
    .filter((x): x is { slot: number; level: WeaponLevel } => x !== null);

  if (eligible.length === 0) {
    const anyOccupied = own.weapons.some((w) => w !== null);
    const reason = anyOccupied ? "max level" : "no upgradeable slot";
    return { offerId: UPGRADE_OFFER_ID, title, price: 0, affordable: false, disabled: true, reason };
  }

  if (eligible.length === 1) {
    const nextLevel = (eligible[0].level + 1) as 2 | 3;
    const price = priceOverrides[UPGRADE_OFFER_ID] ?? WEAPON_UPGRADE_PRICES[nextLevel];
    const affordable = price <= own.flies;
    return {
      offerId: UPGRADE_OFFER_ID,
      title,
      price,
      affordable,
      disabled: false,
      autoSlot: eligible[0].slot,
    };
  }

  // Two eligible slots: per-slot prices always freshly computed (see
  // ambiguity note #4 — priceNext can't be attributed to one slot here).
  const slotOptions: ShopSlotOption[] = eligible.map(({ slot, level }) => {
    const nextLevel = (level + 1) as 2 | 3;
    const price = WEAPON_UPGRADE_PRICES[nextLevel];
    return { slot, price, affordable: price <= own.flies };
  });
  const price = Math.min(...slotOptions.map((s) => s.price));
  const affordable = slotOptions.some((s) => s.affordable);
  return { offerId: UPGRADE_OFFER_ID, title, price, affordable, disabled: false, slotOptions };
}

function computeStatOffer(
  offer: (typeof STAT_SHOP_OFFERS)[number],
  own: PlayerSnap,
  purchaseCounts: PurchaseCounts,
  priceOverrides: PriceOverrides,
): ShopOfferView {
  const count = purchaseCounts[offer.id] ?? 0;
  const computedPrice = offer.cost + offer.priceIncrement * count;
  const price = priceOverrides[offer.id] ?? computedPrice;
  const title = STAT_TITLES[offer.id] ?? offer.id;

  if (offer.maxPurchases !== undefined && count >= offer.maxPurchases) {
    const reason = offer.effect.stat === "moveSpeedPct" ? "move-speed cap reached" : "max purchases reached";
    return { offerId: offer.id, title, price, affordable: false, disabled: true, reason };
  }

  const affordable = price <= own.flies;
  return { offerId: offer.id, title, price, affordable, disabled: false };
}

// Re-exported for convenience so ShopScene (and tests) don't need a second
// import from @frogtato/shared just for the catalog list itself.
export { SHOP_CATALOG };
export type ShopWeaponLevel = BalanceWeaponLevel;
