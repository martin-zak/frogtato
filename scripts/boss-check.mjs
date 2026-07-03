#!/usr/bin/env node
// Headless verification for P3 (server: heron enemy + Snail King boss).
// Plain Node ESM, no TS build step, mirrors the shape of loop-check.mjs /
// class-check.mjs: spawns its OWN server child process (via `tsx`) bound to
// PORT=8081 by default (overridable with FROGTATO_PORT) so it never touches
// the default :8080 a live playtesting dev server may already be bound to.
// The child is killed (by this script's own PID, nothing name-based) when
// the script exits, success or failure.
//
// Covers (DESIGN-PHASE2.md §4, server/src/sim/enemies.ts, game/waves.ts, room.ts):
//   Scenario A (timescaled invincible run to wave 5):
//     - herons appear in wave-3+ snapshots
//     - a heron telegraph appears (EnemySnap.telegraph present), followed by
//       that same heron moving fast (the swoop) and the telegraph clearing
//     - regular spawns stop once bossSpawned fires (no new non-boss enemy
//       ids appear afterward)
//     - the boss snapshot has kind "snailking", hp scaled by playerFactor(1) == 120
//     - shelled=true appears periodically, and per-hit hp loss while shelled
//       is meaningfully lower than while unshelled (observed via boss hp
//       deltas across snapshots while a bot parked in croak-III range fires
//       on it)
//     - the wave-5 timer does not count down while the boss is alive
//       (phaseEndsAt only ever increases, never decreases, during that window)
//     - debug-kill on the boss -> bossDied -> victory
//   Scenario B (fresh run, boss survives untouched):
//     - bot kites away from the slow (speed 40) boss for its whole life so it
//       never takes damage -> hardCapExtraSec (30s) survival clause fires:
//       victory WITHOUT a bossDied event, boss hp never dropped

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FROGTATO_PORT ?? '8081';
const URL = `ws://localhost:${PORT}`;
// Kept low enough that the 0.8s heron telegraph and the boss's 2s shell
// phase still span several 20Hz snapshots in real time (moderate timescale,
// not loop-check's 10x) — see the header note above.
const TIMESCALE = 5;

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
      msg._recvAt = Date.now();
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

async function waitUntil(predicate, { timeoutMs = 8000, pollMs = 40 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await sleep(pollMs);
  }
  return undefined;
}

function setStill(bot, seqBox) {
  seqBox.seq += 1;
  bot.ws.send(JSON.stringify({ type: 'input', seq: seqBox.seq, up: false, down: false, left: false, right: false }));
}

/** Sends one burst of input toward (or away from) a fixed point. */
function stepToward(bot, seqBox, targetX, targetY, { away = false } = {}) {
  const s = selfIn(latestSnapshot(bot), bot);
  if (!s) return;
  const dx = targetX - s.x;
  const dy = targetY - s.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = (dx / d) * (away ? -1 : 1);
  const uy = (dy / d) * (away ? -1 : 1);
  seqBox.seq += 1;
  bot.ws.send(
    JSON.stringify({
      type: 'input',
      seq: seqBox.seq,
      up: uy < -0.3,
      down: uy > 0.3,
      left: ux < -0.3,
      right: ux > 0.3,
    }),
  );
}

function bossSnapIn(snap) {
  return snap?.enemies?.find((e) => e.kind === 'snailking');
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/** Finds a heron id whose snapshot timeline shows telegraph=true followed
 * shortly after by telegraph=false with a large positional jump (the swoop). */
function findHeronTelegraphThenSwoop(snapshots) {
  const timelines = new Map(); // id -> [{ atMs, x, y, telegraph }]
  for (const snap of snapshots) {
    for (const e of snap.enemies ?? []) {
      if (e.kind !== 'heron') continue;
      if (!timelines.has(e.id)) timelines.set(e.id, []);
      timelines.get(e.id).push({ atMs: snap._recvAt, x: e.x, y: e.y, telegraph: Boolean(e.telegraph) });
    }
  }
  for (const [id, points] of timelines) {
    for (let i = 0; i < points.length; i++) {
      if (!points[i].telegraph) continue;
      for (let j = i + 1; j < points.length; j++) {
        if (points[j].telegraph) continue;
        const dtMs = points[j].atMs - points[i].atMs;
        if (dtMs > 4000) break;
        const dist = Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y);
        const speedPxPerSec = dist / (dtMs / 1000);
        if (speedPxPerSec > 200) {
          return { heronId: id, speedPxPerSec, dtMs };
        }
        break;
      }
    }
  }
  return undefined;
}

/** True iff any wave>=3 snapshot contains a heron. */
function heronsAppearedFromWave3(snapshots) {
  return snapshots.some((snap) => (snap.wave ?? 0) >= 3 && (snap.enemies ?? []).some((e) => e.kind === 'heron'));
}

/** Any enemy id (other than the boss's own) first seen strictly after the
 * boss-spawn timestamp -> regular spawns did NOT stop. */
function newNonBossEnemyAfter(snapshots, bossId, afterMs) {
  const firstSeenAt = new Map();
  for (const snap of snapshots) {
    for (const e of snap.enemies ?? []) {
      if (!firstSeenAt.has(e.id)) firstSeenAt.set(e.id, snap._recvAt);
    }
  }
  for (const [id, atMs] of firstSeenAt) {
    if (id === bossId) continue;
    if (atMs > afterMs) return { id, atMs };
  }
  return undefined;
}

/** Per-hit boss hp drops bucketed by whether the boss was shelled at the time. */
function bossHpDrops(snapshots, bossId) {
  const drops = [];
  let prevHp;
  let prevShelled;
  for (const snap of snapshots) {
    const boss = (snap.enemies ?? []).find((e) => e.id === bossId);
    if (!boss) continue;
    if (prevHp !== undefined && boss.hp < prevHp) {
      drops.push({ amount: prevHp - boss.hp, shelled: Boolean(prevShelled) || Boolean(boss.shelled) });
    }
    prevHp = boss.hp;
    prevShelled = boss.shelled;
  }
  return drops;
}

// ---------------------------------------------------------------------------
// Scenario A: timescaled invincible run to wave 5, full boss lifecycle.
// ---------------------------------------------------------------------------

async function scenarioA() {
  const bot = await connectBot({ autoReady: true });
  bot.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));

  const startedInLobby = await waitUntil(() => (latestSnapshot(bot)?.phase === 'lobby' ? true : undefined), {
    timeoutMs: 5000,
  });
  check('(A pre) bot connects and starts in lobby', Boolean(startedInLobby));

  bot.ws.send(JSON.stringify({ type: 'start' }));

  // --- reach wave 3+ and confirm herons appear there ---
  const reachedWave3 = await waitUntil(() => (latestSnapshot(bot)?.wave >= 3 ? true : undefined), {
    timeoutMs: 60000,
  });
  check('(A) run reaches wave 3', Boolean(reachedWave3));

  // Give herons a little time to actually spawn/circle/telegraph/swoop before
  // wave 5's boss phase changes the spawn mix.
  const heronSeen = await waitUntil(() => heronsAppearedFromWave3(bot.snapshots), { timeoutMs: 30000 });
  check('(A) herons appear in wave 3+ snapshots', Boolean(heronSeen));

  const swoop = await waitUntil(() => findHeronTelegraphThenSwoop(bot.snapshots), { timeoutMs: 30000 });
  check(
    `(A) a heron telegraph appears and is followed by fast movement + telegraph clearing (${swoop ? `${swoop.speedPxPerSec.toFixed(0)}px/s over ${swoop.dtMs}ms` : 'not observed'})`,
    Boolean(swoop),
  );

  // --- reach wave 5 and the boss spawn ---
  const reachedWave5 = await waitUntil(() => (latestSnapshot(bot)?.wave === 5 ? true : undefined), {
    timeoutMs: 60000,
  });
  check('(A) run reaches wave 5', Boolean(reachedWave5));

  const bossSpawnedEvent = await waitUntil(() => bot.events.find((e) => e.type === 'bossSpawned'), {
    timeoutMs: 60000,
  });
  check('(A) "bossSpawned" event fires in wave 5', Boolean(bossSpawnedEvent));

  const bossSnap = await waitUntil(() => bossSnapIn(latestSnapshot(bot)), { timeoutMs: 5000 });
  check(
    `(A) boss snapshot has kind "snailking" and hp scaled by playerFactor(1) == 120 (got hp=${bossSnap?.hp}, maxHp=${bossSnap?.maxHp})`,
    Boolean(bossSnap) && bossSnap.kind === 'snailking' && bossSnap.maxHp === 120 && bossSnap.hp === 120,
  );
  const bossId = bossSnap?.id;

  // Slow back to real-time for the rest of the boss encounter: at TIMESCALE
  // the 30s hardCapExtraSec survival clause (see scenario B) would otherwise
  // race the shelled/unshelled sampling below and end the run before we get
  // to the explicit debug-kill — this scenario is about the death path, the
  // hard-cap path is scenario B's job.
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: 1 }));

  // --- regular spawns stop once the boss is up ---
  await sleep(2000); // let a few more spawn-director ticks elapse, if they were going to happen
  const spuriousSpawn = newNonBossEnemyAfter(bot.snapshots, bossId, bossSpawnedEvent?._recvAt ?? 0);
  check(
    `(A) regular spawns stop once bossSpawned fires (no new non-boss enemy id appeared after; got ${spuriousSpawn ? JSON.stringify(spuriousSpawn) : 'none'})`,
    !spuriousSpawn,
  );

  // --- wave-5 timer freezes while the boss lives: phaseEndsAt only ever
  //     increases (never decreases) across snapshots taken while bossId is present ---
  const framesWithBoss = bot.snapshots.filter((s) => bossSnapIn(s)?.id === bossId);
  let timerNeverCountsDown = framesWithBoss.length > 1;
  for (let i = 1; i < framesWithBoss.length; i++) {
    if (framesWithBoss[i].phaseEndsAt < framesWithBoss[i - 1].phaseEndsAt - 5 /* ms jitter tolerance */) {
      timerNeverCountsDown = false;
      break;
    }
  }
  check(
    `(A) the wave-5 timer does not count down while the boss is alive (phaseEndsAt only increases across ${framesWithBoss.length} boss-alive snapshots)`,
    timerNeverCountsDown,
  );

  // --- shelled=true appears periodically, and mitigates damage: park the bot
  //     on the boss with a debug-given croak III (aoe, always hits in range,
  //     deterministic cooldown) and compare hp-drop sizes shelled vs not. ---
  bot.ws.send(JSON.stringify({ type: 'debug', give: { slot: 0, weapon: 'croak', level: 3 } }));
  const seqA = { seq: 1000 };
  const attackDeadline = Date.now() + 20000;
  while (Date.now() < attackDeadline) {
    const snap = latestSnapshot(bot);
    const boss = bossSnapIn(snap);
    if (!boss) break; // boss died from our own fire — fine, stop early
    stepToward(bot, seqA, boss.x, boss.y);
    await sleep(120);
  }
  setStill(bot, seqA);

  const shelledSeen = bot.snapshots.some((s) => bossSnapIn(s)?.shelled === true);
  check('(A) shelled=true appears periodically on the boss snapshot', shelledSeen);

  const drops = bossHpDrops(bot.snapshots, bossId);
  const shelledDrops = drops.filter((d) => d.shelled).map((d) => d.amount);
  const unshelledDrops = drops.filter((d) => !d.shelled).map((d) => d.amount);
  if (shelledDrops.length > 0 && unshelledDrops.length > 0) {
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const avgShelled = avg(shelledDrops);
    const avgUnshelled = avg(unshelledDrops);
    check(
      `(A) per-hit damage to the boss is meaningfully reduced while shelled (avg shelled=${avgShelled.toFixed(2)} over ${shelledDrops.length} hits, avg unshelled=${avgUnshelled.toFixed(2)} over ${unshelledDrops.length} hits)`,
      avgShelled < avgUnshelled,
    );
  } else {
    check(
      `(A) collected both shelled and unshelled boss hits to compare (got shelled=${shelledDrops.length}, unshelled=${unshelledDrops.length})`,
      false,
    );
  }

  // --- debug-kill the boss (if it's still alive) -> bossDied -> victory ---
  const stillAliveSnap = bossSnapIn(latestSnapshot(bot));
  if (stillAliveSnap) {
    bot.ws.send(JSON.stringify({ type: 'debug', kill: stillAliveSnap.id }));
  }

  const bossDiedEvent = await waitUntil(() => bot.events.find((e) => e.type === 'bossDied'), { timeoutMs: 10000 });
  check('(A) "bossDied" event fires (boss killed by weapon fire or the final debug-kill)', Boolean(bossDiedEvent));

  const victoryEvent = await waitUntil(() => bot.events.find((e) => e.type === 'victory'), { timeoutMs: 10000 });
  check('(A) "victory" event follows "bossDied"', Boolean(victoryEvent));
  if (bossDiedEvent && victoryEvent) {
    check('(A) "bossDied" happened before "victory"', bossDiedEvent._recvAt <= victoryEvent._recvAt);
  }

  bot.ws.close();
}

// ---------------------------------------------------------------------------
// Scenario B: fresh run, bot kites the boss for its whole life -> hard-cap
// survival victory, no bossDied.
// ---------------------------------------------------------------------------

async function scenarioB() {
  const bot = await connectBot({ autoReady: true });
  bot.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));

  const startedInLobby = await waitUntil(() => (latestSnapshot(bot)?.phase === 'lobby' ? true : undefined), {
    timeoutMs: 5000,
  });
  check('(B pre) fresh run starts back in lobby', Boolean(startedInLobby));

  bot.ws.send(JSON.stringify({ type: 'start' }));

  const bossSpawnedEvent = await waitUntil(() => bot.events.find((e) => e.type === 'bossSpawned'), {
    timeoutMs: 90000,
  });
  check('(B) "bossSpawned" event fires', Boolean(bossSpawnedEvent));

  const seqB = { seq: 1000 };
  const bossId = bossSnapIn(latestSnapshot(bot))?.id;

  // Kite: as long as the boss is alive, keep moving directly away from it
  // (bot moveSpeed 220 >> boss speed 40 — this trivially keeps the bot
  // outside every weapon's range, so it never damages the boss).
  const kiteDeadline = Date.now() + 45000;
  let victorySeen = false;
  while (Date.now() < kiteDeadline) {
    if (bot.events.some((e) => e.type === 'victory')) {
      victorySeen = true;
      break;
    }
    const snap = latestSnapshot(bot);
    const boss = bossSnapIn(snap);
    if (boss) stepToward(bot, seqB, boss.x, boss.y, { away: true });
    else setStill(bot, seqB);
    await sleep(100);
  }
  if (!victorySeen) {
    victorySeen = Boolean(await waitUntil(() => bot.events.find((e) => e.type === 'victory'), { timeoutMs: 10000 }));
  }
  check('(B) the run reaches victory via the hard-cap survival clause', victorySeen);

  const bossDiedEvent = bot.events.find((e) => e.type === 'bossDied');
  check('(B) no "bossDied" event was emitted (the boss survived, per the hard-cap clause)', !bossDiedEvent);

  if (bossId) {
    const drops = bossHpDrops(bot.snapshots, bossId);
    check(`(B) the boss never took damage while kited (0 hp-drops observed, got ${drops.length})`, drops.length === 0);
  }

  bot.ws.close();
}

// ---------------------------------------------------------------------------

async function main() {
  const server = await startServer();
  console.log(`[boss-check] server child pid=${server.pid} listening on :${PORT}`);

  try {
    await scenarioA();
    await scenarioB();
  } finally {
    server.kill('SIGTERM');
  }

  console.log('\n--- boss-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: boss-check' : '\nPASS: boss-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: boss-check errored:', err);
  process.exit(1);
});
