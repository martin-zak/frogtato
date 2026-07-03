// Lobby scene: shows connection status, the class picker, a name field,
// the list of connected players (name/color/class, from the live snapshot
// buffer) and a Start button.
//
// Scene transitions are purely phase-driven (DESIGN §8/§9): every
// welcome/snapshot routes through phaseRouter.ts rather than this scene
// hand-rolling its own rule. Historically (PLAN T4) the server hardcoded
// phase "wave", so a client landing in "wave" on `welcome` skipped straight
// to GameScene — that behavior still falls out of the same phase-routing
// call now that T8's real phase machine exists.
//
// Phase 2 §1/§5: class pick + name are both server-authoritative. This
// scene only *sends* pickClass/setName on explicit user action (a card
// click, or Enter/blur on the name field) — it never re-sends either on
// scene entry, so a rematch's server-persisted class/name is never
// clobbered by simply looking at the lobby again. The one exception is a
// single "prefill sync": if the player has a locally-stored name that
// differs from what the server currently has for them, it's sent once on
// the first snapshot that reveals that mismatch (see `syncStoredNameOnce`).

import Phaser from "phaser";
import { MAX_NAME_LENGTH, MAX_PLAYERS, PLAYER_COLORS, PLAYER_COLOR_ORDER } from "@frogtato/shared";
import type { FrogClassId, PlayerSnap } from "@frogtato/shared";
import type { NetClient, ConnectionStatus } from "../net.js";
import { routeToPhase } from "../ui/phaseRouter.js";
import { buildClassCardViews, classInitial, type ClassCardView } from "../ui/classCards.js";
import { sanitizeName, loadStoredName, storeName, displayName } from "../ui/nameField.js";

function colorHexFor(colorIndex: number): string {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return PLAYER_COLORS[name];
}

const CARD_WIDTH = 280;
const CARD_HEIGHT = 168;
const CARD_GAP = 20;
const CARDS_TOP_Y = 220;

const COLOR_CARD_BG = 0x14201c;
const COLOR_CARD_BG_OWN = 0x1f3d2c;
const COLOR_CARD_STROKE = 0x455a64;
const COLOR_CARD_STROKE_OWN = 0xffeb3b;

interface ClassCardUi {
  view: ClassCardView;
  box: Phaser.GameObjects.Rectangle;
  title: Phaser.GameObjects.Text;
  body: Phaser.GameObjects.Text;
}

export class LobbyScene extends Phaser.Scene {
  private net!: NetClient;
  private statusText!: Phaser.GameObjects.Text;
  private countText!: Phaser.GameObjects.Text;
  private playerListText!: Phaser.GameObjects.Text;
  private unsubscribers: Array<() => void> = [];

  private classCards: ClassCardUi[] = [];
  private ownClassId: FrogClassId | null = null;

  private nameInput: HTMLInputElement | null = null;
  private nameInputAnchorX = 0;
  private nameInputAnchorY = 0;
  private hasSyncedStoredName = false;

  private swatches: Phaser.GameObjects.Rectangle[] = [];

  constructor() {
    super("Lobby");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.ownClassId = null;
    this.hasSyncedStoredName = false;

    this.cameras.main.setBackgroundColor("#0a2233");

    this.add
      .text(this.scale.width / 2, 40, "FROGTATO", {
        fontFamily: "sans-serif",
        fontSize: "44px",
        color: "#e8f5e9",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(this.scale.width / 2, 92, "connecting…", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#b0bec5",
      })
      .setOrigin(0.5);

    this.add
      .text(this.scale.width / 2, 118, "Pick your class", {
        fontFamily: "sans-serif",
        fontSize: "18px",
        color: "#cfd8dc",
      })
      .setOrigin(0.5);

    this.buildClassCards();
    this.createNameInput();

    this.countText = this.add
      .text(this.scale.width / 2, CARDS_TOP_Y + CARD_HEIGHT + 30, `0/${MAX_PLAYERS} frogs in the pond`, {
        fontFamily: "sans-serif",
        fontSize: "20px",
        color: "#e8f5e9",
      })
      .setOrigin(0.5);

    this.playerListText = this.add
      .text(this.scale.width / 2, CARDS_TOP_Y + CARD_HEIGHT + 64, "waiting for players…", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#cfd8dc",
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    const startButton = this.add
      .text(this.scale.width / 2, this.scale.height - 40, "  Start  ", {
        fontFamily: "sans-serif",
        fontSize: "26px",
        color: "#101418",
        backgroundColor: "#4caf50",
      })
      .setOrigin(0.5)
      .setPadding(16, 10, 16, 10)
      .setInteractive({ useHandCursor: true });

    startButton.on("pointerdown", () => {
      this.net.send({ type: "start" });
    });

    this.unsubscribers.push(
      this.net.onStatus((status) => this.renderStatus(status)),
      this.net.onWelcome((msg) => routeToPhase(this, msg.phase)),
      this.net.onSnapshot((snap) => {
        this.renderPlayers(snap.players);
        this.syncStoredNameOnce(snap.players);
        routeToPhase(this, snap.phase);
      }),
    );

    this.renderStatus(this.net.status);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers = [];
      this.destroyNameInput();
    });
  }

  // -------------------------------------------------------------------
  // Class cards
  // -------------------------------------------------------------------

  private buildClassCards(): void {
    const views = buildClassCardViews();
    const totalWidth = views.length * CARD_WIDTH + (views.length - 1) * CARD_GAP;
    const startX = this.scale.width / 2 - totalWidth / 2;

    this.classCards = views.map((view, i) => {
      const x = startX + i * (CARD_WIDTH + CARD_GAP);
      const y = CARDS_TOP_Y;

      const box = this.add
        .rectangle(x, y, CARD_WIDTH, CARD_HEIGHT, COLOR_CARD_BG)
        .setOrigin(0, 0)
        .setStrokeStyle(2, COLOR_CARD_STROKE)
        .setInteractive({ useHandCursor: true });

      const title = this.add.text(x + 14, y + 12, view.displayName, {
        fontFamily: "sans-serif",
        fontSize: "20px",
        fontStyle: "bold",
        color: "#e8f5e9",
      });

      const body = this.add.text(
        x + 14,
        y + 44,
        `${view.description}\n\n${view.statSummary}\n\nStarts with: ${view.startingWeaponLabel}`,
        {
          fontFamily: "sans-serif",
          fontSize: "13px",
          color: "#cfd8dc",
          wordWrap: { width: CARD_WIDTH - 28 },
          lineSpacing: 4,
        },
      );

      box.on("pointerdown", () => {
        // User action only — this is the sole place pickClass is ever sent.
        this.net.send({ type: "pickClass", class: view.id });
      });

      return { view, box, title, body };
    });
  }

  /** Highlights whichever card matches the server-reported own class. Never
   * assumes the last click "took" — always reflects the live snapshot. */
  private refreshClassCardHighlight(): void {
    for (const card of this.classCards) {
      const isOwn = card.view.id === this.ownClassId;
      card.box.setFillStyle(isOwn ? COLOR_CARD_BG_OWN : COLOR_CARD_BG);
      card.box.setStrokeStyle(isOwn ? 3 : 2, isOwn ? COLOR_CARD_STROKE_OWN : COLOR_CARD_STROKE);
    }
  }

  // -------------------------------------------------------------------
  // Name field (plain HTML <input> overlaid on the canvas — simplest way
  // to get real text entry without pulling in Phaser's DOM Element plugin
  // for a single field).
  // -------------------------------------------------------------------

  private createNameInput(): void {
    const canvas = this.game.canvas as HTMLCanvasElement | undefined;
    const parent = canvas?.parentElement ?? document.body;
    // Anchor absolute positioning to the canvas's own container so the
    // field tracks it regardless of how the page centers the game.
    if (parent instanceof HTMLElement && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = MAX_NAME_LENGTH;
    input.placeholder = "Your name";
    input.value = loadStoredName();
    input.autocomplete = "off";
    input.spellcheck = false;
    Object.assign(input.style, {
      position: "absolute",
      width: "200px",
      font: "16px sans-serif",
      padding: "6px 10px",
      borderRadius: "4px",
      border: "1px solid #4caf50",
      background: "#0a2233",
      color: "#e8f5e9",
      textAlign: "center",
      outline: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    this.nameInputAnchorX = this.scale.width / 2 - 100;
    this.nameInputAnchorY = 150;
    this.positionNameInput(input, canvas);

    const commit = () => {
      const sanitized = sanitizeName(input.value);
      input.value = sanitized;
      storeName(sanitized);
      if (sanitized.length > 0) {
        this.net.send({ type: "setName", name: sanitized });
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        commit();
        input.blur();
      }
    });

    parent.appendChild(input);
    this.nameInput = input;
  }

  private positionNameInput(input: HTMLInputElement, canvas: HTMLCanvasElement | undefined): void {
    const offsetX = canvas?.offsetLeft ?? 0;
    const offsetY = canvas?.offsetTop ?? 0;
    input.style.left = `${offsetX + this.nameInputAnchorX}px`;
    input.style.top = `${offsetY + this.nameInputAnchorY}px`;
  }

  private destroyNameInput(): void {
    this.nameInput?.remove();
    this.nameInput = null;
  }

  /** One-shot: if a locally-stored name exists and differs from what the
   * server currently has for us, push it once. Never fires again this
   * scene lifetime, so it can't clobber a later server-side rename. */
  private syncStoredNameOnce(players: PlayerSnap[]): void {
    if (this.hasSyncedStoredName) return;
    const own = players.find((p) => p.id === this.net.playerId);
    if (!own) return; // wait for our own row to appear in a snapshot

    this.hasSyncedStoredName = true;
    const stored = sanitizeName(loadStoredName());
    if (stored.length > 0 && stored !== (own.name ?? "")) {
      this.net.send({ type: "setName", name: stored });
    }
  }

  // -------------------------------------------------------------------
  // Status / player list
  // -------------------------------------------------------------------

  private renderStatus(status: ConnectionStatus): void {
    const label = status === "open" ? "connected" : status === "closed" ? "disconnected" : "connecting…";
    this.statusText.setText(label);
    this.statusText.setColor(status === "open" ? "#81c784" : "#ef9a9a");
  }

  private renderPlayers(players: PlayerSnap[]): void {
    const nonSpectators = players.filter((p) => !p.spectator);
    this.countText.setText(`${nonSpectators.length}/${MAX_PLAYERS} frogs in the pond`);

    const own = players.find((p) => p.id === this.net.playerId);
    this.ownClassId = own?.class ?? null;
    this.refreshClassCardHighlight();

    if (players.length === 0) {
      this.playerListText.setText("waiting for players…");
      this.renderSwatches([]);
      return;
    }
    const lines = players.map((p, i) => `● ${displayName(p, i)} [${classInitial(p.class)}]`);
    this.playerListText.setText(lines.join("\n"));

    // Recolor each line's bullet to match the player's palette color by
    // rebuilding as separate colored text objects would be more work than
    // this task warrants; a single multi-color swatch row is simpler and
    // still shows "connected players" at a glance.
    this.renderSwatches(players);
  }

  private renderSwatches(players: PlayerSnap[]): void {
    for (const s of this.swatches) s.destroy();
    this.swatches = [];

    const baseY = CARDS_TOP_Y + CARD_HEIGHT + 64 + players.length * 22 + 20;
    const totalWidth = players.length * 28;
    const startX = this.scale.width / 2 - totalWidth / 2 + 14;

    players.forEach((p, i) => {
      const hex = Phaser.Display.Color.HexStringToColor(colorHexFor(p.color)).color;
      const swatch = this.add.rectangle(startX + i * 28, baseY, 20, 20, hex);
      this.swatches.push(swatch);
    });
  }
}
