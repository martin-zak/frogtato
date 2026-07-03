#!/usr/bin/env node
// Headless verification for T9 (server: shop purchase validation & pricing).
// Plain Node ESM, no TS build step, mirrors the shape of loop-check.mjs:
// spawns its OWN server child process (via `tsx`) bound to PORT=8081 by
// default (overridable with FROGTATO_PORT) so it never touches the default
// :8080 a live playtesting dev server may already be bound to. The child is
// killed (by this script's own PID, nothing name-based) when the script
// exits, success or failure.
//
// Drives a bot to the shop phase via debug `timescale` (accelerated wave 1)
// + `invincible` (auto-survive), then `grantFlies` for funds, and exercises
// every `buy` validation path from server/src/game/shop.ts:
//   - successful weapon buy into the empty slot (exact price deducted)
//   - rejection with "slots full" once both slots are occupied
//   - rejection with "not enough flies" (fresh 0-flies bot)
//   - stat price escalation across two buyMaxHp purchases (base, then
//     base+increment), and priceNext matching the second price
//   - move-speed purchase cap: 3 succeed, the 4th is rejected
//     "move-speed cap reached" (the client's exact disable-reason string —
//     see client/src/ui/shop/catalog.ts)
//   - weapon-slot upgrade: with 2 eligible slots, an unqualified upgrade is
//     rejected "invalid slot"; upgrading the starting tongue slot (index 0)
//     to level II charges WEAPON_UPGRADE_PRICES[2] and the snapshot shows
//     level 2
//   - a buy sent outside the shop phase is rejected "wrong phase"
//   - all-ready still ends the shop early with a buy in between
//     (regression of T8 behavior)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FROGTATO_PORT ?? '8081';
const URL = `ws://localhost:${PORT}`;
const TIMESCALE = 20;

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

function fliesOf(bot) {
  return selfIn(latestSnapshot(bot), bot)?.flies;
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

/** Sends a `buy` and waits for the matching purchaseResult event (by playerId+offerId, first one after the send). */
async function buy(bot, offerId, slot) {
  const before = bot.events.length;
  bot.ws.send(JSON.stringify({ type: 'buy', offerId, ...(slot !== undefined ? { slot } : {}) }));
  const result = await waitUntil(
    () => bot.events.slice(before).find((e) => e.type === 'purchaseResult' && e.playerId === bot.playerId && e.offerId === offerId),
    { timeoutMs: 5000 },
  );
  return result;
}

/** Waits for a snapshot whose value at `getter(self)` satisfies `predicate`. */
async function waitForSelf(bot, predicate, opts) {
  return waitUntil(() => {
    const self = selfIn(latestSnapshot(bot), bot);
    return self && predicate(self) ? self : undefined;
  }, opts);
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

async function main() {
  const server = await startServer();
  console.log(`[shop-check] server child pid=${server.pid} listening on :${PORT}`);

  try {
    const bot = await connectBot();
    bot.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
    bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));

    const startedInLobby = await waitUntil(() => (latestSnapshot(bot)?.phase === 'lobby' ? true : undefined), {
      timeoutMs: 5000,
    });
    check('(pre) bot connects and starts in lobby', Boolean(startedInLobby));

    bot.ws.send(JSON.stringify({ type: 'start' }));

    const inWave = await waitUntil(() => (latestSnapshot(bot)?.phase === 'wave' ? true : undefined), { timeoutMs: 5000 });
    check('(pre) run reaches wave phase', Boolean(inWave));

    // --- buy outside shop phase: rejected "wrong phase" ---
    const wrongPhaseResult = await buy(bot, 'buyTongueLash');
    check(
      `buy during wave phase is rejected "wrong phase" (got ${JSON.stringify(wrongPhaseResult)})`,
      Boolean(wrongPhaseResult) && wrongPhaseResult.ok === false && wrongPhaseResult.reason === 'wrong phase',
    );

    const shopEntered = await waitUntil(() => (latestSnapshot(bot)?.phase === 'shop' ? true : undefined), {
      timeoutMs: 15000,
    });
    check('bot reaches shop phase (timescale-accelerated wave 1, invincible)', Boolean(shopEntered));
    const shopEnteredAtMs = Date.now();

    bot.ws.send(JSON.stringify({ type: 'debug', grantFlies: 1000 }));
    await waitForSelf(bot, (s) => s.flies >= 1000, { timeoutMs: 3000 });
    // Snapshot broadcast (~SNAPSHOT_HZ) lags a purchaseResult event (sent
    // immediately on the ws) by up to one broadcast period, so every "flies
    // deducted by exactly N" assertion below tracks an expected running
    // total and *waits* for the next snapshot to catch up to it, rather than
    // reading `fliesOf(bot)` synchronously right after the event arrives.
    let expectedFlies = fliesOf(bot);

    async function settleFlies(label) {
      const settled = await waitUntil(() => (fliesOf(bot) === expectedFlies ? true : undefined), { timeoutMs: 3000 });
      check(`${label} (expected flies=${expectedFlies}, got=${fliesOf(bot)})`, Boolean(settled));
    }

    // --- successful weapon buy into the empty slot ---
    const weaponBuyResult = await buy(bot, 'buyBubbleBlaster');
    check(
      `weapon buy into empty slot succeeds (got ${JSON.stringify(weaponBuyResult)})`,
      Boolean(weaponBuyResult) && weaponBuyResult.ok === true,
    );
    const filledSlot1 = await waitForSelf(bot, (s) => s.weapons[1] !== null, { timeoutMs: 3000 });
    check(
      'snapshot shows the bought weapon in the (previously empty) slot 1',
      Boolean(filledSlot1) && filledSlot1.weapons[1]?.kind === 'bubble' && filledSlot1.weapons[1]?.level === 1,
    );
    expectedFlies -= 15;
    await settleFlies('flies deducted by exact weapon price (15)');

    // --- both slots now full: rejection "slots full" ---
    const slotsFullResult = await buy(bot, 'buyCroakNova');
    check(
      `weapon buy rejected "slots full" once both slots occupied (got ${JSON.stringify(slotsFullResult)})`,
      Boolean(slotsFullResult) && slotsFullResult.ok === false && slotsFullResult.reason === 'slots full',
    );
    check('flies unchanged on rejected buy', fliesOf(bot) === expectedFlies);

    // --- insufficient funds: a fresh bot joining during shop starts with 0 flies ---
    const poorBot = await connectBot();
    check('a bot joining during the shop phase joins immediately (not a spectator)', poorBot.welcomePhase === 'shop');
    const poorSnap = await waitUntil(() => latestSnapshot(poorBot), { timeoutMs: 3000 });
    check('fresh joiner starts with 0 flies', selfIn(poorSnap, poorBot)?.flies === 0);
    const insufficientResult = await buy(poorBot, 'buyTongueLash');
    check(
      `buy rejected "not enough flies" for a 0-flies player (got ${JSON.stringify(insufficientResult)})`,
      Boolean(insufficientResult) && insufficientResult.ok === false && insufficientResult.reason === 'not enough flies',
    );
    poorBot.ws.close();

    // --- stat price escalation: two successive buyMaxHp purchases ---
    const maxHpBuy1 = await buy(bot, 'buyMaxHp');
    check(
      `1st buyMaxHp succeeds at the base price (got ${JSON.stringify(maxHpBuy1)})`,
      Boolean(maxHpBuy1) && maxHpBuy1.ok === true && maxHpBuy1.priceNext === 15,
    );
    expectedFlies -= 10;
    await settleFlies('1st buyMaxHp charged the base price of 10 flies');

    const maxHpBuy2 = await buy(bot, 'buyMaxHp');
    check(
      `2nd buyMaxHp succeeds at base+increment (got ${JSON.stringify(maxHpBuy2)})`,
      Boolean(maxHpBuy2) && maxHpBuy2.ok === true && maxHpBuy2.priceNext === 20,
    );
    expectedFlies -= 15;
    await settleFlies('2nd buyMaxHp charged base+increment of 15 flies');

    // --- move-speed cap: 3 succeed, 4th rejected ---
    const speedBuy1 = await buy(bot, 'buyMoveSpeed');
    expectedFlies -= 12;
    await settleFlies('1st buyMoveSpeed charged the base price of 12 flies');
    const speedBuy2 = await buy(bot, 'buyMoveSpeed');
    expectedFlies -= 18;
    await settleFlies('2nd buyMoveSpeed charged base+increment of 18 flies');
    const speedBuy3 = await buy(bot, 'buyMoveSpeed');
    expectedFlies -= 24;
    await settleFlies('3rd buyMoveSpeed charged base+2*increment of 24 flies');
    check(
      `move-speed purchases 1-3 all succeed (got ${[speedBuy1, speedBuy2, speedBuy3].map((r) => r?.ok)})`,
      [speedBuy1, speedBuy2, speedBuy3].every((r) => r && r.ok === true),
    );
    const speedBuy4 = await buy(bot, 'buyMoveSpeed');
    check(
      `4th move-speed purchase rejected "move-speed cap reached" (got ${JSON.stringify(speedBuy4)})`,
      Boolean(speedBuy4) && speedBuy4.ok === false && speedBuy4.reason === 'move-speed cap reached',
    );
    check('flies unchanged on the rejected 4th move-speed buy', fliesOf(bot) === expectedFlies);

    // --- upgrade: 2 eligible slots (tongue @ slot0, bubble @ slot1), both level I ---
    const upgradeNoSlotResult = await buy(bot, 'upgradeSlot');
    check(
      `upgrade with 2 eligible slots and no slot given is rejected "invalid slot" (got ${JSON.stringify(upgradeNoSlotResult)})`,
      Boolean(upgradeNoSlotResult) && upgradeNoSlotResult.ok === false && upgradeNoSlotResult.reason === 'invalid slot',
    );

    const upgradeResult = await buy(bot, 'upgradeSlot', 0);
    check(
      `upgrading slot 0 (tongue) to level II succeeds at the level-II price (got ${JSON.stringify(upgradeResult)})`,
      Boolean(upgradeResult) && upgradeResult.ok === true,
    );
    const upgradedSelf = await waitForSelf(bot, (s) => s.weapons[0]?.level === 2, { timeoutMs: 3000 });
    check('snapshot shows slot 0 at level 2 after upgrade', Boolean(upgradedSelf));
    expectedFlies -= 20;
    await settleFlies('upgrade charged the level-II price of 20 flies');

    // --- all-ready still ends the shop early, with a buy having happened in between ---
    bot.ws.send(JSON.stringify({ type: 'ready' }));
    const leftShop = await waitUntil(
      () => bot.phaseLog.find((e) => e.atMs >= shopEnteredAtMs && e.phase !== 'shop'),
      { timeoutMs: 8000 },
    );
    check('all-ready (single active player) ends the shop and advances the phase', Boolean(leftShop));
    if (leftShop) {
      const shopDurationMs = leftShop.atMs - shopEnteredAtMs;
      check(
        `shop ended well under the full 30s/timescale break despite buys in between (took ${shopDurationMs}ms)`,
        shopDurationMs < 8000,
      );
    }

    bot.ws.close();
  } finally {
    server.kill('SIGTERM');
  }

  console.log('\n--- shop-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: shop-check' : '\nPASS: shop-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: shop-check errored:', err);
  process.exit(1);
});
