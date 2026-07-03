import Phaser from "phaser";
import { SERVER_PORT } from "@frogtato/shared";
import { NetClient } from "./net.js";
import { BootScene } from "./scenes/BootScene.js";
import { LobbyScene } from "./scenes/LobbyScene.js";
import { GameScene } from "./scenes/GameScene.js";
import { GameOverScene } from "./scenes/GameOverScene.js";
import { ShopScene } from "./scenes/ShopScene.js";

console.log(`[frogtato] connecting to server on port ${SERVER_PORT}`);

const net = new NetClient();
net.connect();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  width: 960,
  height: 720,
  backgroundColor: "#101418",
  scene: [BootScene, LobbyScene, GameScene, ShopScene, GameOverScene],
});

// Shared across all scenes via the registry rather than re-instantiated per
// scene, so there is exactly one websocket connection for the client's
// lifetime.
game.registry.set("net", net);
