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

const URL = 'ws://localhost:8080';
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

  wsA.send(JSON.stringify({ type: 'hello' }));
  wsB.send(JSON.stringify({ type: 'hello' }));

  const welcomeA = await waitForMessage(wsA, (m) => m.type === 'welcome');
  const welcomeB = await waitForMessage(wsB, (m) => m.type === 'welcome');

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
