// P6 balance probe (DESIGN-PHASE2.md §7) — not a pass/fail check. Prints
// observed balance numbers for the human tuning pass:
//   A) boss kill-time, 1 player with a strong endgame loadout (croak III x2)
//   B) boss kill-time, 4 players all with croak III x2 (HP scales by playerFactor)
//   C) per-class survival time standing still from wave 1 (crude pressure metric)
// Spawns its own server per scenario on FROGTATO_PORT (default 8130).
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = process.env.FROGTATO_PORT ?? "8130";
const TIMESCALE = 10;

const allServers = [];

function startServer() {
  const child = spawn("./node_modules/.bin/tsx", ["server/src/index.ts"], {
    env: { ...process.env, PORT },
    stdio: "ignore",
  });
  allServers.push(child);
  return child;
}

/** Hard per-scenario kill switch so one wedged scenario can't hang the probe. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const msgs = [];
    const waiters = [];
    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      msgs.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { waiters.splice(i, 1)[0].resolve(m); }
      }
    });
    ws.on("open", () => resolve({ ws, msgs, waiters }));
    ws.on("error", reject);
  });
}

function waitFor(c, pred, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const found = c.msgs.find(pred);
    if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error("timeout waiting")), timeoutMs);
    c.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

const isEvent = (type) => (m) => m.type === "event" && m.event.type === type;
const send = (c, msg) => c.ws.send(JSON.stringify(msg));

async function bossScenario(playerCount) {
  const server = startServer();
  await new Promise((r) => setTimeout(r, 2500));
  const clients = [];
  for (let i = 0; i < playerCount; i++) {
    const c = await connect();
    send(c, { type: "hello" });
    await waitFor(c, (m) => m.type === "welcome");
    clients.push(c);
  }
  const lead = clients[0];
  for (const c of clients) {
    send(c, { type: "debug", invincible: true, give: { slot: 0, weapon: "croak", level: 3 } });
    send(c, { type: "debug", give: { slot: 1, weapon: "croak", level: 3 } });
  }
  send(lead, { type: "debug", timescale: TIMESCALE });
  send(lead, { type: "start" });
  // auto-ready through shops
  for (const c of clients) {
    (async () => {
      for (;;) {
        await waitFor(c, (m) => m.type === "snapshot" && m.phase === "shop", 600000).catch(() => {});
        send(c, { type: "ready" });
        await new Promise((r) => setTimeout(r, 300));
      }
    })().catch(() => {});
  }
  const spawnedAt = await waitFor(lead, isEvent("bossSpawned"), 600000).then(() => Date.now());
  const outcome = await Promise.race([
    waitFor(lead, isEvent("bossDied"), 600000).then(() => "killed"),
    waitFor(lead, isEvent("victory"), 600000).then(() => "hardcap"),
  ]);
  const simSeconds = ((Date.now() - spawnedAt) / 1000) * TIMESCALE;
  for (const c of clients) c.ws.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  return { outcome, simSeconds: simSeconds.toFixed(1) };
}

async function classSurvival(classId) {
  const server = startServer();
  await new Promise((r) => setTimeout(r, 2500));
  const c = await connect();
  send(c, { type: "hello" });
  await waitFor(c, (m) => m.type === "welcome");
  send(c, { type: "pickClass", class: classId });
  await new Promise((r) => setTimeout(r, 300));
  send(c, { type: "debug", timescale: TIMESCALE });
  send(c, { type: "start" });
  const wave1At = await waitFor(c, isEvent("waveStart"), 120000).then(() => Date.now());
  let waveReached = 1;
  (async () => {
    for (;;) {
      const m = await waitFor(c, isEvent("waveStart"), 600000);
      waveReached = m.event.wave;
    }
  })().catch(() => {});
  // auto-ready through shops so the run keeps going
  (async () => {
    for (;;) {
      await waitFor(c, (m) => m.type === "snapshot" && m.phase === "shop", 600000).catch(() => {});
      send(c, { type: "ready" });
      await new Promise((r) => setTimeout(r, 300));
    }
  })().catch(() => {});
  const downedAt = await Promise.race([
    waitFor(c, isEvent("playerDowned"), 600000).then(() => Date.now()),
    waitFor(c, isEvent("victory"), 600000).then(() => null),
  ]);
  const result = downedAt === null
    ? { survived: "full run (victory standing still?!)", waveReached }
    : { survivedSimSec: (((downedAt - wave1At) / 1000) * TIMESCALE).toFixed(1), waveReached };
  c.ws.close();
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  return result;
}

console.log(`balance probe (timescale x${TIMESCALE}, port ${PORT})`);
try {
  console.log("A) boss kill-time, 1 player, croak III x2:", await withTimeout(bossScenario(1), 300000, "A"));
  console.log("B) boss kill-time, 4 players, croak III x2 each:", await withTimeout(bossScenario(4), 300000, "B"));
  for (const cls of ["bullfrog", "treefrog", "dartfrog"]) {
    console.log(`C) ${cls} standing-still survival:`, await withTimeout(classSurvival(cls), 180000, `C:${cls}`));
  }
} catch (err) {
  console.error("probe aborted:", err.message);
}
for (const s of allServers) s.kill();
process.exit(0);
