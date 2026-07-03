import { describe, expect, it, vi } from "vitest";
import { sceneKeyForPhase, routeToPhase, type PhaseRoutableScene } from "./phaseRouter.js";

function makeScene(key: string, registeredKeys: string[]): PhaseRoutableScene & { starts: string[] } {
  const starts: string[] = [];
  return {
    starts,
    scene: {
      key,
      start: (target: string) => starts.push(target),
      manager: { keys: Object.fromEntries(registeredKeys.map((k) => [k, {}])) },
    },
  };
}

describe("sceneKeyForPhase", () => {
  it("maps every phase to its scene key", () => {
    expect(sceneKeyForPhase("lobby")).toBe("Lobby");
    expect(sceneKeyForPhase("wave")).toBe("Game");
    expect(sceneKeyForPhase("shop")).toBe("ShopScene");
    expect(sceneKeyForPhase("scoreboard")).toBe("GameOver");
  });
});

describe("routeToPhase", () => {
  it("starts the target scene when the phase differs from the current scene", () => {
    const scene = makeScene("Lobby", ["Lobby", "Game", "GameOver", "ShopScene"]);
    routeToPhase(scene, "wave");
    expect(scene.starts).toEqual(["Game"]);
  });

  it("is a no-op when already on the scene the phase maps to", () => {
    const scene = makeScene("Game", ["Lobby", "Game"]);
    routeToPhase(scene, "wave");
    expect(scene.starts).toEqual([]);
  });

  it("lands in GameScene when welcome reports phase wave (T4 behavior preserved)", () => {
    const scene = makeScene("Lobby", ["Lobby", "Game"]);
    routeToPhase(scene, "wave");
    expect(scene.starts).toEqual(["Game"]);
  });

  it("routes scoreboard to GameOver", () => {
    const scene = makeScene("Game", ["Lobby", "Game", "GameOver"]);
    routeToPhase(scene, "scoreboard");
    expect(scene.starts).toEqual(["GameOver"]);
  });

  it("warns and stays put when phase is shop but ShopScene isn't registered yet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scene = makeScene("Game", ["Lobby", "Game", "GameOver"]); // no ShopScene registered
    routeToPhase(scene, "shop");
    expect(scene.starts).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("routes to ShopScene once it is registered", () => {
    const scene = makeScene("Game", ["Lobby", "Game", "GameOver", "ShopScene"]);
    routeToPhase(scene, "shop");
    expect(scene.starts).toEqual(["ShopScene"]);
  });
});
