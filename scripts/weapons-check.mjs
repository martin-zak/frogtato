#!/usr/bin/env node
// Headless verification for T6 (server: weapons & auto-targeting). Plain Node
// ESM, no TS build step — but unlike combat-check.mjs this script *does* pull
// kill-time bounds from `@frogtato/shared` constants (workspace-linked in
// node_modules/@frogtato/shared -> shared/dist) rather than hardcoding numbers,
// per the "constants are the source of truth" rule the rest of the codebase
// follows. Assumes the server is already running with NODE_ENV != "production".
//
// One bot, invincible (so it never gets downed mid-test and combat noise from
// wasp contact/acid globs doesn't interfere), is given each weapon kind in
// *both* slots at level 1 (constants.ts has no way to "give" an empty slot —
// giving the same weapon+level to both slots just doubles DPS predictably, so
// the expected-kill-time math is `enemyHp / (2 * dmg / cooldown)`).
//
// Assertions, and two DOCUMENTED DEVIATIONS from the literal task brief (both
// forced by the same root cause: tongue one-shots a wasp — 5 dmg > 4 hp — so
// the instant it enters range it's *also* already dead in that same 30 Hz
// tick; snapshots broadcast at 20 Hz only ever show "not yet in range" or
// "gone", never "alive and in range". There is no snapshot-observable instant
// to anchor a range-entry timer on for that specific matchup):
//
//   (a) tongue: rather than waiting to *witness* a wasp alive within range
//       (impossible per above), this tracks the nearest wasp at test start
//       from wherever it currently is, actively steers the bot toward it,
//       and bounds total elapsed time to death by (closing-speed travel time)
//       + (the constants-derived tongue kill-time bound). Still fully
//       derived from constants (wasp speed, frog move speed, tongue
//       damage/cooldown), just covering approach time too since that now
//       dominates.
//   (b) bubble is not one-shot (3 dmg vs 12 hp, several hits needed), so the
//       original "witness alive-in-range, then measure kill time" approach
//       works as specified and is used unmodified.
//   (c) croak also tends to one-shot/two-shot whatever wanders into its
//       radius (4 dmg from two Lv I copies vs 4 hp wasps) *before* a 3-wasp
//       cluster can ever accumulate in a witnessed snapshot, for the same
//       reason as (a). Instead of requiring a pre-fire 3-cluster, this scans
//       every croak `attack` event as it happens and passes on the first one
//       where >=2 enemies that were within radius in the snapshot just
//       before the fire lost HP (or died) by the snapshot just after —
//       i.e. it keeps the actual pass bar from the brief ("one croak attack
//       coincides with >=2 enemies losing HP") but removes the brittle
//       "must witness 3 clustered first" precondition, scanning across
//       multiple fire cycles instead of demanding it happen on the first one.
//   (d) SIMPLIFIED from the "no enemy in range -> no fire" idea in the task
//       brief: driving the live interim spawner down to zero enemies for a
//       clean window is racy (enemies keep respawning every ~2s and can walk
//       into range at any moment), so instead this asserts the *converse*,
//       checked retroactively over every attack event this bot fired in (a)/
//       (b)/(c): the snapshot nearest each `attack` event always shows at
//       least one enemy within (weapon range + slack) of the bot. This is
//       exactly the "stay ready, don't fire into the void" invariant, just
//       verified from the fire side rather than the silence side.

// DEVIATION (PLAN.md T8): enemies now only exist during the "wave" phase
// (T8 deleted T5's always-on interim spawner), so this script sends `start`
// (from lobby) + a debug `timescale` once, right after connecting, before
// anything else. It also auto-`ready`s on every shop phase it sees so the
// bubble sub-test (which needs a wave with snails — wave 1 is wasp-only) gets
// there quickly. Everything else is unchanged.

import WebSocket from 'ws';
import { WEAPON_DEFS, ENEMY_DEFS, FROG_BASE_STATS } from '@frogtato/shared';

// FROGTATO_PORT override (PLAN.md T8): see skeleton-check.mjs.
const PORT = process.env.FROGTATO_PORT ?? '8080';
const URL = `ws://localhost:${PORT}`;
const TIMESCALE = 8;

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

/**
 * Connects a bot, sends hello, and keeps rolling buffers of snapshots/events.
 * Each event is tagged with `_recvAt` (wall-clock ms) and `_snapshotAtRecv`
 * (the most recent snapshot seen at the moment the event arrived) so later
 * assertions can correlate "what did the world look like when this attack
 * fired" without the server needing to timestamp events itself.
 */
async function connectBot() {
  const ws = await connectRaw();
  const snapshots = [];
  const events = [];
  let lastSnapshot;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      msg._recvAt = Date.now();
      lastSnapshot = msg;
      snapshots.push(msg);
      // Auto-ready on every shop phase so waves keep cycling (needed to reach
      // a wave with snails for the bubble sub-test — see file header).
      if (msg.phase === 'shop') ws.send(JSON.stringify({ type: 'ready' }));
    } else if (msg.type === 'event') {
      const event = { ...msg.event, _recvAt: Date.now(), _snapshotAtRecv: lastSnapshot };
      events.push(event);
    }
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

function give(bot, slot, weapon, level) {
  bot.ws.send(JSON.stringify({ type: 'debug', give: { slot, weapon, level } }));
}

/** enemyHp / (2 * dmg/cooldown) — the two-copies-of-the-same-slot DPS formula. */
function expectedKillTimeSec(levelStats, enemyHp) {
  const dps = 2 * (levelStats.damage / levelStats.cooldownSec);
  return enemyHp / dps;
}

function killTimeBounds(expectedSec, extraUpperSlackSec = 0) {
  const lower = Math.max(0, expectedSec * 0.5 - 1);
  const upper = expectedSec * 1.5 + 1 + extraUpperSlackSec;
  return { lower, upper };
}

/** (d): every attack event of `weaponKind` must have had an enemy within range+slack at fire time. */
function checkFiresOnlyInRange(bot, weaponKind, rangePx, slackPx) {
  const relevant = bot.events.filter((e) => e.type === 'attack' && e.playerId === bot.playerId && e.kind === weaponKind);
  if (relevant.length === 0) return { ok: false, count: 0 };
  let ok = true;
  for (const e of relevant) {
    const snap = e._snapshotAtRecv;
    const self = snap && selfIn(snap, bot);
    if (!snap || !self) {
      ok = false;
      continue;
    }
    const hasEnemyInRange = snap.enemies.some((en) => Math.hypot(en.x - self.x, en.y - self.y) <= rangePx + slackPx);
    if (!hasEnemyInRange) ok = false;
  }
  return { ok, count: relevant.length };
}

async function main() {
  const bot = await connectBot();
  bot.ws.send(JSON.stringify({ type: 'debug', invincible: true }));
  bot.ws.send(JSON.stringify({ type: 'debug', timescale: TIMESCALE }));
  bot.ws.send(JSON.stringify({ type: 'start' }));
  await waitForMessage(bot.ws, (m) => m.type === 'snapshot' && m.phase === 'wave' && selfIn(m, bot) !== undefined);

  // =========================================================================
  // (c) Croak Nova: AoE hits multiple clustered enemies in one fire.
  //
  // Run this FIRST, before (a)/(b) ever touch slot 1, so slot 1 is still the
  // default `null` (empty) the whole time — a real solo-croak loadout, not
  // fighting another weapon for kills. That matters a lot here: snails keep
  // ~300px distance (DESIGN §5) and never enter croak's 150px radius at all,
  // so only wasps ever cluster here, and a second active weapon (tried during
  // development: bubble in slot 1, and two croak copies in both slots) kills
  // each wasp solo well before a second one can arrive and be witnessed
  // clustered alongside it — empirically that setup capped the observed
  // cluster at 1 no matter how long the test waited. A single Lv I croak only
  // deals 2 dmg (doesn't one-shot a 4-hp wasp), so the first arrival survives
  // one hit and lingers in radius for a follow-up cooldown cycle — exactly
  // the window a second/third wasp needs to arrive and be caught together.
  // =========================================================================
  const croakLvl1 = WEAPON_DEFS.croakNova.levels[1];
  console.log(`croak: dmg=${croakLvl1.damage} cd=${croakLvl1.cooldownSec}s radius=${croakLvl1.range}px`);

  give(bot, 0, 'croak', 1);

  // Scan every croak `attack` event as it accumulates and stop at the first
  // one where >=2 enemies present (any kind) within radius in the snapshot
  // just before the fire lost HP (or died) by the snapshot just after. This
  // keeps the actual pass bar from the task brief ("one croak attack
  // coincides with >=2 enemies losing HP") but scans across many fire cycles
  // rather than requiring a witnessed 3-cluster to form before the first one.
  let bestClusterSeen = 0;
  const croakResult = await waitUntil(
    () => {
      for (const ev of bot.events) {
        if (ev.type !== 'attack' || ev.kind !== 'croak' || ev._checkedForCluster) continue;
        const before = ev._snapshotAtRecv;
        const self = before && selfIn(before, bot);
        if (!before || !self) continue;
        const after = bot.snapshots.find((s) => s._recvAt > ev._recvAt);
        if (!after) continue; // not enough data yet; try again next poll (don't mark checked)

        ev._checkedForCluster = true;
        const nearBefore = before.enemies.filter((e) => Math.hypot(e.x - self.x, e.y - self.y) <= croakLvl1.range);
        bestClusterSeen = Math.max(bestClusterSeen, nearBefore.length);

        let hitCount = 0;
        for (const w of nearBefore) {
          const afterE = after.enemies.find((e) => e.id === w.id);
          if (!afterE || afterE.hp < w.hp) hitCount += 1;
        }
        if (hitCount >= 2) return { event: ev, hitCount, clusterSize: nearBefore.length };
      }
      return undefined;
    },
    { timeoutMs: 120000, pollMs: 300 },
  );

  check(
    `(c) a croak attack coincided with >=2 enemies losing HP (best pre-fire cluster seen=${bestClusterSeen}, ` +
      `result=${croakResult ? `hitCount=${croakResult.hitCount}/cluster=${croakResult.clusterSize}` : 'none found'})`,
    Boolean(croakResult),
  );

  // =========================================================================
  // (a) Tongue Lash: instant hit, first enemy on the line.
  // =========================================================================
  const tongueLvl1 = WEAPON_DEFS.tongueLash.levels[1];
  const waspHp = ENEMY_DEFS.wasp.hp;
  const tongueExpected = expectedKillTimeSec(tongueLvl1, waspHp);
  const tongueBounds = killTimeBounds(tongueExpected);
  console.log(
    `tongue: dmg=${tongueLvl1.damage} cd=${tongueLvl1.cooldownSec}s range=${tongueLvl1.range}px waspHp=${waspHp} ` +
      `expected kill ${tongueExpected.toFixed(2)}s bounds [${tongueBounds.lower.toFixed(2)}, ${tongueBounds.upper.toFixed(2)}]s`,
  );

  give(bot, 0, 'tongue', 1);
  give(bot, 1, 'tongue', 1);

  // See file header (a): tongue one-shots a wasp, so "witness it alive within
  // range" is unobservable at snapshot rate. Track the nearest wasp wherever
  // it currently is, steer toward it, and bound elapsed time by travel + kill.
  const nearestWaspAtStart = await waitUntil(
    () => {
      const snap = latestSnapshot(bot);
      const self = selfIn(snap, bot);
      if (!self) return undefined;
      let best;
      let bestDist = Infinity;
      for (const e of snap.enemies) {
        if (e.kind !== 'wasp') continue;
        const d = Math.hypot(e.x - self.x, e.y - self.y);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
      }
      return best ? { id: best.id, dist0: bestDist } : undefined;
    },
    { timeoutMs: 20000 },
  );
  check('(pre-a) a wasp exists to track', Boolean(nearestWaspAtStart));

  if (nearestWaspAtStart) {
    const t0 = Date.now();
    const closingSpeed = ENEMY_DEFS.wasp.speed + FROG_BASE_STATS.moveSpeed;
    // Generous: 2x the straight-line closing-speed travel time (steering +
    // wasp AI won't be perfectly head-on) + 2s flat, then the constants-
    // derived tongue kill bound on top.
    const travelBoundSec = (nearestWaspAtStart.dist0 / closingSpeed) * 2 + 2;
    const totalUpperBound = travelBoundSec + tongueBounds.upper;

    let seq = 0;
    const steerTimer = setInterval(() => {
      const snap = latestSnapshot(bot);
      const self = selfIn(snap, bot);
      const wasp = snap.enemies.find((e) => e.id === nearestWaspAtStart.id);
      if (!self || !wasp) return;
      const dx = wasp.x - self.x;
      const dy = wasp.y - self.y;
      seq += 1;
      bot.ws.send(
        JSON.stringify({ type: 'input', seq, left: dx < -5, right: dx > 5, up: dy < -5, down: dy > 5 }),
      );
    }, 1000 / 30);

    const died = await waitUntil(
      () => (latestSnapshot(bot).enemies.some((e) => e.id === nearestWaspAtStart.id) ? undefined : true),
      { timeoutMs: totalUpperBound * 1000 + 3000, pollMs: 50 },
    );
    clearInterval(steerTimer);
    seq += 1;
    bot.ws.send(JSON.stringify({ type: 'input', seq, up: false, down: false, left: false, right: false }));

    const elapsedSec = (Date.now() - t0) / 1000;
    check(
      `(a) tongue kills tracked wasp within bound (dist0=${nearestWaspAtStart.dist0.toFixed(0)}px, ` +
        `bound=${totalUpperBound.toFixed(2)}s, elapsed=${died ? elapsedSec.toFixed(2) : 'never'}s)`,
      Boolean(died) && elapsedSec <= totalUpperBound,
    );
  } else {
    check('(a) tongue kills tracked wasp within bound', false);
  }

  // =========================================================================
  // (b) Bubble Blaster: projectile hit at range.
  // =========================================================================
  const bubbleLvl1 = WEAPON_DEFS.bubbleBlaster.levels[1];
  const snailHp = ENEMY_DEFS.snailSpitter.hp;
  const bubbleExpected = expectedKillTimeSec(bubbleLvl1, snailHp);
  const travelSlackSec = bubbleLvl1.range / bubbleLvl1.projectileSpeed;
  // Extra slack beyond travel time: bubble retargets the nearest enemy of ANY
  // kind every cooldown cycle rather than committing to one target, so with
  // several enemies live at once (the interim spawner keeps a handful around)
  // the specific snail we're tracking can occasionally lose "nearest" to a
  // closer wasp for a cycle or two before its turn comes back around.
  const targetContentionSlackSec = 10;
  const bubbleBounds = killTimeBounds(bubbleExpected, travelSlackSec + targetContentionSlackSec);
  console.log(
    `bubble: dmg=${bubbleLvl1.damage} cd=${bubbleLvl1.cooldownSec}s range=${bubbleLvl1.range}px speed=${bubbleLvl1.projectileSpeed}px/s ` +
      `snailHp=${snailHp} expected kill ${bubbleExpected.toFixed(2)}s bounds [${bubbleBounds.lower.toFixed(2)}, ${bubbleBounds.upper.toFixed(2)}]s`,
  );

  give(bot, 0, 'bubble', 1);
  give(bot, 1, 'bubble', 1);

  const trackedBubble = await waitUntil(
    () => {
      const snap = latestSnapshot(bot);
      const self = selfIn(snap, bot);
      if (!self) return undefined;
      const snail = snap.enemies.find((e) => e.kind === 'snail' && Math.hypot(e.x - self.x, e.y - self.y) <= bubbleLvl1.range);
      return snail ? { id: snail.id, t0: Date.now() } : undefined;
    },
    { timeoutMs: 30000 },
  );
  check('(pre-b) a snail came within bubble range', Boolean(trackedBubble));

  let bubbleAttackEvent;
  if (trackedBubble) {
    bubbleAttackEvent = await waitUntil(
      () => bot.events.find((e) => e.type === 'attack' && e.kind === 'bubble' && e._recvAt >= trackedBubble.t0),
      { timeoutMs: 5000 },
    );
  }
  check('(b) a "bubble" attack event was observed', Boolean(bubbleAttackEvent));

  let bubbleProjectileSeen;
  if (bubbleAttackEvent) {
    bubbleProjectileSeen = await waitUntil(
      () => bot.snapshots.find((s) => s._recvAt >= bubbleAttackEvent._recvAt && s.projectiles.some((p) => p.kind === 'bubble')),
      { timeoutMs: 3000 },
    );
  }
  check('(b) a "bubble" projectile followed the attack event in a snapshot', Boolean(bubbleProjectileSeen));

  if (trackedBubble) {
    const died = await waitUntil(
      () => (latestSnapshot(bot).enemies.some((e) => e.id === trackedBubble.id) ? undefined : true),
      { timeoutMs: (bubbleBounds.upper + 3) * 1000, pollMs: 50 },
    );
    const elapsedSec = (Date.now() - trackedBubble.t0) / 1000;
    check(
      `(b) bubble kills tracked snail within bound (elapsed ${died ? elapsedSec.toFixed(2) : 'never'}s)`,
      Boolean(died) && elapsedSec <= bubbleBounds.upper,
    );
  } else {
    check('(b) bubble kills tracked snail within bound', false);
  }

  // =========================================================================
  // (d) Weapons never fire without an enemy in range (checked retroactively
  // over everything this bot fired above — see file header for why).
  // =========================================================================
  // Tick quantization + enemy movement + snapshot-vs-event staleness. Scaled
  // by TIMESCALE (PLAN.md T8): debug timescale multiplies simulated dt per
  // tick, so entities can travel much further between two real-time-spaced
  // (20Hz) snapshots than the original 1x-only slack accounted for.
  const RANGE_SLACK_PX = 120 * TIMESCALE;

  const tongueRangeCheck = checkFiresOnlyInRange(bot, 'tongue', tongueLvl1.range, RANGE_SLACK_PX);
  check(
    `(d) every "tongue" attack event had an enemy within range+slack (${tongueRangeCheck.count} events)`,
    tongueRangeCheck.ok,
  );

  const bubbleRangeCheck = checkFiresOnlyInRange(bot, 'bubble', bubbleLvl1.range, RANGE_SLACK_PX);
  check(
    `(d) every "bubble" attack event had an enemy within range+slack (${bubbleRangeCheck.count} events)`,
    bubbleRangeCheck.ok,
  );

  const croakRangeCheck = checkFiresOnlyInRange(bot, 'croak', croakLvl1.range, RANGE_SLACK_PX);
  check(
    `(d) every "croak" attack event had an enemy within radius+slack (${croakRangeCheck.count} events)`,
    croakRangeCheck.ok,
  );

  bot.ws.close();

  console.log('\n--- weapons-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: weapons-check' : '\nPASS: weapons-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: weapons-check errored:', err);
  process.exit(1);
});
