// Raw PCM/WAV synthesizer for Frogtato SFX + music loop.
// No external deps: writes 16-bit signed PCM mono WAV files by hand.
import fs from "node:fs";
import path from "node:path";

const SR = 22050; // retro-appropriate rate; keeps file sizes small

function writeWav(filePath, samples, sampleRate = SR) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  console.log(`wrote ${filePath} (${(dataSize / SR / bytesPerSample * bytesPerSample).toFixed(0)} bytes data, ${(numSamples / sampleRate).toFixed(3)}s)`);
}

// --- oscillators ---
const twoPi = Math.PI * 2;
function sine(t, freq) { return Math.sin(twoPi * freq * t); }
function square(t, freq, duty = 0.5) { const ph = (t * freq) % 1; return ph < duty ? 1 : -1; }
function triangle(t, freq) { const ph = (t * freq) % 1; return 4 * Math.abs(ph - 0.5) - 1; }
function saw(t, freq) { const ph = (t * freq) % 1; return 2 * ph - 1; }
// deterministic pseudo-noise (LCG) so runs are reproducible
let seed = 12345;
function noise() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
}

// simple one-pole lowpass filter, used for softer noise textures
function lowpassArray(arr, alpha) {
  const out = new Float64Array(arr.length);
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    prev = prev + alpha * (arr[i] - prev);
    out[i] = prev;
  }
  return out;
}

function linToDb() {}

function envelope(n, attack, decay, sustainLevel, release, total) {
  // n = sample index, total = total samples
  const t = n / SR;
  if (t < attack) return t / attack;
  if (t < attack + decay) {
    const dt = (t - attack) / decay;
    return 1 - dt * (1 - sustainLevel);
  }
  const releaseStart = total / SR - release;
  if (t > releaseStart) {
    const rt = (t - releaseStart) / release;
    return Math.max(0, sustainLevel * (1 - rt));
  }
  return sustainLevel;
}

function gen(durationSec, fn) {
  const n = Math.round(durationSec * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = fn(t, i, n);
  }
  return out;
}

function normalize(arr, peak = 0.9) {
  let max = 0;
  for (const v of arr) max = Math.max(max, Math.abs(v));
  if (max === 0) return arr;
  const g = peak / max;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] * g;
  return out;
}

const OUT = "/home/martin/frogtato/assets-staging/audio";

// ---------------------------------------------------------------
// 1. sfx-tongue: quick wet "snap" — short filtered-noise crack + fast
//    downward pitch square blip, very short (~0.12s)
{
  const dur = 0.12;
  const n = Math.round(dur * SR);
  const noiseArr = new Float64Array(n);
  for (let i = 0; i < n; i++) noiseArr[i] = noise();
  const filtered = lowpassArray(noiseArr, 0.5);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.001, 0.05, 0.15, 0.06, n);
    const freq = 900 - t * 4000; // fast downward snap
    const tone = square(t, Math.max(80, freq)) * 0.5;
    return (filtered[i] * 0.7 + tone) * env;
  });
  writeWav(`${OUT}/sfx-tongue.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 2. sfx-bubble: soft round "pop" — sine blip that rises then
//    snaps down, like a bubble popping (~0.18s)
{
  const dur = 0.18;
  const n = Math.round(dur * SR);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.005, 0.06, 0.3, 0.09, n);
    // frequency rises quickly then the "pop" is a short burst
    const freq = 260 + Math.min(t, 0.05) / 0.05 * 500;
    return sine(t, freq) * env;
  });
  writeWav(`${OUT}/sfx-bubble.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 3. sfx-croak: low, froggy — a low square/triangle blend with a
//    warble (amplitude + slight pitch wobble), ~0.35s
{
  const dur = 0.35;
  const n = Math.round(dur * SR);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.01, 0.1, 0.6, 0.2, n);
    const wobble = 1 + 0.15 * Math.sin(twoPi * 28 * t); // fast vibrato = "croak" texture
    const baseFreq = 90 * wobble;
    const tone = triangle(t, baseFreq) * 0.6 + square(t, baseFreq * 0.5) * 0.3;
    return tone * env;
  });
  writeWav(`${OUT}/sfx-croak.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 4. sfx-hit: short percussive noise thump, mid-low body (~0.15s)
{
  const dur = 0.15;
  const n = Math.round(dur * SR);
  const noiseArr = new Float64Array(n);
  for (let i = 0; i < n; i++) noiseArr[i] = noise();
  const filtered = lowpassArray(noiseArr, 0.35);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.001, 0.04, 0.1, 0.09, n);
    const thump = sine(t, 140 - t * 300) * 0.6;
    return (filtered[i] * 0.6 + thump) * env;
  });
  writeWav(`${OUT}/sfx-hit.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 5. sfx-pickup: rising chirp — classic coin/pickup blip (~0.15s)
{
  const dur = 0.15;
  const n = Math.round(dur * SR);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.002, 0.03, 0.5, 0.09, n);
    const freq = 500 + (t / dur) * 900; // rising sweep
    return square(t, freq, 0.4) * env * 0.8;
  });
  writeWav(`${OUT}/sfx-pickup.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 6. sfx-down: descending sad tone — player downed (~0.45s)
{
  const dur = 0.45;
  const n = Math.round(dur * SR);
  const raw = gen(dur, (t, i) => {
    const env = envelope(i, 0.005, 0.15, 0.4, 0.25, n);
    const freq = 420 - (t / dur) * 320; // falling sweep, minor feel
    const tone = triangle(t, freq) * 0.7 + sine(t, freq * 0.5) * 0.3;
    return tone * env;
  });
  writeWav(`${OUT}/sfx-down.wav`, normalize(raw));
}

// ---------------------------------------------------------------
// 7. music-loop: mellow ambient pond loop, ~24s, loops cleanly.
//    Layer: soft lowpass-filtered noise "water" pad (constant, loop-safe
//    because noise has no phase to mismatch) + a gentle triangle-wave
//    pentatonic melody plucked on a loop-length-aligned grid + occasional
//    low synth "croak" accents. Fade first/last 60ms to zero so the
//    seam is silent-to-silent (inaudible click-free loop point).
{
  const LOOP_SEC = 16;
  const n = Math.round(LOOP_SEC * SR);

  // Water pad: filtered noise, very quiet, constant texture (safe to loop
  // since it's stochastic, no fundamental period to clash at the seam).
  const rawNoise = new Float64Array(n);
  for (let i = 0; i < n; i++) rawNoise[i] = noise();
  const pad = lowpassArray(rawNoise, 0.02); // heavy lowpass = soft "water" wash

  // Pentatonic scale (A minor pentatonic-ish, low register, mellow) in Hz.
  const scale = [220.0, 261.63, 293.66, 329.63, 392.0]; // A3 C4 D4 E4 G4
  const beatSec = 1.0; // slow, relaxed tempo; 16 beats over a 16s loop = 16 "bars"
  const totalBeats = Math.round(LOOP_SEC / beatSec); // loop-aligned
  // deterministic "melody" pattern using a small LCG so it's fixed but varied
  let mseed = 777;
  function pick(arr) {
    mseed = (mseed * 48271) % 2147483647;
    return arr[mseed % arr.length];
  }
  const notes = [];
  for (let b = 0; b < totalBeats; b++) {
    // rest on some beats for a relaxed, non-busy feel
    const rest = (mseed = (mseed * 48271) % 2147483647) % 3 === 0;
    notes.push(rest ? null : pick(scale));
  }

  function pluck(tLocal, freq, dur) {
    // short plucked triangle note with quick decay
    const env = Math.exp(-tLocal * 3.2) * (tLocal < dur ? 1 : 0);
    return triangle(tLocal, freq) * env;
  }

  const melody = new Float64Array(n);
  for (let b = 0; b < totalBeats; b++) {
    const freq = notes[b];
    if (!freq) continue;
    const startSample = Math.round(b * beatSec * SR);
    const noteDur = beatSec * 1.6; // let it ring a bit, overlapping next
    const noteSamples = Math.min(n - startSample, Math.round(noteDur * SR));
    for (let i = 0; i < noteSamples; i++) {
      const tLocal = i / SR;
      melody[startSample + i] += pluck(tLocal, freq, noteDur) * 0.18;
    }
  }

  // Occasional low synth "croak" accent every ~8 beats, low + short.
  const croakAccent = new Float64Array(n);
  for (let b = 0; b < totalBeats; b += 8) {
    const startSample = Math.round((b + 0.5) * beatSec * SR);
    const croakDur = 0.3;
    const croakSamples = Math.min(n - startSample, Math.round(croakDur * SR));
    for (let i = 0; i < croakSamples; i++) {
      const t = i / SR;
      const env = envelope(i, 0.01, 0.08, 0.5, 0.15, croakSamples);
      const wobble = 1 + 0.15 * Math.sin(twoPi * 24 * t);
      croakAccent[startSample + i] += triangle(t, 85 * wobble) * env * 0.12;
    }
  }

  const mix = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mix[i] = pad[i] * 0.5 + melody[i] + croakAccent[i];
  }

  // fade in/out at loop seam so it stitches silently
  const fadeSamples = Math.round(0.06 * SR);
  for (let i = 0; i < fadeSamples; i++) {
    const g = i / fadeSamples;
    mix[i] *= g;
    mix[n - 1 - i] *= g;
  }

  writeWav(`${OUT}/music-loop.wav`, normalize(mix, 0.7));
}

console.log("done");
