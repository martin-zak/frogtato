// Central registry of asset loader/texture keys, shared between BootScene
// (which loads everything) and entities.ts/effects.ts (which reference the
// textures/sounds by key). Keeping the strings in one place avoids
// hand-typed duplicates drifting apart.

export const SPRITE_KEYS = {
  frog: "frog",
  wasp: "wasp",
  snail: "snail",
  acidGlob: "acidGlob",
  bubble: "bubble",
  flyPickup: "flyPickup",
  tongue: "tongue",
  croakRing: "croakRing",
  lilypad: "lilypad",
  lilypad2: "lilypad2",
  lilypad3: "lilypad3",
} as const;

export const SFX_KEYS = {
  tongue: "sfxTongue",
  bubble: "sfxBubble",
  croak: "sfxCroak",
  hit: "sfxHit",
  pickup: "sfxPickup",
  down: "sfxDown",
  poof: "sfxPoof",
} as const;

export const MUSIC_KEYS = {
  loop: "musicLoop",
} as const;

/** Wasp/snail are loaded as single rasterized images with two manually
 * registered frames (0, 1) rather than a true Phaser spritesheet — see
 * BootScene.ts for why. Frame size per sprite, used both when registering
 * the frames and when rendering. */
export const WASP_FRAME = { width: 32, height: 32 };
export const SNAIL_FRAME = { width: 40, height: 40 };
