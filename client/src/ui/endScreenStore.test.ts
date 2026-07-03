import { describe, expect, it, beforeEach } from "vitest";
import { captureEndScreenEvent, getLastEndScreenResult, resetEndScreenStoreForTest } from "./endScreenStore.js";
import type { GameEvent } from "@frogtato/shared";

beforeEach(() => {
  resetEndScreenStoreForTest();
});

describe("endScreenStore", () => {
  it("returns null before any gameOver/victory event has been observed", () => {
    expect(getLastEndScreenResult()).toBeNull();
  });

  it("captures a victory event's scoreboard", () => {
    const event: GameEvent = {
      type: "victory",
      scoreboard: [{ playerId: "p1", kills: 3, damageDealt: 40, fliesCollected: 12 }],
    };
    captureEndScreenEvent(event);
    expect(getLastEndScreenResult()).toEqual({ kind: "victory", scoreboard: event.scoreboard });
  });

  it("captures a gameOver event's scoreboard", () => {
    const event: GameEvent = {
      type: "gameOver",
      scoreboard: [{ playerId: "p1", kills: 1, damageDealt: 5, fliesCollected: 2 }],
    };
    captureEndScreenEvent(event);
    expect(getLastEndScreenResult()).toEqual({ kind: "gameOver", scoreboard: event.scoreboard });
  });

  it("ignores unrelated events", () => {
    captureEndScreenEvent({ type: "waveStart", wave: 1 });
    expect(getLastEndScreenResult()).toBeNull();
  });

  it("a later event replaces an earlier one", () => {
    captureEndScreenEvent({ type: "gameOver", scoreboard: [] });
    captureEndScreenEvent({ type: "victory", scoreboard: [{ playerId: "p2", kills: 9, damageDealt: 99, fliesCollected: 9 }] });
    expect(getLastEndScreenResult()?.kind).toBe("victory");
  });
});
