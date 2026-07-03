#!/usr/bin/env node
// Headless verification for T3 (server core). Plain Node ESM, no TS build step.
//
// Connects two ws clients, sends `hello`, then drives opposing inputs (one holds
// left, one holds right) for ~2s, and asserts:
//   (a) both receive `welcome` with distinct playerIds/colors
//   (b) snapshots arrive at ~20/s (accept 15-25)
//   (c) the two players' x positions diverge over time
//   (d) a third socket sending garbage bytes and an unknown-type JSON message
//       doesn't kill the server (snapshots keep flowing after)

import WebSocket from 'ws';

// FROGTATO_PORT override (PLAN.md T8): lets this check target a secondary
// server instance (e.g. 8081) instead of the default 8080, so it never
// collides with a live playtesting dev server.
const PORT = process.env.FROGTATO_PORT ?? '8080';
const URL = `ws://localhost:${PORT}`;
const DRIVE_DURATION_MS = 2000;

const results = [];
let failed = false;

function check(name, ok) {
  results.push({ name, ok: Boolean(ok) });
  if (!ok) failed = true;
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const wsA = await connect();
  const wsB = await connect();

  const snapshotsA = [];
  wsA.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'snapshot') snapshotsA.push(msg);
  });

  // Pre-existing race fixed while verifying T6 (weapons) didn't regress this
  // check: attach both "wait for welcome" listeners synchronously *before*
  // sending either `hello`, not sequentially (await A's welcome, then start
  // listening for B's). Sequentially awaiting left a real gap in which B's
  // `hello` -> `welcome` round trip (fast on localhost) could complete and
  // fire its 'message' event with zero listeners attached, silently dropping
  // it forever (ws's EventEmitter doesn't buffer/replay for late
  // subscribers) — reproduced reliably against a pristine server with no
  // weapons/combat activity at all, so this was unrelated to T6's changes.
  const welcomeAPromise = waitForMessage(wsA, (m) => m.type === 'welcome');
  const welcomeBPromise = waitForMessage(wsB, (m) => m.type === 'welcome');

  wsA.send(JSON.stringify({ type: 'hello' }));
  wsB.send(JSON.stringify({ type: 'hello' }));

  const welcomeA = await welcomeAPromise;
  const welcomeB = await welcomeBPromise;

  check('welcome A has a playerId', typeof welcomeA.playerId === 'string' && welcomeA.playerId.length > 0);
  check('welcome B has a playerId', typeof welcomeB.playerId === 'string' && welcomeB.playerId.length > 0);
  check('distinct playerIds', welcomeA.playerId !== welcomeB.playerId);

  // welcome carries no color; find both players in a snapshot to compare colors.
  const firstSnap = await waitForMessage(
    wsA,
    (m) =>
      m.type === 'snapshot' &&
      m.players.some((p) => p.id === welcomeA.playerId) &&
      m.players.some((p) => p.id === welcomeB.playerId),
  );
  const pA0 = firstSnap.players.find((p) => p.id === welcomeA.playerId);
  const pB0 = firstSnap.players.find((p) => p.id === welcomeB.playerId);
  check('distinct colors', pA0.color !== pB0.color);

  const startXA = pA0.x;
  const startXB = pB0.x;
  const startGap = Math.abs(startXA - startXB);

  // Drive opposing inputs at ~30/s: A holds left, B holds right.
  let seqA = 0;
  let seqB = 0;
  const inputTimerA = setInterval(() => {
    seqA += 1;
    wsA.send(JSON.stringify({ type: 'input', seq: seqA, up: false, down: false, left: true, right: false }));
  }, 1000 / 30);
  const inputTimerB = setInterval(() => {
    seqB += 1;
    wsB.send(JSON.stringify({ type: 'input', seq: seqB, up: false, down: false, left: false, right: true }));
  }, 1000 / 30);

  // Third socket: garbage bytes + an unknown-type JSON message. Server must survive.
  const wsC = await connect();
  wsC.send('this is not json {{{');
  wsC.send(JSON.stringify({ type: 'totallyBogusMessageType', foo: 'bar' }));

  await sleep(DRIVE_DURATION_MS);

  clearInterval(inputTimerA);
  clearInterval(inputTimerB);

  const rateHz = snapshotsA.length / (DRIVE_DURATION_MS / 1000);
  check(`snapshot rate ~20/s, accept 15-25 (got ${rateHz.toFixed(1)}/s)`, rateHz >= 15 && rateHz <= 25);

  check('received at least one snapshot', snapshotsA.length > 0);
  const lastSnap = snapshotsA[snapshotsA.length - 1];
  const pAEnd = lastSnap.players.find((p) => p.id === welcomeA.playerId);
  const pBEnd = lastSnap.players.find((p) => p.id === welcomeB.playerId);

  check('player A (holding left) moved left', pAEnd.x < startXA);
  check('player B (holding right) moved right', pBEnd.x > startXB);
  const endGap = Math.abs(pAEnd.x - pBEnd.x);
  check(`positions diverged (start gap ${startGap.toFixed(1)}px -> end gap ${endGap.toFixed(1)}px)`, endGap > startGap);

  // Confirm the server is still alive and broadcasting after the garbage messages.
  const countAfterGarbage = snapshotsA.length;
  await sleep(500);
  check('snapshots keep flowing after garbage/unknown messages', snapshotsA.length > countAfterGarbage);

  wsA.close();
  wsB.close();
  wsC.close();

  // --- T11: reconnect within grace window ----------------------------------
  // Bot connects, gets a token, moves, is granted flies via the existing
  // debug `grantFlies` message (see server/src/room.ts handleDebugMsg — no
  // new debug op needed, this one already existed for T5/T6 checks),
  // disconnects, then reconnects a brand-new ws with the same token and
  // asserts it resumes the same playerId with flies preserved.
  const knownPlayerIds = [welcomeA.playerId, welcomeB.playerId];
  let reconnectPlayerId;
  {
    const ws1 = await connect();
    const welcome1Promise = waitForMessage(ws1, (m) => m.type === 'welcome');
    ws1.send(JSON.stringify({ type: 'hello' }));
    const welcome1 = await welcome1Promise;
    reconnectPlayerId = welcome1.playerId;
    knownPlayerIds.push(welcome1.playerId);

    // Move for a bit (just to exercise input handling; position isn't asserted).
    let seq = 0;
    const moveTimer = setInterval(() => {
      seq += 1;
      ws1.send(JSON.stringify({ type: 'input', seq, up: false, down: false, left: true, right: false }));
    }, 1000 / 30);
    await sleep(300);
    clearInterval(moveTimer);

    ws1.send(JSON.stringify({ type: 'debug', grantFlies: 7 }));
    const grantedSnap = await waitForMessage(
      ws1,
      (m) => m.type === 'snapshot' && m.players.find((p) => p.id === reconnectPlayerId)?.flies === 7,
    );
    const beforeDisconnect = grantedSnap.players.find((p) => p.id === reconnectPlayerId);
    check('(reconnect) flies granted before disconnect', beforeDisconnect.flies === 7);

    ws1.close();
    await sleep(300); // let the server process the close and start the grace timer

    const ws2 = await connect();
    const welcome2Promise = waitForMessage(ws2, (m) => m.type === 'welcome');
    ws2.send(JSON.stringify({ type: 'hello', token: welcome1.token }));
    const welcome2 = await welcome2Promise;

    check('(reconnect) same playerId returned in welcome', welcome2.playerId === reconnectPlayerId);

    const snapAfterReconnect = await waitForMessage(
      ws2,
      (m) => m.type === 'snapshot' && m.players.some((p) => p.id === reconnectPlayerId),
    );
    const pAfter = snapAfterReconnect.players.find((p) => p.id === reconnectPlayerId);
    check(`(reconnect) flies count restored (got ${pAfter?.flies})`, pAfter?.flies === 7);

    ws2.close();
  }

  // --- T11: unknown/bogus token -> fresh join --------------------------------
  {
    const ws = await connect();
    const welcomePromise = waitForMessage(ws, (m) => m.type === 'welcome');
    ws.send(JSON.stringify({ type: 'hello', token: 'totally-bogus-token-that-was-never-issued' }));
    const welcome = await welcomePromise;
    check(
      '(bogus token) gets a fresh playerId, not matching any prior real player',
      typeof welcome.playerId === 'string' && !knownPlayerIds.includes(welcome.playerId),
    );
    ws.close();
  }

  // --- T11: rate-cap probe ---------------------------------------------------
  // One client blasts far above the hard cap (60/s soft, 180/s hard) for long
  // enough to trip the "sustained >3x soft cap for 5s" close, while a second,
  // normal client's snapshot cadence must stay unaffected and the server must
  // keep running for everyone else.
  {
    const flood = await connect();
    const normal = await connect();

    const normalSnaps = [];
    normal.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'snapshot') normalSnaps.push(msg);
    });

    const floodWelcomePromise = waitForMessage(flood, (m) => m.type === 'welcome');
    const normalWelcomePromise = waitForMessage(normal, (m) => m.type === 'welcome');
    flood.send(JSON.stringify({ type: 'hello' }));
    normal.send(JSON.stringify({ type: 'hello' }));
    await floodWelcomePromise;
    await normalWelcomePromise;

    normalSnaps.length = 0; // measure only the flood window below

    let floodSeq = 0;
    const FLOOD_RATE_HZ = 500;
    const FLOOD_DURATION_MS = 6500; // > 5 continuous over-hard-cap 1s windows
    const floodTimer = setInterval(() => {
      floodSeq += 1;
      if (flood.readyState === flood.OPEN) {
        flood.send(JSON.stringify({ type: 'input', seq: floodSeq, up: true, down: false, left: false, right: false }));
      }
    }, 1000 / FLOOD_RATE_HZ);

    const measureStart = Date.now();
    await sleep(FLOOD_DURATION_MS);
    clearInterval(floodTimer);
    const measuredSec = (Date.now() - measureStart) / 1000;

    const normalRateHz = normalSnaps.length / measuredSec;
    check(
      `(rate-cap) second client's snapshot cadence unaffected during flood (~20/s, got ${normalRateHz.toFixed(1)}/s)`,
      normalRateHz >= 15 && normalRateHz <= 25,
    );

    check(
      '(rate-cap) misbehaving client got dropped/throttled (socket closed)',
      flood.readyState === flood.CLOSING || flood.readyState === flood.CLOSED,
    );

    // Server must still be alive and serving everyone else: a fresh connect
    // + hello round trip must still succeed.
    const aliveCheckWs = await connect();
    const aliveWelcomePromise = waitForMessage(aliveCheckWs, (m) => m.type === 'welcome', 3000);
    aliveCheckWs.send(JSON.stringify({ type: 'hello' }));
    const aliveWelcome = await aliveWelcomePromise.catch(() => undefined);
    check('(rate-cap) server survived the flood (new client can still connect)', Boolean(aliveWelcome));

    normal.close();
    if (flood.readyState === flood.OPEN) flood.close();
    aliveCheckWs.close();
  }

  console.log('\n--- skeleton-check results ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  }
  console.log(failed ? '\nFAIL: skeleton-check' : '\nPASS: skeleton-check');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL: skeleton-check errored:', err);
  process.exit(1);
});
