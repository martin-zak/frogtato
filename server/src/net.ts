// WebSocket connection lifecycle: accepts sockets, gates on `hello`, creates
// players, routes valid ClientMsgs into the Room, and broadcasts ServerMsgs back
// out. No sim logic lives here — that's room.ts / sim/*.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { SERVER_PORT, makeIdFactory, type ClientMsg, type ServerMsg } from '@frogtato/shared';
import { Room } from './room.js';

const nextPlayerId = makeIdFactory('player');

interface Connection {
  ws: WebSocket;
  playerId: string | undefined;
  /** Rate-cap bookkeeping (T11 hardening): a 1s sliding window of inbound
   * message counts, plus a streak of consecutive over-hard-cap windows. */
  msgWindowStart: number;
  msgCountInWindow: number;
  overageWindows: number;
}

// Per-connection inbound message rate cap (T11 hardening). Soft cap: extra
// messages beyond this in a 1s window are silently dropped (not processed,
// never crash). Hard cap: sustaining more than 3x the soft cap for 5
// continuous seconds closes the socket outright (protects the room's tick
// loop from a single misbehaving/malicious client without taking down
// everyone else).
const RATE_SOFT_CAP_PER_SEC = 60;
const RATE_HARD_CAP_PER_SEC = RATE_SOFT_CAP_PER_SEC * 3;
const RATE_HARD_CAP_SUSTAIN_WINDOWS = 5;
const RATE_WINDOW_MS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Best-effort parse + shape check; never throws. Returns undefined on anything malformed. */
function parseClientMsg(raw: unknown): ClientMsg | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return undefined;
  return parsed as ClientMsg;
}

// Port override for local playtesting: the user may already have a dev server
// bound to the default SERVER_PORT (8080). PORT lets check scripts (and this
// task's own headless spawns) run a second, independent server instance on a
// different port (e.g. 8081) without ever touching 8080.
const PORT = Number(process.env.PORT ?? SERVER_PORT);

export function startServer(): void {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Frogtato server\n');
  });

  const wss = new WebSocketServer({ server: httpServer });
  const socketsByPlayerId = new Map<string, WebSocket>();

  function send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const ws of socketsByPlayerId.values()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  const room = new Room({ broadcast });

  wss.on('connection', (ws) => {
    const conn: Connection = {
      ws,
      playerId: undefined,
      msgWindowStart: Date.now(),
      msgCountInWindow: 0,
      overageWindows: 0,
    };

    /** Returns true if this message should be dropped (soft cap) or the
     * connection has already been closed (hard cap sustained). */
    function rateLimited(): boolean {
      const now = Date.now();
      if (now - conn.msgWindowStart >= RATE_WINDOW_MS) {
        conn.overageWindows = conn.msgCountInWindow > RATE_HARD_CAP_PER_SEC ? conn.overageWindows + 1 : 0;
        conn.msgWindowStart = now;
        conn.msgCountInWindow = 0;
        if (conn.overageWindows >= RATE_HARD_CAP_SUSTAIN_WINDOWS) {
          console.warn('[frogtato] closing socket: sustained inbound message flood');
          ws.close(1008, 'rate limit exceeded');
          return true;
        }
      }
      conn.msgCountInWindow += 1;
      return conn.msgCountInWindow > RATE_SOFT_CAP_PER_SEC;
    }

    ws.on('message', (raw) => {
      if (rateLimited()) return;

      const msg = parseClientMsg(raw);
      if (!msg) {
        console.warn('[frogtato] dropped malformed message (invalid JSON or missing type)');
        return;
      }

      if (!conn.playerId) {
        if (msg.type !== 'hello') {
          console.warn(`[frogtato] first message from a client must be "hello", got "${msg.type}"; closing`);
          ws.close(4000, 'expected hello');
          return;
        }

        // Reconnect path (T11, DESIGN §8): a token matching a disconnected
        // player within its grace window resumes that same playerId with
        // all preserved state, bypassing the isFull()/new-player path
        // entirely (they were never removed from the room's player set).
        if (msg.token) {
          const reconnected = room.reconnectPlayer(msg.token);
          if (reconnected) {
            conn.playerId = reconnected.id;
            socketsByPlayerId.set(reconnected.id, ws);
            send(ws, { type: 'welcome', playerId: reconnected.id, token: reconnected.token, phase: room.phase });
            broadcast({ type: 'event', event: { type: 'playerJoined', playerId: reconnected.id } });
            return;
          }
        }

        if (room.isFull()) {
          console.warn('[frogtato] rejecting hello: room is full');
          ws.close(4001, 'server full');
          return;
        }

        const playerId = nextPlayerId();
        const token = randomUUID();
        room.addPlayer(playerId, token);
        conn.playerId = playerId;
        socketsByPlayerId.set(playerId, ws);

        send(ws, { type: 'welcome', playerId, token, phase: room.phase });
        broadcast({ type: 'event', event: { type: 'playerJoined', playerId } });
        return;
      }

      switch (msg.type) {
        case 'input':
          // Routing-layer defense in depth (T11), alongside whatever the sim
          // layer already does: never apply input from a downed, spectating,
          // or disconnected-slot player.
          if (!room.canAcceptInput(conn.playerId)) break;
          room.handleClientMsg(conn.playerId, msg);
          break;
        case 'start':
        case 'buy':
        case 'ready':
          room.handleClientMsg(conn.playerId, msg);
          break;
        case 'debug':
          // Dev-only escape hatch for headless test scripts (PLAN.md T5/T6/T8/T9).
          // Ignored entirely in production, at the routing layer.
          if (process.env.NODE_ENV === 'production') break;
          room.handleClientMsg(conn.playerId, msg);
          break;
        default:
          console.warn(`[frogtato] dropped unknown message type "${(msg as { type: string }).type}"`);
      }
    });

    ws.on('close', () => {
      if (!conn.playerId) return;
      socketsByPlayerId.delete(conn.playerId);
      // T11 reconnect grace: keep the player's sim state around instead of
      // fully deleting it — see Room.disconnectPlayer.
      room.disconnectPlayer(conn.playerId);
      broadcast({ type: 'event', event: { type: 'playerLeft', playerId: conn.playerId } });
    });

    ws.on('error', (err) => {
      console.warn('[frogtato] socket error:', err.message);
    });
  });

  room.start();

  httpServer.listen(PORT, () => {
    console.log(`[frogtato] server listening on :${PORT}`);
  });
}
