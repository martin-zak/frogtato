#!/usr/bin/env node
// Headless verification for T5 (server: enemies, damage, deaths, fly economy).
// Plain Node ESM, no TS build step. Assumes the server is already running with
// NODE_ENV != "production" (debug messages must be enabled) and its enemy/
// projectile/fly cap fresh enough to spawn near a lone stationary bot.
//
// Assertions:
//   (a) a stationary bot's HP decreases over time (wasp contact damage)
//   (b) after debug-killing a nearby enemy, fly entities appear in snapshots
//   (c) after the bot (auto-magnet / walking) touches the flies, its fly count increments
//   (d) a bot with debug invincible stays at full HP for 5s while enemies exist
//   (e) downed flow: a non-invincible bot dies -> playerDowned event, snapshot
//       downed=true, and its position stops responding to input

import WebSocket from 'ws';

const URL = 'ws://localhost:8080';

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

/** Connects a bot, sends hello, and keeps rolling buffers of snapshots/events. */
async function connectBot() {
  const ws = await connectRaw();
  const snapshots = [];
  const events = [];
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'snapshot') snapshots.push(msg);
    else if (msg.type === 'event') events.push(msg.event);
  });
  ws.send(JSON.stringify({ type: 'hello' }));
  const welcome = await waitForMessage(ws, (m) => m.type === 'welcome');
  return { ws, playerId: welcome.playerId, snapshots, events };
}

function latestSnapshot(bot) {
  return bot.snapshots[bot.snapshots.length - 1];
}

function selfIn(snap, bot) {
  return snap?.players.find((p) => p.id === bot.playerId);
}

async function waitUntil(predicate, { timeoutMs = 8000, pollMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(pollMs);
  }
  return undefined;
}

function sendInputToward(ws, seqBox, fromX, fromY, toX, toY) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  seqBox.seq += 1;
  ws.send(
    JSON.stringify({
      type: 'input',
      seq: seqBox.seq,
      left: dx < -5,
      right: dx > 5,
      up: dy < -5,
      down: dy > 5,
    }),
  );
}

async function main() {
  // --- (a) stationary bot takes wasp contact damage -----------------------
  const botA = await connectBot();
  await waitForMessage(botA.ws, (m) => m.type === 'snapshot' && selfIn(m, botA) !== undefined);
  const startSnapA = latestSnapshot(botA);
  const startHpA = selfIn(startSnapA, botA).hp;
  console.log(`bot A start HP: ${startHpA}`);

  const tookDamage = await waitUntil(
    () => {
      const p = selfIn(latestSnapshot(botA), botA);
      return p && p.hp < startHpA ? p : undefined;
    },
    { timeoutMs: 15000 },
  );
  check('(a) stationary bot HP decreases over time (wasp contact)', Boolean(tookDamage));
  if (tookDamage) console.log(`bot A HP after contact: ${tookDamage.hp}`);

  // --- (b) debug-kill a nearby enemy -> flies appear -----------------------
  const snapBeforeKill = latestSnapshot(botA);
  const flyCountBefore = snapBeforeKill.flies.length;
  const selfA = selfIn(snapBeforeKill, botA);
  const enemies = snapBeforeKill.enemies;
  let targetEnemy = enemies[0];
  for (const e of enemies) {
    const d = Math.hypot(e.x - selfA.x, e.y - selfA.y);
    const dBest = Math.hypot(targetEnemy.x - selfA.x, targetEnemy.y - selfA.y);
    if (d < dBest) targetEnemy = e;
  }
  check('(pre) at least one enemy exists to kill', Boolean(targetEnemy));

  const fliesBeforeCount = selfA.flies;
  botA.ws.send(JSON.stringify({ type: 'debug', kill: targetEnemy.id }));

  const diedEvent = await waitUntil(() => botA.events.find((e) => e.type === 'enemyDied' && e.enemyId === targetEnemy.id), {
    timeoutMs: 5000,
  });
  check('(b) debug kill produces an enemyDied event', Boolean(diedEvent));

  const fliesAppeared = await waitUntil(() => latestSnapshot(botA).flies.length > flyCountBefore, { timeoutMs: 3000 });
  check('(b) fly entities appear in snapshots after debug kill', Boolean(fliesAppeared));

  // --- (c) bot walks onto the flies -> fly count increments ---------------
  const flySpawn = diedEvent ?? { x: targetEnemy.x, y: targetEnemy.y };
  const seqBoxA = { seq: 0 };
  const walkTimer = setInterval(() => {
    const p = selfIn(latestSnapshot(botA), botA) ?? selfA;
    sendInputToward(botA.ws, seqBoxA, p.x, p.y, flySpawn.x, flySpawn.y);
  }, 1000 / 30);

  const fliesCollected = await waitUntil(() => {
    const p = selfIn(latestSnapshot(botA), botA);
    return p && p.flies > fliesBeforeCount ? p : undefined;
  }, { timeoutMs: 6000 });
  clearInterval(walkTimer);
  // stop moving
  seqBoxA.seq += 1;
  botA.ws.send(JSON.stringify({ type: 'input', seq: seqBoxA.seq, up: false, down: false, left: false, right: false }));

  check(
    `(c) fly count increments after walking onto flies (before=${fliesBeforeCount}, after=${fliesCollected?.flies})`,
    Boolean(fliesCollected),
  );

  botA.ws.close();

  // --- (d) invincible bot stays at full HP for 5s while enemies exist -----
  const botD = await connectBot();
  botD.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
  await waitForMessage(botD.ws, (m) => m.type === 'snapshot' && selfIn(m, botD) !== undefined);
  const startSnapD = latestSnapshot(botD);
  const maxHpD = selfIn(startSnapD, botD).maxHp;

  const sawEnemies = await waitUntil(() => (latestSnapshot(botD).enemies.length > 0 ? true : undefined), { timeoutMs: 5000 });
  check('(pre) enemies exist during invincibility check', Boolean(sawEnemies));

  await sleep(5000);
  const hpValuesD = botD.snapshots.map((s) => selfIn(s, botD)?.hp).filter((v) => v !== undefined);
  const stayedFull = hpValuesD.every((hp) => hp === maxHpD);
  check(`(d) invincible bot stays at full HP for 5s (maxHp=${maxHpD}, min seen=${Math.min(...hpValuesD)})`, stayedFull);

  botD.ws.close();

  // --- (e) downed flow: non-invincible bot dies ----------------------------
  const botE = await connectBot();
  await waitForMessage(botE.ws, (m) => m.type === 'snapshot' && selfIn(m, botE) !== undefined);

  const downed = await waitUntil(
    () => {
      const p = selfIn(latestSnapshot(botE), botE);
      return p && p.downed ? p : undefined;
    },
    { timeoutMs: 45000, pollMs: 200 },
  );
  check('(e) non-invincible bot eventually goes down (hp -> 0, downed=true in snapshot)', Boolean(downed));

  const downedEvent = botE.events.find((e) => e.type === 'playerDowned' && e.playerId === botE.playerId);
  check('(e) playerDowned event received', Boolean(downedEvent));

  if (downed) {
    const posBeforeInput = { x: downed.x, y: downed.y };
    const seqBoxE = { seq: 0 };
    for (let i = 0; i < 20; i++) {
      seqBoxE.seq += 1;
      botE.ws.send(JSON.stringify({ type: 'input', seq: seqBoxE.seq, up: true, down: false, left: true, right: false }));
      await sleep(1000 / 30);
    }
    await sleep(200);
    const posAfterInput = selfIn(latestSnapshot(botE), botE);
    const moved = Math.hypot(posAfterInput.x - posBeforeInput.x, posAfterInput.y - posBeforeInput.y);
    check(`(e) downed player's position ignores input (moved ${moved.toFixed(2)}px)`, moved < 0.01);
  } else {
    check("(e) downed player's position ignores input", false);
  }

  botE.ws.close();

  console.log('\n--- combat-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: combat-check' : '\nPASS: combat-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: combat-check errored:', err);
  process.exit(1);
});
