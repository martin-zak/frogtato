// Compile-time / type-level sanity checks for the protocol message unions.
// These exist to catch accidental drift (a missing case in an exhaustive
// switch fails to typecheck, not just fails at runtime).
import { describe, expect, it } from "vitest";
import type { ClientMsg, GameEvent, ServerMsg } from "./messages.js";
import { OFFER_IDS, makeIdFactory } from "./ids.js";

function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

function exhaustiveClientMsg(msg: ClientMsg): string {
  switch (msg.type) {
    case "hello":
      return "hello";
    case "input":
      return "input";
    case "start":
      return "start";
    case "buy":
      return "buy";
    case "ready":
      return "ready";
    case "debug":
      return "debug";
    case "pickClass":
      return "pickClass";
    case "setName":
      return "setName";
    case "merge":
      return "merge";
    default:
      return assertNever(msg);
  }
}

function exhaustiveServerMsg(msg: ServerMsg): string {
  switch (msg.type) {
    case "welcome":
      return "welcome";
    case "snapshot":
      return "snapshot";
    case "event":
      return "event";
    default:
      return assertNever(msg);
  }
}

function exhaustiveGameEvent(event: GameEvent): string {
  switch (event.type) {
    case "waveStart":
      return "waveStart";
    case "waveEnd":
      return "waveEnd";
    case "playerDowned":
      return "playerDowned";
    case "enemyDied":
      return "enemyDied";
    case "attack":
      return "attack";
    case "playerHit":
      return "playerHit";
    case "purchaseResult":
      return "purchaseResult";
    case "gameOver":
      return "gameOver";
    case "victory":
      return "victory";
    case "playerJoined":
      return "playerJoined";
    case "playerLeft":
      return "playerLeft";
    case "classPicked":
      return "classPicked";
    case "merged":
      return "merged";
    case "bossSpawned":
      return "bossSpawned";
    case "bossDied":
      return "bossDied";
    default:
      return assertNever(event);
  }
}

describe("protocol message unions", () => {
  it("ClientMsg switch is exhaustive", () => {
    const msg: ClientMsg = { type: "hello" };
    expect(exhaustiveClientMsg(msg)).toBe("hello");
  });

  it("ServerMsg switch is exhaustive", () => {
    const msg: ServerMsg = { type: "welcome", playerId: "p1", token: "t1", phase: "lobby" };
    expect(exhaustiveServerMsg(msg)).toBe("welcome");
  });

  it("GameEvent switch is exhaustive", () => {
    const event: GameEvent = { type: "waveStart", wave: 1 };
    expect(exhaustiveGameEvent(event)).toBe("waveStart");
  });

  it("input message shape carries seq + directional flags", () => {
    const msg: ClientMsg = { type: "input", seq: 1, up: true, down: false, left: false, right: true };
    expect(msg.seq).toBe(1);
  });

  it("debug message optional fields typecheck", () => {
    const msg: ClientMsg = {
      type: "debug",
      kill: "enemy-1",
      give: { slot: 0, weapon: "tongue", level: 2 },
      timescale: 10,
      invincible: true,
      grantFlies: 100,
    };
    expect(msg.type).toBe("debug");
  });

  it("snapshot message carries all entity arrays", () => {
    const msg: ServerMsg = {
      type: "snapshot",
      tick: 1,
      phase: "wave",
      wave: 1,
      players: [],
      enemies: [],
      projectiles: [],
      flies: [],
    };
    expect(msg.players).toEqual([]);
  });

  it("OFFER_IDS matches the SHOP_CATALOG/STAT_SHOP_OFFERS ids plus the upgrade and merge ids", () => {
    expect(OFFER_IDS).toEqual([
      "buyTongueLash",
      "buyBubbleBlaster",
      "buyCroakNova",
      "upgradeSlot",
      "buyMaxHp",
      "buyDamage",
      "buyMoveSpeed",
      "buyArmor",
      "buyRegen",
      "buyPickupRadius",
      "merge",
    ]);
  });

  it("pickClass/setName/merge messages typecheck", () => {
    const pick: ClientMsg = { type: "pickClass", class: "bullfrog" };
    const name: ClientMsg = { type: "setName", name: "Kermit" };
    const merge: ClientMsg = { type: "merge" };
    expect(pick.type).toBe("pickClass");
    expect(name.type).toBe("setName");
    expect(merge.type).toBe("merge");
  });

  it("classPicked/merged/bossSpawned/bossDied events typecheck", () => {
    const classPicked: GameEvent = { type: "classPicked", playerId: "p1", class: "treefrog" };
    const merged: GameEvent = { type: "merged", playerId: "p1", slot: 0, newLevel: 2 };
    const bossSpawned: GameEvent = { type: "bossSpawned" };
    const bossDied: GameEvent = { type: "bossDied" };
    expect(classPicked.class).toBe("treefrog");
    expect(merged.newLevel).toBe(2);
    expect(bossSpawned.type).toBe("bossSpawned");
    expect(bossDied.type).toBe("bossDied");
  });

  it("makeIdFactory produces prefixed incrementing ids", () => {
    const nextId = makeIdFactory("enemy");
    expect(nextId()).toBe("enemy-1");
    expect(nextId()).toBe("enemy-2");
  });
});
