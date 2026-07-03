# Audio Credits

All audio assets in this directory (`sfx-*.wav`, `music-loop.wav`) were
**generated programmatically for this project** by a hand-written Node.js
raw-PCM/WAV synthesizer (`synth.mjs`, run during the T12 art & audio pass).
No samples, loops, or files were downloaded from the internet or taken from
any third-party asset pack (Kenney, jsfxr exports, etc.) — everything here
is original synthesis: sine/square/triangle/saw oscillators, a simple
noise generator, envelopes, and a basic one-pole lowpass filter, all
implemented from scratch and rendered directly to 16-bit PCM WAV.

No attribution is required or owed to any third party for these files.

`sfx-poof.wav` (enemy death sound) and the T12b wiring of `music-loop.wav`
(background loop, volume toggle) were added in the T12b asset-wiring pass;
same synthesizer, same "no external assets" guarantee.

`sfx-telegraph.wav` (heron dive-swoop warning) was added in the Phase 2 P5
pass (client merge UI / new stats / heron & boss rendering); same
synthesizer (`synth.mjs`, extended with one new generator block), same
"no external assets" guarantee. All existing `.wav` files were regenerated
in the same run for reproducibility (deterministic synthesis, same
generation method as before).
