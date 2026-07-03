// Victory / Game Over scene: shared by both the `gameOver` and `victory`
// end events (DESIGN §2/§8) — same layout, different headline. Shows the
// scoreboard captured by endScreenStore.ts (populated by GameScene while
// the event fires, since the server flips `phase` to "scoreboard" only on
// the following snapshot). Returns to Lobby purely when a later
// welcome/snapshot reports phase "lobby" — never on a timer or local guess.

import Phaser from "phaser";
import { PLAYER_COLORS, PLAYER_COLOR_ORDER } from "@frogtato/shared";
import type { Phase, ScoreRow } from "@frogtato/shared";
import type { NetClient } from "../net.js";
import { getLastEndScreenResult } from "../ui/endScreenStore.js";
import { routeToPhase } from "../ui/phaseRouter.js";
import { displayName } from "../ui/nameField.js";

function colorHexFor(colorIndex: number): number {
  const name = PLAYER_COLOR_ORDER[colorIndex % PLAYER_COLOR_ORDER.length];
  return Phaser.Display.Color.HexStringToColor(PLAYER_COLORS[name]).color;
}

const ROW_HEIGHT = 28;
const TABLE_TOP = 220;

export class GameOverScene extends Phaser.Scene {
  private net!: NetClient;
  private unsubscribers: Array<() => void> = [];
  private rowObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("GameOver");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;

    const result = getLastEndScreenResult();
    const isVictory = result?.kind === "victory";

    this.cameras.main.setBackgroundColor(isVictory ? "#0a3320" : "#2a0a0a");

    this.add
      .text(this.scale.width / 2, 60, isVictory ? "VICTORY!" : "GAME OVER", {
        fontFamily: "sans-serif",
        fontSize: "52px",
        fontStyle: "bold",
        color: isVictory ? "#a5d6a7" : "#ef9a9a",
      })
      .setOrigin(0.5);

    this.renderScoreboard(result?.scoreboard ?? []);

    this.add
      .text(this.scale.width / 2, this.scale.height - 40, "returning to pond…", {
        fontFamily: "sans-serif",
        fontSize: "16px",
        color: "#b0bec5",
      })
      .setOrigin(0.5);

    const route = (phase: Phase) => routeToPhase(this, phase);

    this.unsubscribers.push(
      this.net.onWelcome((msg) => route(msg.phase)),
      this.net.onSnapshot((snap) => route(snap.phase)),
    );

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const unsub of this.unsubscribers) unsub();
      this.unsubscribers = [];
    });
  }

  private renderScoreboard(rows: readonly ScoreRow[]): void {
    for (const obj of this.rowObjects) obj.destroy();
    this.rowObjects = [];

    const centerX = this.scale.width / 2;

    if (rows.length === 0) {
      const empty = this.add
        .text(centerX, TABLE_TOP, "no scoreboard data", {
          fontFamily: "sans-serif",
          fontSize: "16px",
          color: "#78909c",
        })
        .setOrigin(0.5);
      this.rowObjects.push(empty);
      return;
    }

    const header = this.add
      .text(centerX, TABLE_TOP - ROW_HEIGHT, "player          kills   dmg    flies", {
        fontFamily: "monospace",
        fontSize: "15px",
        color: "#78909c",
      })
      .setOrigin(0.5);
    this.rowObjects.push(header);

    // Look up player colors from the latest snapshot (the ScoreRow itself
    // has no color field); falls back to a neutral gray if that player's
    // no longer present in the snapshot (e.g. disconnected).
    const latest = this.net.getLatestSnapshot();
    const colorByPlayerId = new Map<string, number>();
    if (latest) {
      for (const p of latest.snapshot.players) colorByPlayerId.set(p.id, p.color);
    }

    rows.forEach((row, i) => {
      const y = TABLE_TOP + i * ROW_HEIGHT;
      const colorIndex = colorByPlayerId.get(row.playerId);
      const swatchColor = colorIndex !== undefined ? colorHexFor(colorIndex) : 0x616161;

      const swatch = this.add.rectangle(centerX - 190, y, 16, 16, swatchColor);
      const name = displayName(row, i).slice(0, 12).padEnd(12, " ");
      const line = this.add
        .text(
          centerX - 170,
          y,
          `${name} ${String(row.kills).padStart(5)} ${String(Math.round(row.damageDealt)).padStart(6)} ${String(row.fliesCollected).padStart(6)}`,
          {
            fontFamily: "monospace",
            fontSize: "15px",
            color: "#e8f5e9",
          },
        )
        .setOrigin(0, 0.5);

      this.rowObjects.push(swatch, line);
    });
  }
}
