// Shop scene: 30s (or all-ready) break between waves. Phase-driven — entered
// whenever a snapshot reports phase === "shop"; see the file-header note in
// `handleSnapshot` for exactly when this scene resets its local ready/price
// bookkeeping. No gameplay rules live here: prices/affordability are
// computed by the pure `ui/shop/catalog.ts` module against the same shared
// constants the server (T9) validates against; this scene only renders that
// model and forwards clicks as `buy`/`ready` messages.
//
// PLAN T10b note: no `ui/phaseRouter.ts` exists yet at the time this scene
// was written, so scene transitions in/out of "Shop" are not self-driven
// here (that's the orchestrator's job once the router lands). Per the task
// brief this scene still defensively unsubscribes its own net listeners the
// moment a snapshot reports phase !== "shop", so it never keeps mutating
// state or sending messages after the shop phase has ended, even if nothing
// external stops the scene.

import Phaser from "phaser";
import type { GameEvent, PlayerSnap } from "@frogtato/shared";
import type { NetClient } from "../net.js";
import { computeShopOffers, type ShopOfferView } from "../ui/shop/catalog.js";

const COLOR_BG = 0x0a1a2a;
const COLOR_AFFORDABLE = 0x2e7d5b;
const COLOR_UNAFFORDABLE = 0x37474f;
const COLOR_DISABLED = 0x263238;
const COLOR_FLASH = 0x66bb6a;
const COLOR_READY_IDLE = 0x4caf50;
const COLOR_READY_SENT = 0x37474f;
const COLOR_TOAST = 0xb71c1c;

const OFFER_BOX_WIDTH = 300;
const OFFER_BOX_HEIGHT = 54;
const OFFER_BOX_GAP = 10;
const OFFER_START_Y = 120;
const OFFER_X = 190;

const TOAST_MS = 2200;
const FLASH_MS = 220;

interface OfferButton {
  box: Phaser.GameObjects.Rectangle;
  title: Phaser.GameObjects.Text;
  price: Phaser.GameObjects.Text;
  reason: Phaser.GameObjects.Text;
  slotBoxes: [Phaser.GameObjects.Rectangle, Phaser.GameObjects.Rectangle];
  slotTexts: [Phaser.GameObjects.Text, Phaser.GameObjects.Text];
}

export class ShopScene extends Phaser.Scene {
  private net!: NetClient;

  private unsubscribers: Array<() => void> = [];
  private active = false;

  private purchaseCounts: Record<string, number> = {};
  private priceOverrides: Record<string, number> = {};
  private readySent = false;
  private lastSeenPhaseEndsAt: number | null = null;
  private lastSeenPhase: string | null = null;

  private countdownText!: Phaser.GameObjects.Text;
  private fliesText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private readyListText!: Phaser.GameObjects.Text;
  private readyButton!: Phaser.GameObjects.Text;
  private toastText!: Phaser.GameObjects.Text;

  private offerButtons = new Map<string, OfferButton>();
  private phaseEndsAt: number | null = null;

  constructor() {
    super("ShopScene");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.active = true;
    this.purchaseCounts = {};
    this.priceOverrides = {};
    this.readySent = false;
    this.lastSeenPhaseEndsAt = null;
    this.lastSeenPhase = null;
    this.phaseEndsAt = null;
    this.offerButtons.clear();

    this.cameras.main.setBackgroundColor(COLOR_BG);

    this.add
      .text(this.scale.width / 2, 24, "SHOP", {
        fontFamily: "sans-serif",
        fontSize: "32px",
        fontStyle: "bold",
        color: "#e8f5e9",
      })
      .setOrigin(0.5);

    this.countdownText = this.add
      .text(this.scale.width / 2, 60, "", {
        fontFamily: "sans-serif",
        fontSize: "18px",
        color: "#ffca28",
      })
      .setOrigin(0.5);

    this.fliesText = this.add.text(OFFER_X, 90, "", {
      fontFamily: "sans-serif",
      fontSize: "18px",
      color: "#e8f5e9",
      fontStyle: "bold",
    });

    this.buildOfferButtons();

    const rightColX = OFFER_X + OFFER_BOX_WIDTH + 60;
    this.add.text(rightColX, OFFER_START_Y, "Your Stats", {
      fontFamily: "sans-serif",
      fontSize: "18px",
      color: "#e8f5e9",
    });
    this.statsText = this.add.text(rightColX, OFFER_START_Y + 28, "", {
      fontFamily: "sans-serif",
      fontSize: "16px",
      color: "#cfd8dc",
      lineSpacing: 6,
    });

    this.add.text(rightColX, OFFER_START_Y + 200, "Ready", {
      fontFamily: "sans-serif",
      fontSize: "18px",
      color: "#e8f5e9",
    });
    this.readyListText = this.add.text(rightColX, OFFER_START_Y + 228, "", {
      fontFamily: "sans-serif",
      fontSize: "16px",
      color: "#cfd8dc",
      lineSpacing: 6,
    });

    this.readyButton = this.add
      .text(rightColX, OFFER_START_Y + 380, "  READY  ", {
        fontFamily: "sans-serif",
        fontSize: "26px",
        color: "#101418",
        backgroundColor: "#4caf50",
      })
      .setPadding(16, 10, 16, 10)
      .setInteractive({ useHandCursor: true });
    this.readyButton.on("pointerdown", () => this.sendReady());

    this.toastText = this.add
      .text(this.scale.width / 2, this.scale.height - 40, "", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#ffffff",
        backgroundColor: "#b71c1c",
      })
      .setOrigin(0.5)
      .setPadding(10, 6, 10, 6)
      .setAlpha(0);

    this.unsubscribers.push(
      this.net.onSnapshot((snap) => this.handleSnapshot(snap.phase, snap.phaseEndsAt ?? null, snap.players)),
      this.net.onEvent((event) => this.handleEvent(event)),
    );

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
  }

  update(): void {
    if (!this.active) return;
    if (this.phaseEndsAt !== null) {
      const remainingMs = Math.max(0, this.phaseEndsAt - Date.now());
      this.countdownText.setText(`${(remainingMs / 1000).toFixed(1)}s`);
    }
  }

  // ---------------------------------------------------------------------
  // Snapshot / event handling
  // ---------------------------------------------------------------------

  private handleSnapshot(phase: string, phaseEndsAt: number | null, players: PlayerSnap[]): void {
    if (phase !== "shop") {
      // Defensive cleanup per the task brief: stop reacting once the shop
      // phase has ended, even without an external router driving scene
      // transitions yet.
      if (this.active) this.teardown();
      return;
    }
    if (!this.active) return; // torn down already (shouldn't happen while phase stays "shop")

    // A "fresh shop phase" is detected by phaseEndsAt changing (a new
    // countdown was issued) or by phase having just transitioned into
    // "shop" from something else. Either trigger resets purchase counts,
    // price overrides, and the local ready-button lock — see the file
    // header for why this scene owns that decision instead of a router.
    const isFreshShopPhase = this.lastSeenPhase !== "shop" || phaseEndsAt !== this.lastSeenPhaseEndsAt;
    this.lastSeenPhase = phase;
    this.lastSeenPhaseEndsAt = phaseEndsAt;

    if (isFreshShopPhase) {
      this.purchaseCounts = {};
      this.priceOverrides = {};
      this.readySent = false;
      this.setReadyButtonState(false);
    }

    this.phaseEndsAt = phaseEndsAt;

    const own = players.find((p) => p.id === this.net.playerId) ?? null;
    if (own) {
      this.fliesText.setText(`Flies: ${own.flies}`);
      this.statsText.setText(
        [
          `HP: ${Math.round(own.hp)} / ${own.maxHp}`,
          `Damage: +${Math.round(own.stats.damagePct * 100)}%`,
          `Move speed: ${Math.round(own.stats.moveSpeed)} px/s`,
          `Slot 1: ${weaponSlotLabel(own.weapons[0] ?? null)}`,
          `Slot 2: ${weaponSlotLabel(own.weapons[1] ?? null)}`,
        ].join("\n"),
      );

      const offers = computeShopOffers({
        own,
        purchaseCounts: this.purchaseCounts,
        priceOverrides: this.priceOverrides,
      });
      this.renderOffers(offers);
    }

    this.readyListText.setText(
      players.length === 0
        ? "—"
        : players.map((p) => `${p.ready ? "✓" : "…"} ${p.name ?? p.id}`).join("\n"),
    );
  }

  private handleEvent(event: GameEvent): void {
    if (event.type !== "purchaseResult") return;
    if (event.playerId !== this.net.playerId) return; // only own purchases affect this client's shop UI

    if (event.ok) {
      this.purchaseCounts[event.offerId] = (this.purchaseCounts[event.offerId] ?? 0) + 1;
      if (event.priceNext !== undefined) {
        this.priceOverrides[event.offerId] = event.priceNext;
      }
      this.flashOffer(event.offerId);
    } else {
      this.showToast(event.reason ?? "Purchase failed");
    }
  }

  // ---------------------------------------------------------------------
  // Offer grid
  // ---------------------------------------------------------------------

  private buildOfferButtons(): void {
    // Built once against a zero-funds fixture-free placeholder set; the
    // real offer ids/order come from computeShopOffers on the first
    // snapshot. We create MAX_OFFERS reusable slots up front so per-frame
    // updates only touch text/color, never recreate GameObjects.
    for (let i = 0; i < MAX_OFFERS; i++) {
      const y = OFFER_START_Y + i * (OFFER_BOX_HEIGHT + OFFER_BOX_GAP);

      const box = this.add
        .rectangle(OFFER_X, y, OFFER_BOX_WIDTH, OFFER_BOX_HEIGHT, COLOR_DISABLED)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x455a64);

      const title = this.add.text(OFFER_X + 10, y + 8, "", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#e8f5e9",
      });
      const price = this.add.text(OFFER_X + OFFER_BOX_WIDTH - 10, y + 8, "", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#ffe082",
      }).setOrigin(1, 0);
      const reason = this.add.text(OFFER_X + 10, y + 30, "", {
        fontFamily: "sans-serif",
        fontSize: "12px",
        color: "#ff8a80",
      });

      const slotBoxWidth = 60;
      const slotBoxes: [Phaser.GameObjects.Rectangle, Phaser.GameObjects.Rectangle] = [
        this.add
          .rectangle(OFFER_X + OFFER_BOX_WIDTH - slotBoxWidth * 2 - 8, y + OFFER_BOX_HEIGHT - 20, slotBoxWidth, 18, COLOR_AFFORDABLE)
          .setOrigin(0, 0)
          .setVisible(false),
        this.add
          .rectangle(OFFER_X + OFFER_BOX_WIDTH - slotBoxWidth - 4, y + OFFER_BOX_HEIGHT - 20, slotBoxWidth, 18, COLOR_AFFORDABLE)
          .setOrigin(0, 0)
          .setVisible(false),
      ];
      const slotTexts: [Phaser.GameObjects.Text, Phaser.GameObjects.Text] = [
        this.add
          .text(slotBoxes[0].x + slotBoxWidth / 2, slotBoxes[0].y + 9, "", {
            fontFamily: "sans-serif",
            fontSize: "11px",
            color: "#101418",
          })
          .setOrigin(0.5)
          .setVisible(false),
        this.add
          .text(slotBoxes[1].x + slotBoxWidth / 2, slotBoxes[1].y + 9, "", {
            fontFamily: "sans-serif",
            fontSize: "11px",
            color: "#101418",
          })
          .setOrigin(0.5)
          .setVisible(false),
      ];

      const button: OfferButton = { box, title, price, reason, slotBoxes, slotTexts };
      // offerId/slot assigned once the first render pass knows the catalog
      // order; stored via setData so click handlers can look them up live.
      box.setData("index", i);
      button.slotBoxes.forEach((sb) => {
        sb.on("pointerdown", () => this.handleSlotClick(box.getData("offerId") as string, sb.getData("slot") as number | undefined));
      });
      box.setInteractive({ useHandCursor: true });
      box.on("pointerdown", () => this.handleOfferClick(box.getData("offerId") as string));

      this.offerButtonsByIndex.push(button);
    }
  }

  private offerButtonsByIndex: OfferButton[] = [];
  private offerIdByIndex: (string | undefined)[] = [];
  private offerViewByIndex: (ShopOfferView | undefined)[] = [];

  private renderOffers(offers: ShopOfferView[]): void {
    this.offerButtons.clear();
    for (let i = 0; i < MAX_OFFERS; i++) {
      const button = this.offerButtonsByIndex[i];
      const offer = offers[i];
      if (!offer) {
        button.box.setVisible(false);
        button.title.setVisible(false);
        button.price.setVisible(false);
        button.reason.setVisible(false);
        button.slotBoxes.forEach((b) => b.setVisible(false));
        button.slotTexts.forEach((t) => t.setVisible(false));
        this.offerIdByIndex[i] = undefined;
        continue;
      }

      this.offerButtons.set(offer.offerId, button);
      this.offerIdByIndex[i] = offer.offerId;
      this.offerViewByIndex[i] = offer;
      button.box.setData("offerId", offer.offerId);

      button.box.setVisible(true);
      button.title.setVisible(true);
      button.price.setVisible(true);

      button.title.setText(offer.title);
      button.price.setText(`${offer.price} 🪰`);

      const hasSlotOptions = offer.slotOptions !== undefined && offer.slotOptions.length === 2;

      if (offer.disabled) {
        button.box.setFillStyle(COLOR_DISABLED);
        button.title.setColor("#78909c");
        button.price.setColor("#78909c");
        button.reason.setText(offer.reason ?? "");
        button.reason.setVisible(true);
      } else {
        button.box.setFillStyle(offer.affordable ? COLOR_AFFORDABLE : COLOR_UNAFFORDABLE);
        button.title.setColor("#e8f5e9");
        button.price.setColor(offer.affordable ? "#ffe082" : "#b0bec5");
        button.reason.setVisible(false);
      }

      // Clicking the main box only sends a `buy` directly when the offer
      // needs no slot disambiguation (autoSlot or no slot at all); when two
      // slots are eligible, the box itself is inert and the two small
      // slot buttons below handle the click instead, per the task brief.
      button.box.disableInteractive();
      if (!offer.disabled && !hasSlotOptions) {
        button.box.setInteractive({ useHandCursor: true });
      }

      button.slotBoxes.forEach((sb) => sb.disableInteractive());
      if (hasSlotOptions && offer.slotOptions) {
        offer.slotOptions.forEach((opt, idx) => {
          const sb = button.slotBoxes[idx];
          const st = button.slotTexts[idx];
          sb.setVisible(true);
          st.setVisible(true);
          sb.setFillStyle(opt.affordable ? COLOR_AFFORDABLE : COLOR_UNAFFORDABLE);
          st.setText(`Slot ${opt.slot + 1}: ${opt.price}`);
          sb.setData("slot", opt.slot);
          sb.setInteractive({ useHandCursor: true });
        });
      } else {
        button.slotBoxes.forEach((sb, idx) => {
          sb.setVisible(false);
          button.slotTexts[idx].setVisible(false);
        });
      }
    }
  }

  private handleOfferClick(offerId: string | undefined): void {
    if (!offerId) return;
    const offer = this.offerViewByIndex.find((o) => o?.offerId === offerId);
    if (!offer || offer.disabled) return;
    if (offer.slotOptions && offer.slotOptions.length === 2) return; // handled by slot buttons
    if (offer.autoSlot !== undefined) {
      this.net.send({ type: "buy", offerId, slot: offer.autoSlot });
    } else {
      this.net.send({ type: "buy", offerId });
    }
  }

  private handleSlotClick(offerId: string | undefined, slot: number | undefined): void {
    if (!offerId || slot === undefined) return;
    this.net.send({ type: "buy", offerId, slot });
  }

  private flashOffer(offerId: string): void {
    const button = this.offerButtons.get(offerId);
    if (!button) return;
    const prevColor = button.box.fillColor;
    button.box.setFillStyle(COLOR_FLASH);
    this.time.delayedCall(FLASH_MS, () => {
      if (button.box.active) button.box.setFillStyle(prevColor);
    });
  }

  // ---------------------------------------------------------------------
  // Ready
  // ---------------------------------------------------------------------

  private sendReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    this.setReadyButtonState(true);
    this.net.send({ type: "ready" });
  }

  private setReadyButtonState(sent: boolean): void {
    this.readyButton.setBackgroundColor(sent ? "#37474f" : "#4caf50");
    this.readyButton.setText(sent ? "  WAITING…  " : "  READY  ");
    if (sent) this.readyButton.disableInteractive();
    else this.readyButton.setInteractive({ useHandCursor: true });
  }

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------

  private showToast(message: string): void {
    this.toastText.setText(message);
    this.toastText.setAlpha(1);
    this.tweens.killTweensOf(this.toastText);
    this.tweens.add({
      targets: this.toastText,
      alpha: 0,
      delay: TOAST_MS,
      duration: 300,
    });
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  private teardown(): void {
    this.active = false;
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}

const MAX_OFFERS = 7; // 3 weapon-buy + 1 upgrade + 3 stat offers, per SHOP_CATALOG + the synthetic upgrade offer

function weaponSlotLabel(slot: { kind: string; level: number } | null): string {
  if (!slot) return "empty";
  const names: Record<string, string> = { tongue: "Tongue Lash", bubble: "Bubble Blaster", croak: "Croak Nova" };
  const roman = ["", "I", "II", "III"][slot.level] ?? String(slot.level);
  return `${names[slot.kind] ?? slot.kind} Lv ${roman}`;
}
