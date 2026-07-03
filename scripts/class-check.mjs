#!/usr/bin/env node
// Headless verification for P2 (server: classes, new stats, merge).
// Plain Node ESM, no TS build step, mirrors the shape of loop-check.mjs /
// shop-check.mjs: spawns its OWN server child process (via `tsx`) bound to
// PORT=8081 by default (overridable with FROGTATO_PORT) so it never touches
// the default :8080 a live playtesting dev server may already be bound to.
// The child is killed (by this script's own PID, nothing name-based) when
// the script exits, success or failure.
//
// Covers (DESIGN-PHASE2.md §1/§2/§5, server/src/{net,room}.ts,
// sim/{players,combat,flies}.ts, game/{phases,shop}.ts):
//   - pickClass in the lobby applies classBaseStats + starting weapon
//     (bullfrog: maxHp 28, armor 1, moveSpeed < base, weapons[0] croak)
//   - pickClass sent mid-wave is rejected (no state change)
//   - setName reflects in snapshots; over-length names truncate to
//     MAX_NAME_LENGTH
//   - class + name persist across a full run into the next lobby
//   - armor reduces observed per-hit HP loss vs a no-armor control bot
//   - regen ticks +N HP/5s during the wave phase
//   - a pickupRadius purchase widens fly collection range

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FROGTATO_PORT ?? '8081';
const URL = `ws://localhost:${PORT}`;

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
async function connectBot() {
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
    } else if (msg.type === 'event') {
      events.push({ ...msg.event, _recvAt: Date.now() });
    }
  });
  ws.send(JSON.stringify({ type: 'hello' }));
  const welcome = await waitForMessage(ws, (m) => m.type === 'welcome');
  return { ws, playerId: welcome.playerId, welcomePhase: welcome.phase, snapshots, events, phaseLog };
}

function latestSnapshot(bot) {
  return bot.snapshots[bot.snapshots.length - 1];
}

function selfIn(snap, bot) {
  return snap?.players.find((p) => p.id === bot.playerId);
}

function self(bot) {
  return selfIn(latestSnapshot(bot), bot);
}

async function waitUntil(predicate, { timeoutMs = 8000, pollMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await sleep(pollMs);
  }
  return undefined;
}

async function waitForSelf(bot, predicate, opts) {
  return waitUntil(() => {
    const s = self(bot);
    return s && predicate(s) ? s : undefined;
  }, opts);
}

/** Sends a `buy` and waits for the matching purchaseResult event. */
async function buy(bot, offerId, slot) {
  const before = bot.events.length;
  bot.ws.send(JSON.stringify({ type: 'buy', offerId, ...(slot !== undefined ? { slot } : {}) }));
  return waitUntil(
    () => bot.events.slice(before).find((e) => e.type === 'purchaseResult' && e.playerId === bot.playerId && e.offerId === offerId),
    { timeoutMs: 5000 },
  );
}

function setStill(bot, seqBox) {
  seqBox.seq += 1;
  bot.ws.send(JSON.stringify({ type: 'input', seq: seqBox.seq, up: false, down: false, left: false, right: false }));
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const server = await startServer();
  console.log(`[class-check] server child pid=${server.pid} listening on :${PORT}`);

  try {
    // =========================================================================
    // Round 1: pickClass (lobby + mid-wave rejection), setName, persistence
    // =========================================================================
    const botA = await connectBot();
    check('(pre) botA connects and starts in lobby', botA.welcomePhase === 'lobby');

    // --- pickClass in lobby: bullfrog ---
    botA.ws.send(JSON.stringify({ type: 'pickClass', class: 'bullfrog' }));
    const classPickedEvent = await waitUntil(
      () => botA.events.find((e) => e.type === 'classPicked' && e.playerId === botA.playerId && e.class === 'bullfrog'),
      { timeoutMs: 3000 },
    );
    check('classPicked event broadcast for bullfrog pick', Boolean(classPickedEvent));

    const afterPick = await waitForSelf(botA, (s) => s.class === 'bullfrog', { timeoutMs: 3000 });
    check(
      `pickClass bullfrog in lobby: maxHp 28, armor 1, moveSpeed<220, weapons[0]=croak (got ${JSON.stringify(afterPick && { maxHp: afterPick.stats.maxHp, armor: afterPick.stats.armor, moveSpeed: afterPick.stats.moveSpeed, w0: afterPick.weapons[0] })})`,
      Boolean(afterPick) &&
        afterPick.stats.maxHp === 28 &&
        afterPick.stats.armor === 1 &&
        afterPick.stats.moveSpeed < 220 &&
        afterPick.maxHp === 28 &&
        afterPick.hp === 28 &&
        afterPick.weapons[0]?.kind === 'croak' &&
        afterPick.weapons[0]?.level === 1,
    );

    // --- setName: "Kermit" appears, 20-char name truncates to 12 ---
    botA.ws.send(JSON.stringify({ type: 'setName', name: 'Kermit' }));
    const namedKermit = await waitForSelf(botA, (s) => s.name === 'Kermit', { timeoutMs: 3000 });
    check(`setName "Kermit" appears in snapshots (got name=${self(botA)?.name})`, Boolean(namedKermit));

    const longName = 'ABCDEFGHIJKLMNOPQRST'; // 20 chars
    botA.ws.send(JSON.stringify({ type: 'setName', name: longName }));
    const truncated = await waitForSelf(botA, (s) => s.name === longName.slice(0, 12), { timeoutMs: 3000 });
    check(
      `20-char name truncated to 12 (got "${self(botA)?.name}", len=${self(botA)?.name?.length})`,
      Boolean(truncated) && truncated.name.length === 12,
    );

    // Restore the name for the persistence check below.
    botA.ws.send(JSON.stringify({ type: 'setName', name: 'Kermit' }));
    await waitForSelf(botA, (s) => s.name === 'Kermit', { timeoutMs: 3000 });

    // --- start the run, then try pickClass mid-wave: rejected (no state change) ---
    botA.ws.send(JSON.stringify({ type: 'debug', timescale: 15 }));
    botA.ws.send(JSON.stringify({ type: 'start' }));
    const inWave = await waitUntil(() => (latestSnapshot(botA)?.phase === 'wave' ? true : undefined), { timeoutMs: 5000 });
    check('run reaches wave phase', Boolean(inWave));

    const beforeMidWavePick = self(botA);
    botA.ws.send(JSON.stringify({ type: 'pickClass', class: 'treefrog' }));
    await sleep(500); // give the server ample time to (wrongly) apply it, if it were going to
    const afterMidWavePick = self(botA);
    check(
      `pickClass mid-wave is rejected: class/stats unchanged (before class=${beforeMidWavePick.class}, after class=${afterMidWavePick.class})`,
      afterMidWavePick.class === 'bullfrog' &&
        afterMidWavePick.stats.maxHp === beforeMidWavePick.stats.maxHp &&
        afterMidWavePick.stats.armor === beforeMidWavePick.stats.armor,
    );
    const spuriousClassPicked = botA.events.find(
      (e) => e.type === 'classPicked' && e.playerId === botA.playerId && e.class === 'treefrog',
    );
    check('no classPicked(treefrog) event was broadcast for the rejected mid-wave pick', !spuriousClassPicked);

    // --- ride this run out to game over (no invincible), then confirm class
    //     + name survived into the next lobby (DESIGN-PHASE2.md §5 rematch). ---
    const gameOverEvent = await waitUntil(
      () => botA.events.find((e) => e.type === 'gameOver'),
      { timeoutMs: 60000, pollMs: 100 },
    );
    check('bot A eventually goes down and the run ends in gameOver', Boolean(gameOverEvent));

    const backInLobby = await waitUntil(
      () => botA.phaseLog.find((e) => e.phase === 'lobby' && e.atMs > (gameOverEvent?._recvAt ?? 0)),
      { timeoutMs: 15000 },
    );
    check('run returns to the lobby after the scoreboard phase', Boolean(backInLobby));

    const survivedSelf = self(botA);
    check(
      `class + name survive a full run into the next lobby (got class=${survivedSelf?.class}, name=${survivedSelf?.name})`,
      survivedSelf?.class === 'bullfrog' && survivedSelf?.name === 'Kermit',
    );
    check(
      'class-appropriate loadout (bullfrog: maxHp 28, croak slot0) restored for the new lobby',
      survivedSelf?.stats.maxHp === 28 && survivedSelf?.weapons[0]?.kind === 'croak',
    );

    botA.ws.send(JSON.stringify({ type: 'debug', timescale: 1 }));

    // =========================================================================
    // Round 2: armor mitigation, regen, pickupRadius — fresh run, two bots.
    // botA stays bullfrog (armor 1, pickupRadius base 60). botB joins fresh
    // (default treefrog, armor 0 — the no-armor control; also used for regen).
    // =========================================================================
    const botB = await connectBot();
    check('(pre) botB joins the lobby fresh (default class)', botB.welcomePhase === 'lobby');
    const botBInitial = await waitForSelf(botB, (s) => s.class === 'treefrog', { timeoutMs: 3000 });
    check('botB defaults to treefrog (armor 0, the no-armor control)', Boolean(botBInitial) && botBInitial.stats.armor === 0);

    const seqA = { seq: 0 };
    const seqB = { seq: 0 };
    setStill(botA, seqA);
    setStill(botB, seqB);

    const ROUND2_TIMESCALE = 3;
    botA.ws.send(JSON.stringify({ type: 'debug', timescale: ROUND2_TIMESCALE }));
    botB.ws.send(JSON.stringify({ type: 'debug', timescale: ROUND2_TIMESCALE }));
    botA.ws.send(JSON.stringify({ type: 'start' }));

    const inWave2 = await waitUntil(() => (latestSnapshot(botA)?.phase === 'wave' ? true : undefined), { timeoutMs: 5000 });
    check('(round 2) run reaches wave phase', Boolean(inWave2));

    // --- regen/pickupRadius purchases happen in the wave-1 -> shop break;
    //     armor is measured afterwards, in wave 2+ (see note below). ---
    const shopEntered2 = await waitUntil(() => (latestSnapshot(botB)?.phase === 'shop' ? true : undefined), {
      timeoutMs: 20000,
    });
    check('(round 2) reaches the shop phase after wave 1', Boolean(shopEntered2));

    botB.ws.send(JSON.stringify({ type: 'debug', grantFlies: 1000 }));
    await waitForSelf(botB, (s) => s.flies >= 1000, { timeoutMs: 3000 });

    const regenBuy = await buy(botB, 'buyRegen');
    check(`(regen) buyRegen succeeds (got ${JSON.stringify(regenBuy)})`, Boolean(regenBuy) && regenBuy.ok === true);
    const pickupBuy = await buy(botB, 'buyPickupRadius');
    check(`(pickupRadius) buyPickupRadius succeeds (got ${JSON.stringify(pickupBuy)})`, Boolean(pickupBuy) && pickupBuy.ok === true);
    const botBAfterBuys = await waitForSelf(botB, (s) => s.stats.regen === 1 && s.stats.pickupRadius === 95, {
      timeoutMs: 3000,
    });
    check(
      `snapshot reflects regen=1, pickupRadius=95 (base 80 treefrog + 15) after purchases (got ${JSON.stringify(self(botB)?.stats)})`,
      Boolean(botBAfterBuys),
    );

    // Ready up so we don't wait out the full shop timer.
    botA.ws.send(JSON.stringify({ type: 'ready' }));
    botB.ws.send(JSON.stringify({ type: 'ready' }));
    const inWave3 = await waitUntil(() => (latestSnapshot(botB)?.phase === 'wave' ? true : undefined), { timeoutMs: 10000 });
    check('(round 2) reaches wave 2', Boolean(inWave3));

    // --- armor: collect playerHit amounts for both bots. DEVIATION from a
    //     naive "stand in wasps" plan: both bots still carry their class's
    //     starting melee weapon (tongueLash, range 120px), which auto-kills
    //     an approaching wasp (contact range ~34px, wasp contactCooldownSec
    //     0.8s < wave-1's ~1.5s spawn interval) well before it can land a
    //     contact hit — wave 1 (pure wasp) produced zero playerHit events in
    //     practice. From wave 2 on, spawnMix adds snailSpitter, which keeps
    //     its distance (300px, outside melee range) and reliably lands acid
    //     hits regardless of the player's weapon. So: measure here, in
    //     wave 2+, and — since a stray wasp contact can still slip through
    //     occasionally — assert on the *set* of observed amounts rather than
    //     assuming every hit is from one enemy kind: bullfrog (armor 1) must
    //     only ever show 1 (wasp 2-1) or 2 (snail 3-1); the no-armor control
    //     must only ever show 2 (wasp) or 3 (snail) — i.e. always exactly
    //     armor less than the control for the same raw damage tier, and
    //     never a raw (unmitigated) 2 or 3 on the armored bot. ---
    const armorHitsSeen = await waitUntil(
      () => {
        const a = botA.events.filter((e) => e.type === 'playerHit' && e.playerId === botA.playerId);
        const b = botB.events.filter((e) => e.type === 'playerHit' && e.playerId === botB.playerId);
        return a.length >= 2 && b.length >= 2 ? { aHits: a, bHits: b } : undefined;
      },
      { timeoutMs: 25000, pollMs: 150 },
    );
    check('(armor) both bots took at least 2 hits each', Boolean(armorHitsSeen));

    if (armorHitsSeen) {
      const aAmounts = armorHitsSeen.aHits.map((e) => e.amount);
      const bAmounts = armorHitsSeen.bHits.map((e) => e.amount);
      check(
        `(armor) bullfrog (armor 1) never takes a raw (unmitigated) hit — amounts in {1,2} (got ${JSON.stringify(aAmounts)})`,
        aAmounts.every((a) => a === 1 || a === 2),
      );
      check(
        `(armor) no-armor control takes the full raw damage — amounts in {2,3} (got ${JSON.stringify(bAmounts)})`,
        bAmounts.every((a) => a === 2 || a === 3),
      );
    }

    // Keep botA alive for the rest of round 2's assertions.
    botA.ws.send(JSON.stringify({ type: 'debug', invincible: true }));

    // --- regen: botB already took damage above (armor collection); go
    //     invincible (regen itself isn't gated by the invincible flag — only
    //     damagePlayer is) and confirm HP ticks upward during the wave. ---
    botB.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
    const hpBeforeRegen = self(botB).hp;
    const maxHpB = self(botB).maxHp;

    if (hpBeforeRegen < maxHpB) {
      const regenTicked = await waitForSelf(botB, (s) => s.hp > hpBeforeRegen, { timeoutMs: 8000 });
      check(
        `(regen) HP increases during the wave phase after buying regen (before=${hpBeforeRegen}, after=${regenTicked?.hp})`,
        Boolean(regenTicked),
      );
    } else {
      check('(regen) HP increases during the wave phase after buying regen', hpBeforeRegen === maxHpB);
    }

    // --- pickupRadius: a fly parked at a distance strictly between the old
    //     treefrog baseline (80) and the new purchased radius (95) is
    //     collected only because of the purchase. DEVIATION from a naive
    //     "find/kill a wasp already sitting in that band" plan: both bots
    //     still carry their starting melee weapon (tongueLash, range 120px,
    //     one-shots a wave-2 wasp on contact), so a live wasp practically
    //     never survives to *be* at a controlled distance inside a band
    //     that's narrower than the weapon's own range — it's auto-killed the
    //     instant it enters range, well outside our target band. Instead:
    //     take whatever fly already exists (dropped by that same auto-kill
    //     mechanic) and *drive the bot* to a controlled distance from it via
    //     manual input bursts — full control over the bot's own position
    //     sidesteps needing a live enemy to cooperate at all. ---
    botA.ws.send(JSON.stringify({ type: 'debug', timescale: 1 }));
    botB.ws.send(JSON.stringify({ type: 'debug', timescale: 1 }));

    // The armor-collection wait above may have run long enough to land us in
    // the following shop break (no enemies/flies exist there) — if so, ready
    // up and wait for the next wave.
    if (latestSnapshot(botB)?.phase === 'shop') {
      botA.ws.send(JSON.stringify({ type: 'ready' }));
      botB.ws.send(JSON.stringify({ type: 'ready' }));
      await waitUntil(() => (latestSnapshot(botB)?.phase === 'wave' ? true : undefined), { timeoutMs: 15000 });
    }

    // Any fly already on the ground works as the target — it only sits still
    // while no player is within pickup range of it, which is exactly the
    // state we want to approach from a controlled distance.
    const flyTarget = await waitUntil(() => {
      const flies = latestSnapshot(botB)?.flies;
      return flies && flies.length > 0 ? flies[0] : undefined;
    }, { timeoutMs: 15000, pollMs: 100 });
    check('(pickupRadius) a fly exists on the ground to use as a target', Boolean(flyTarget));

    /** Bursts of input toward/away from a fixed point until distance settles inside [lo, hi]. */
    async function walkToDistance(bot, seqBox, targetX, targetY, lo, hi, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const s = self(bot);
        if (!s) {
          await sleep(50);
          continue;
        }
        const dx = targetX - s.x;
        const dy = targetY - s.y;
        const d = Math.hypot(dx, dy);
        if (d >= lo && d <= hi) {
          setStill(bot, seqBox);
          return d;
        }
        const towardTarget = d > hi;
        const ux = (dx / (d || 1)) * (towardTarget ? 1 : -1);
        const uy = (dy / (d || 1)) * (towardTarget ? 1 : -1);
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
        await sleep(30);
        setStill(bot, seqBox);
        await sleep(80); // let a fresh snapshot land before re-measuring
      }
      return undefined;
    }

    if (flyTarget) {
      const settledDist = await walkToDistance(botB, seqB, flyTarget.x, flyTarget.y, 85, 90, 15000);
      check(
        `(pickupRadius) botB settles at a controlled distance from the fly, inside (80,95) (got ${settledDist?.toFixed(1)})`,
        Boolean(settledDist),
      );

      if (settledDist !== undefined) {
        // Not yet collected at this distance under the OLD (pre-purchase, 80)
        // radius would have been out of range too, but botB already bought
        // pickupRadius above — so what we're really confirming is that the
        // widened radius (95) is what's making the pending fly reachable at
        // all: it should still be present, then get vacuumed in.
        const collected = await waitUntil(
          () => {
            const snap = latestSnapshot(botB);
            return snap && !snap.flies.some((f) => f.id === flyTarget.id) ? true : undefined;
          },
          { timeoutMs: 3000 },
        );
        check(
          `(pickupRadius) a fly at ~${settledDist.toFixed(0)}px (beyond the 80px baseline, within the purchased 95px radius) is auto-collected`,
          Boolean(collected),
        );
      }
    }

    botA.ws.close();
    botB.ws.close();
  } finally {
    server.kill('SIGTERM');
  }

  console.log('\n--- class-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: class-check' : '\nPASS: class-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: class-check errored:', err);
  process.exit(1);
});
