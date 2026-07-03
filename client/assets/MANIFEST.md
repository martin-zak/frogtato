# Frogtato asset staging — manifest

Produced by the T12 art & audio agent. Everything below is original work
generated for this project (see `audio/CREDITS.md`); nothing was downloaded.

**Rasterization note:** no PNG rasterizer was available on this machine
(checked `rsvg-convert`, `inkscape`, `convert`/`magick`, and Python
`PIL`/`cairosvg`/`pycairo` — none installed; per instructions, nothing was
installed to work around this). All sprites are shipped as **clean, valid
SVG only** (verified parseable via `python3 -m xml.dom.minidom`). The task
card names some files `.png` — treat every `*.png` filename below as the
matching `*.svg` in `sprites/` until a rasterization step (Inkscape CLI,
`sharp`, `resvg`, etc.) is added to the build or CI. All SVGs use simple
shapes/gradients/blur only (no external refs, no raster embeds), so they
rasterize cleanly with any standard SVG renderer at any target size.

## sprites/

| File | Size | Use | Frames |
|---|---|---|---|
| `frog.svg` | 48×48 viewBox | Player frog, top-down-ish. Drawn in **white fill / black outline only** so Phaser's multiply-tint recolors it per player (green/blue/orange/pink) without touching the black linework or pupils. | 1 |
| `wasp.svg` | 64×32 viewBox (2 × 32×32) | Wasp enemy. Sprite sheet, frames side by side: frame 0 = wings up (x 0–32), frame 1 = wings down (x 32–64). Alternate frames for the wobble/flutter. | 2 |
| `snail.svg` | 80×40 viewBox (2 × 40×40) | Snail Spitter enemy. Sprite sheet: frame 0 = shell neutral (x 0–40), frame 1 = shell tilted ~6° (x 40–80). Alternate for idle shell-wobble. | 2 |
| `acid-glob.svg` | 12×12 | Snail's acid-glob projectile. | 1 |
| `bubble.svg` | 14×14 | Bubble Blaster projectile; translucent (fill-opacity ~0.45) so it reads as a bubble over any background. | 1 |
| `fly-pickup.svg` | 16×16 | Fly currency pickup. | 1 |
| `tongue.svg` | 8×32 | Tongue Lash attack segment. Straight base at y=0 (anchor at frog's mouth), rounded tip at y=32. Meant to be non-uniformly scaled (stretched) toward the attack target by the client, per DESIGN §10. | 1 |
| `croak-ring.svg` | 64×64 | Croak Nova shockwave ring. Plain white stroke ring with a soft blurred outer pass + a crisp inner pass, meant to be scaled up and faded out over the attack's duration, and tintable. | 1 |
| `lilypad.svg` | 96×96 | Lily pad decoration, variant 1 (round pad, wedge notch, mid green). | 1 |
| `lilypad2.svg` | 96×96 | Lily pad decoration, variant 2 (rotated 110°, slightly smaller, lighter green) — cheap palette/transform variant of variant 1. | 1 |
| `lilypad3.svg` | 96×96 | Lily pad decoration, variant 3 (rotated 230°, darker teal-green, tiny pink flower accent). | 1 |

**Palette:** pond greens (`#4c9a5b`/`#57a866`/`#3f8f5a` pads, `#8fd694` snail foot),
blues (`#bfe9ff` bubble), warm accents (`#ffcc33` wasp stripes, `#ff6f91` tongue,
`#c97a3d` snail shell). Flat fills, consistent ~1.5–2.5px black outlines throughout
(matching DESIGN §10's "flat-color, bold outlines" style), transparent backgrounds.

## audio/

| File | Duration | Use |
|---|---|---|
| `sfx-tongue.wav` | 0.12 s | Tongue Lash fire — filtered-noise crack + fast downward-pitch square blip. |
| `sfx-bubble.wav` | 0.18 s | Bubble Blaster fire/pop — rising sine blip. |
| `sfx-croak.wav` | 0.35 s | Croak Nova fire — low triangle/square blend with fast vibrato for a "froggy" warble. |
| `sfx-hit.wav` | 0.15 s | Damage taken/dealt — short filtered-noise thump with a low sine body. |
| `sfx-pickup.wav` | 0.15 s | Fly pickup — rising square-wave chirp (classic "coin" sweep). |
| `sfx-down.wav` | 0.45 s | Player downed — descending triangle/sine tone, sad/falling. |
| `sfx-poof.wav` | 0.22 s | Enemy death — soft descending sine/triangle "bloop" with a light noise puff on the onset; distinct from `sfx-hit` (which stays a percussive thump for damage taken/dealt). Added in T12b. |
| `music-loop.wav` | 16.0 s | Background music. Mellow ambient pond loop: heavily-lowpassed noise "water" wash + a sparse pentatonic (A minor pentatonic, low register) plucked-triangle melody on a 16-beat/16-bar grid + an occasional low froggy "croak" synth accent every 8 beats. First/last 60 ms fade to silence so the loop seam is silent-to-silent (click-free). Quiet/mellow per spec, not a "hype" loop. Loaded + played on loop at low volume (~0.25) by T12b once audio is unlocked. |
| `CREDITS.md` | — | States all audio was generated for this project; no external downloads. |
| `synth.mjs` | — | The Node.js script that generated every `.wav` above (dependency-free raw PCM/WAV writer + oscillators/envelope/filter). Kept for reproducibility; not a game asset. |

All audio is 16-bit PCM mono WAV at **22050 Hz** (chosen over 44.1kHz to keep
file sizes small — appropriate for short retro-style SFX and a background
loop; still well above the fidelity these simple waveforms need).

## Verification performed

- Every `.svg` parsed successfully with `python3 -m xml.dom.minidom` (well-formed XML).
- Every `.wav` confirmed via `file`: `RIFF ... WAVE audio, Microsoft PCM, 16 bit, mono 22050 Hz` (44.1kHz check was also run before the resample, same header shape).
- Total `assets-staging/` size: **~816 KB** (well under the 2 MB target).
- Rasterizers checked and NOT found: `rsvg-convert`, `inkscape`, `convert`, `magick`; Python `PIL`, `cairosvg`, `pycairo`. Nothing was installed to compensate, per instructions.
