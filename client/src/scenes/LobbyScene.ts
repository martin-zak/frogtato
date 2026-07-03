// Lobby scene: shows connection status + the list of connected players
// (name/color, from the live snapshot buffer) and a Start button.
//
// Per PLAN T4: the phase machine (T8) doesn't exist yet, so the server is
// always in phase "wave". As soon as we see that — in `welcome` or in any
// snapshot — skip straight to GameScene instead of waiting at the button.

import Phaser from "phaser";
import { PLAYER_COLORS, PLAYER_COLOR_ORDER } from "@frogtato/shared";
import type { PlayerSnap } from "@frogtato/shared";
import type { NetClient, ConnectionStatus } from "../net.js";

function colorHexFor(colorIndex: number): string {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return PLAYER_COLORS[name];
}

export class LobbyScene extends Phaser.Scene {
  private net!: NetClient;
  private statusText!: Phaser.GameObjects.Text;
  private playerListText!: Phaser.GameObjects.Text;
  private unsubscribers: Array<() => void> = [];
  private started = false;

  constructor() {
    super("Lobby");
  }

  create(): void {
    this.started = false;
    this.net = this.registry.get("net") as NetClient;

    this.cameras.main.setBackgroundColor("#0a2233");

    this.add
      .text(this.scale.width / 2, 80, "FROGTATO", {
        fontFamily: "sans-serif",
        fontSize: "56px",
        color: "#e8f5e9",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(this.scale.width / 2, 140, "connecting…", {
        fontFamily: "sans-serif",
        fontSize: "18px",
        color: "#b0bec5",
      })
      .setOrigin(0.5);

    this.add
      .text(this.scale.width / 2, 190, "Players", {
        fontFamily: "sans-serif",
        fontSize: "22px",
        color: "#e8f5e9",
      })
      .setOrigin(0.5);

    this.playerListText = this.add
      .text(this.scale.width / 2, 230, "waiting for players…", {
        fontFamily: "sans-serif",
        fontSize: "18px",
        color: "#cfd8dc",
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    const startButton = this.add
      .text(this.scale.width / 2, 420, "  Start  ", {
        fontFamily: "sans-serif",
        fontSize: "28px",
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
      this.net.onWelcome((msg) => {
        if (msg.phase === "wave") this.goToGame();
      }),
      this.net.onSnapshot((snap) => {
        this.renderPlayers(snap.players);
        if (snap.phase === "wave") this.goToGame();
      }),
    );

    this.renderStatus(this.net.status);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers = [];
    });
  }

  private renderStatus(status: ConnectionStatus): void {
    const label = status === "open" ? "connected" : status === "closed" ? "disconnected" : "connecting…";
    this.statusText.setText(label);
    this.statusText.setColor(status === "open" ? "#81c784" : "#ef9a9a");
  }

  private renderPlayers(players: PlayerSnap[]): void {
    if (players.length === 0) {
      this.playerListText.setText("waiting for players…");
      return;
    }
    const lines = players.map((p) => `● ${p.name ?? p.id}`);
    this.playerListText.setText(lines.join("\n"));

    // Recolor each line's bullet to match the player's palette color by
    // rebuilding as separate colored text objects would be more work than
    // this task warrants; a single multi-color swatch row is simpler and
    // still shows "connected players" at a glance.
    this.renderSwatches(players);
  }

  private swatches: Phaser.GameObjects.Rectangle[] = [];

  private renderSwatches(players: PlayerSnap[]): void {
    for (const s of this.swatches) s.destroy();
    this.swatches = [];

    const baseY = 230 + players.length * 22 + 20;
    const totalWidth = players.length * 28;
    const startX = this.scale.width / 2 - totalWidth / 2 + 14;

    players.forEach((p, i) => {
      const hex = Phaser.Display.Color.HexStringToColor(colorHexFor(p.color)).color;
      const swatch = this.add.rectangle(startX + i * 28, baseY, 20, 20, hex);
      this.swatches.push(swatch);
    });
  }

  private goToGame(): void {
    if (this.started) return;
    this.started = true;
    this.scene.start("Game");
  }
}
