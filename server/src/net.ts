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
}

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
    const conn: Connection = { ws, playerId: undefined };

    ws.on('message', (raw) => {
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
      room.removePlayer(conn.playerId);
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
