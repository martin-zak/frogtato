// Boot scene: place for future asset preloading. Nothing is required yet
// (art is loaded ad hoc by GameScene / LobbyScene where it's used), so this
// scene just hands off to Lobby immediately.

import Phaser from "phaser";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    // No required assets for the walking-skeleton milestone (T4). Later
    // tasks (sprite polish) will load client/assets/sprites/* here.
  }

  create(): void {
    this.scene.start("Lobby");
  }
}
