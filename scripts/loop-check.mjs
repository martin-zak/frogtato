#!/usr/bin/env node
// Headless verification for T8 (server: phases, wave director, downed/revive,
// end states). Plain Node ESM, no TS build step. Unlike the earlier check
// scripts, this one spawns its OWN server child process (via `tsx`) bound to
// PORT=8081 by default (overridable with FROGTATO_PORT) so it never touches
// the default :8080 a live playtesting dev server may already be bound to.
// The child is killed (by this script's own PID, nothing name-based) when
// the script exits, success or failure.
//
// Run A (accelerated, invincible bot): sends `start` from lobby, debug
// `invincible: true` + `timescale: 10`, and asserts the ordered phase/event
// sequence lobby -> wave(1) -> shop -> wave(2) -> shop -> ... -> wave(5) ->
// victory (1-row scoreboard) -> scoreboard phase -> back to lobby. Also
// asserts the shop ends early on `ready` (well under SHOP_DURATION_SEC).
//
// Run B (fresh run on the same server, after run A's bot disconnects and the
// room is back in lobby): a non-invincible bot stands still (sends no input
// — the default all-false input state) and is killed by wasp contact;
// asserts `playerDowned` -> `gameOver` (1-row scoreboard) -> eventual lobby.
// A second ws client connects mid-wave and is asserted spectator:true, then
// spectator:false once the run reaches lobby (gameover skips shop entirely,
// so "next shop/lobby" here is lobby).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FROGTATO_PORT ?? '8081';
const URL = `ws://localhost:${PORT}`;
const TIMESCALE = 10;

const results = [];
let failed = false;

function check(name, ok) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
  if (!ok) failed = true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Server child process (this script's own instance, port 8081 by default —
// never 8080).
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    const tsx = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, ['server/src/index.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT, NODE_ENV: process.env.NODE_ENV ?? 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const onData = (data) => {
      const text = data.toString();
      if (!settled && /listening on/.test(text)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited early with code ${code}`));
      }
    });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('server did not report "listening on" within 10s'));
      }
    }, 10000);
  });
}

// ---------------------------------------------------------------------------
// ws helpers (same shape as the earlier check scripts)
// ---------------------------------------------------------------------------

function connectRaw() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`timed out waiting for message matching ${predicate}`));
    }, timeoutMs);
    function handler(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);
  });
}

/** Connects a bot, sends hello, and keeps rolling buffers of snapshots/events/phase transitions. */
async function connectBot({ autoReady = false } = {}) {
  const ws = await connectRaw();
  const snapshots = [];
  const events = [];
  const phaseLog = []; // { phase, atMs } — one entry per observed phase change
  let lastPhase;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      snapshots.push(msg);
      if (msg.phase !== lastPhase) {
        lastPhase = msg.phase;
        phaseLog.push({ phase: msg.phase, atMs: Date.now() });
      }
      if (autoReady && msg.phase === 'shop') ws.send(JSON.stringify({ type: 'ready' }));
    } else if (msg.type === 'event') {
      events.push({ ...msg.event, _recvAt: Date.now() });
    }
  });
  ws.send(JSON.stringify({ type: 'hello' }));
  const welcome = await waitForMessage(ws, (m) => m.type === 'welcome');
  return { ws, playerId: welcome.playerId, snapshots, events, phaseLog };
}

function latestSnapshot(bot) {
  return bot.snapshots[bot.snapshots.length - 1];
}

function selfIn(snap, bot) {
  return snap?.players.find((p) => p.id === bot.playerId);
}

async function waitUntil(predicate, { timeoutMs = 8000, pollMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(pollMs);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Run A: accelerated invincible full clear, lobby -> ... -> victory -> lobby.
// ---------------------------------------------------------------------------

async function runA() {
  const bot = await connectBot({ autoReady: true });
  bot.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));

  const welcomeSnap = await waitUntil(() => latestSnapshot(bot), { timeoutMs: 5000 });
  check('(A pre) bot connects and starts in lobby', Boolean(welcomeSnap) && welcomeSnap.phase === 'lobby');

  bot.ws.send(JSON.stringify({ type: 'start' }));

  // Track the wall-clock span of the first shop phase to assert it ends
  // early on `ready` (auto-ready is on for this bot), well under
  // SHOP_DURATION_SEC even accounting for TIMESCALE.
  let shopEnteredAt;
  let shopExitedAt;

  // Phase 2 §4: wave 5's last spawnAtRemainingSec now spawns the Snail King
  // finale and *freezes* the wave-5 timer while it lives — victory only
  // follows a debug-kill (or natural death / the hard-cap survival clause),
  // never the plain wave timer anymore. Wait for `bossSpawned`, then
  // debug-kill it so this run's victory path completes.
  const bossSpawnedEvent = await waitUntil(
    () => bot.events.find((e) => e.type === 'bossSpawned'),
    { timeoutMs: 60000 },
  );
  check('(A) "bossSpawned" event fires during wave 5', Boolean(bossSpawnedEvent));

  const bossSnap = await waitUntil(
    () => latestSnapshot(bot)?.enemies?.find((e) => e.kind === 'snailking'),
    { timeoutMs: 5000 },
  );
  if (bossSnap) bot.ws.send(JSON.stringify({ type: 'debug', kill: bossSnap.id }));

  const sawVictory = await waitUntil(
    () => bot.events.find((e) => e.type === 'victory'),
    { timeoutMs: 60000 },
  );
  check('(A) a "victory" event was received', Boolean(sawVictory));

  const sawBossDied = bot.events.find((e) => e.type === 'bossDied');
  check('(A) "bossDied" event fires from the debug-kill, before victory', Boolean(sawBossDied) && Boolean(sawVictory) && sawBossDied._recvAt <= sawVictory._recvAt);

  for (const entry of bot.phaseLog) {
    if (entry.phase === 'shop' && shopEnteredAt === undefined) shopEnteredAt = entry.atMs;
    else if (shopEnteredAt !== undefined && shopExitedAt === undefined && entry.phase !== 'shop') {
      shopExitedAt = entry.atMs;
    }
  }
  if (shopEnteredAt !== undefined && shopExitedAt !== undefined) {
    const shopDurationMs = shopExitedAt - shopEnteredAt;
    check(
      `(A) shop ends early on ready (took ${shopDurationMs}ms, well under a full 30s/timescale break)`,
      shopDurationMs < 5000,
    );
  } else {
    check('(A) shop ends early on ready', false);
  }

  // --- ordered phase/event sequence: waveStart(1) -> waveEnd(1) -> ... -> waveStart(5) -> waveEnd(5) -> victory
  const relevantEvents = bot.events.filter((e) => ['waveStart', 'waveEnd', 'victory'].includes(e.type));
  const expected = [];
  for (let w = 1; w <= 5; w++) {
    expected.push(`waveStart:${w}`);
    expected.push(`waveEnd:${w}`);
  }
  expected.push('victory');
  const actual = relevantEvents.map((e) => (e.type === 'victory' ? 'victory' : `${e.type}:${e.wave}`));
  const actualPrefix = actual.slice(0, expected.length);
  check(
    `(A) ordered sequence lobby -> wave(1..5) -> victory (expected [${expected.join(', ')}], got [${actualPrefix.join(', ')}])`,
    JSON.stringify(actualPrefix) === JSON.stringify(expected),
  );

  check(
    `(A) victory event carries a 1-row scoreboard (got ${sawVictory ? sawVictory.scoreboard.length : 'n/a'} rows)`,
    Boolean(sawVictory) && Array.isArray(sawVictory.scoreboard) && sawVictory.scoreboard.length === 1,
  );
  if (sawVictory) {
    const row = sawVictory.scoreboard[0];
    check(
      '(A) scoreboard row has the expected shape',
      row.playerId === bot.playerId &&
        typeof row.kills === 'number' &&
        typeof row.damageDealt === 'number' &&
        typeof row.fliesCollected === 'number',
    );
  }

  // --- phase transitions to "scoreboard", then eventually back to "lobby"
  const sawScoreboardPhase = bot.phaseLog.some((e) => e.phase === 'scoreboard');
  check('(A) phase transitioned to "scoreboard" after victory', sawScoreboardPhase);

  const backToLobby = await waitUntil(() => (latestSnapshot(bot).phase === 'lobby' ? true : undefined), {
    timeoutMs: 15000,
  });
  check('(A) phase eventually returns to "lobby"', Boolean(backToLobby));

  bot.ws.close();
}

// ---------------------------------------------------------------------------
// Run B: fresh run, non-invincible bot standing still -> downed -> gameOver
// -> lobby; a second client joining mid-wave is a spectator until lobby.
// ---------------------------------------------------------------------------

async function runB() {
  const bot = await connectBot();
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));

  const startedInLobby = await waitUntil(() => (latestSnapshot(bot)?.phase === 'lobby' ? true : undefined), {
    timeoutMs: 5000,
  });
  check('(B pre) fresh run starts back in lobby', Boolean(startedInLobby));

  bot.ws.send(JSON.stringify({ type: 'start' }));
  // Bot sends no input at all — default input state is all-false (stands still).

  const enteredWave = await waitUntil(() => (latestSnapshot(bot)?.phase === 'wave' ? true : undefined), {
    timeoutMs: 5000,
  });
  check('(B pre) run reaches wave phase', Boolean(enteredWave));

  // Second client joins mid-wave: must be a spectator immediately.
  const spectatorBot = await connectBot();
  const spectatorSnap = await waitUntil(() => latestSnapshot(spectatorBot), { timeoutMs: 5000 });
  const spectatorSelf = selfIn(spectatorSnap, spectatorBot);
  check(
    '(B) a client joining mid-wave is a spectator immediately',
    Boolean(spectatorSelf) && spectatorSelf.spectator === true,
  );

  const downedEvent = await waitUntil(
    () => bot.events.find((e) => e.type === 'playerDowned' && e.playerId === bot.playerId),
    { timeoutMs: 60000 },
  );
  check('(B) a stationary, non-invincible bot eventually goes down', Boolean(downedEvent));

  const gameOverEvent = await waitUntil(() => bot.events.find((e) => e.type === 'gameOver'), { timeoutMs: 15000 });
  check('(B) "playerDowned" is followed by a "gameOver" event', Boolean(gameOverEvent));
  // Scoreboard includes every currently-connected player, not just active
  // ones — the mid-wave spectator (connected above) is present too, so this
  // run has 2 rows (unlike run A's solo 1-row scoreboard).
  check(
    `(B) gameOver carries a scoreboard row for the downed bot (got ${gameOverEvent ? gameOverEvent.scoreboard.length : 'n/a'} rows)`,
    Boolean(gameOverEvent) &&
      Array.isArray(gameOverEvent.scoreboard) &&
      gameOverEvent.scoreboard.some((row) => row.playerId === bot.playerId),
  );
  if (downedEvent && gameOverEvent) {
    check('(B) "playerDowned" happened before "gameOver"', downedEvent._recvAt <= gameOverEvent._recvAt);
  }

  const backToLobby = await waitUntil(() => (latestSnapshot(bot)?.phase === 'lobby' ? true : undefined), {
    timeoutMs: 20000,
  });
  check('(B) phase eventually returns to "lobby"', Boolean(backToLobby));

  // gameover skips the shop entirely (straight to scoreboard), so the mid-wave
  // joiner's "next shop/lobby" is this lobby transition.
  const spectatorClearedAtLobby = await waitUntil(
    () => {
      const self = selfIn(latestSnapshot(spectatorBot), spectatorBot);
      return self && self.spectator === false ? true : undefined;
    },
    { timeoutMs: 5000 },
  );
  check('(B) the mid-wave joiner becomes spectator:false once lobby arrives', Boolean(spectatorClearedAtLobby));

  bot.ws.close();
  spectatorBot.ws.close();
}

// ---------------------------------------------------------------------------

async function main() {
  const server = await startServer();
  console.log(`[loop-check] server child pid=${server.pid} listening on :${PORT}`);

  try {
    await runA();
    await runB();
  } finally {
    server.kill('SIGTERM');
  }

  console.log('\n--- loop-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: loop-check' : '\nPASS: loop-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: loop-check errored:', err);
  process.exit(1);
});
