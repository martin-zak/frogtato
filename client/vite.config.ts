import { defineConfig } from "vite";

export default defineConfig({
  // client/assets/** (sprites/audio) is served at the page root, e.g.
  // client/assets/sprites/frog.svg -> /sprites/frog.svg, matching the
  // relative paths BootScene passes to Phaser's loader.
  publicDir: "assets",
  server: {
    port: 5173,
    // Expose on the LAN so other machines can join (DESIGN §8: friends
    // connect to your dev server directly in v0.1).
    host: true,
  },
});
