import Phaser from "phaser";
import { SERVER_PORT } from "@frogtato/shared";

console.log("[frogtato] shared constants loaded, server port:", SERVER_PORT);

class BootScene extends Phaser.Scene {
  create(): void {
    this.cameras.main.setBackgroundColor("#101418");
    this.add
      .text(this.scale.width / 2, this.scale.height / 2, "Frogtato", {
        fontFamily: "sans-serif",
        fontSize: "48px",
        color: "#e8f5e9",
      })
      .setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  width: 800,
  height: 600,
  backgroundColor: "#101418",
  scene: [BootScene],
});

const socket = new WebSocket("ws://localhost:8080");
socket.addEventListener("open", () => {
  console.log("open");
});
