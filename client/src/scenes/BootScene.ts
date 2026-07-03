// Boot scene: preloads every sprite/audio asset the game needs before
// handing off to Lobby. See client/assets/MANIFEST.md for asset details.
//
// SVG loading notes (see PLAN T7):
//  - Single-frame sprites (frog, projectiles, ring, lilypads) load via
//    `this.load.svg(key, url, { width, height })`, which rasterizes the SVG
//    to that pixel size as one texture — straightforward.
//  - Wasp/snail are 2-frame sheets *inside a single SVG* (frames laid out
//    side by side in the viewBox). Phaser's `load.spritesheet` expects a
//    rasterizable image URL + frameWidth/frameHeight, and does not accept
//    an SVG size config the way `load.svg` does, so slicing frames out of
//    an SVG source via `spritesheet()` is unreliable. Instead we load the
//    whole sheet as ONE image via `load.svg(key, url, { width, height })`
//    at its full rasterized size (64x32 for wasp, 80x40 for snail), then in
//    `create()` manually register two frame rects on that texture via
//    `Texture.add(frameIndex, 0, x, y, w, h)`. This gives sprites a normal
//    `setFrame(0|1)` API without ever going through the spritesheet loader.
import Phaser from "phaser";
import { SPRITE_KEYS, SFX_KEYS, WASP_FRAME, SNAIL_FRAME } from "../render/assetKeys.js";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("Boot");
  }

  preload(): void {
    this.load.svg(SPRITE_KEYS.frog, "sprites/frog.svg", { width: 48, height: 48 });
    this.load.svg(SPRITE_KEYS.wasp, "sprites/wasp.svg", { width: WASP_FRAME.width * 2, height: WASP_FRAME.height });
    this.load.svg(SPRITE_KEYS.snail, "sprites/snail.svg", { width: SNAIL_FRAME.width * 2, height: SNAIL_FRAME.height });
    this.load.svg(SPRITE_KEYS.acidGlob, "sprites/acid-glob.svg", { width: 12, height: 12 });
    this.load.svg(SPRITE_KEYS.bubble, "sprites/bubble.svg", { width: 14, height: 14 });
    this.load.svg(SPRITE_KEYS.flyPickup, "sprites/fly-pickup.svg", { width: 16, height: 16 });
    this.load.svg(SPRITE_KEYS.tongue, "sprites/tongue.svg", { width: 8, height: 32 });
    this.load.svg(SPRITE_KEYS.croakRing, "sprites/croak-ring.svg", { width: 64, height: 64 });
    this.load.svg(SPRITE_KEYS.lilypad, "sprites/lilypad.svg", { width: 96, height: 96 });
    this.load.svg(SPRITE_KEYS.lilypad2, "sprites/lilypad2.svg", { width: 96, height: 96 });
    this.load.svg(SPRITE_KEYS.lilypad3, "sprites/lilypad3.svg", { width: 96, height: 96 });

    this.load.audio(SFX_KEYS.tongue, "audio/sfx-tongue.wav");
    this.load.audio(SFX_KEYS.bubble, "audio/sfx-bubble.wav");
    this.load.audio(SFX_KEYS.croak, "audio/sfx-croak.wav");
    this.load.audio(SFX_KEYS.hit, "audio/sfx-hit.wav");
    this.load.audio(SFX_KEYS.pickup, "audio/sfx-pickup.wav");
    this.load.audio(SFX_KEYS.down, "audio/sfx-down.wav");
    // music-loop.wav intentionally NOT loaded here — owned by a later task (T12b).
  }

  create(): void {
    // Manually register the two side-by-side frames of the wasp/snail
    // sheets (loaded as single rasterized images above) so sprites can use
    // `setFrame(0)` / `setFrame(1)` like a normal spritesheet.
    this.registerTwoFrameSheet(SPRITE_KEYS.wasp, WASP_FRAME.width, WASP_FRAME.height);
    this.registerTwoFrameSheet(SPRITE_KEYS.snail, SNAIL_FRAME.width, SNAIL_FRAME.height);

    this.scene.start("Lobby");
  }

  private registerTwoFrameSheet(key: string, frameWidth: number, frameHeight: number): void {
    const texture = this.textures.get(key);
    texture.add(0, 0, 0, 0, frameWidth, frameHeight);
    texture.add(1, 0, frameWidth, 0, frameWidth, frameHeight);
  }
}
