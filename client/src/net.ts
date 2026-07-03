// WebSocket wrapper for the Frogtato client.
//
// Owns the connection lifecycle (connect -> hello -> welcome), typed
// send/receive of ClientMsg/ServerMsg, and a short ring buffer of recent
// snapshots (each tagged with the client's local receive timestamp) that
// interp.ts consumes to render entities ~INTERP_DELAY_MS in the past.
//
// No gameplay rules live here: this module only moves bytes and keeps the
// last ~1s of snapshots around.

import { SERVER_PORT } from "@frogtato/shared";
import type { ClientMsg, ServerMsg, GameEvent } from "@frogtato/shared";

export type SnapshotMsg = Extract<ServerMsg, { type: "snapshot" }>;
export type WelcomeMsg = Extract<ServerMsg, { type: "welcome" }>;

/** A snapshot tagged with the local wall-clock time it was received at. */
export interface TimedSnapshot {
  /** `Date.now()` at the moment this snapshot was received by the client. */
  recvAt: number;
  snapshot: SnapshotMsg;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

type Unsubscribe = () => void;
type Listener<T> = (arg: T) => void;

/** How much snapshot history to retain in the ring buffer. */
const SNAPSHOT_BUFFER_MS = 1000;

const TOKEN_STORAGE_KEY = "frogtato:token";

function loadStoredToken(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage unavailable (e.g. private mode) — reconnect grace is best-effort only.
  }
}

export class NetClient {
  private ws: WebSocket | null = null;
  private snapshots: TimedSnapshot[] = [];

  private snapshotListeners = new Set<Listener<SnapshotMsg>>();
  private welcomeListeners = new Set<Listener<WelcomeMsg>>();
  private eventListeners = new Set<Listener<GameEvent>>();
  private statusListeners = new Set<Listener<ConnectionStatus>>();

  status: ConnectionStatus = "connecting";
  playerId: string | null = null;
  token: string | undefined = loadStoredToken();

  /** Opens the websocket. `host` defaults to the page's own hostname. */
  connect(host: string = defaultHost()): void {
    const url = `ws://${host}:${SERVER_PORT}`;
    this.setStatus("connecting");

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.setStatus("open");
      this.send({ type: "hello", token: this.token });
    });

    ws.addEventListener("message", (ev) => {
      this.handleMessage(String(ev.data));
    });

    ws.addEventListener("close", () => {
      this.setStatus("closed");
    });

    ws.addEventListener("error", () => {
      // The subsequent 'close' event carries the actionable state change;
      // nothing extra to do here beyond letting it happen.
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** All snapshots currently retained (oldest first), each with its receive time. */
  getSnapshots(): readonly TimedSnapshot[] {
    return this.snapshots;
  }

  getLatestSnapshot(): TimedSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  onSnapshot(fn: Listener<SnapshotMsg>): Unsubscribe {
    this.snapshotListeners.add(fn);
    return () => this.snapshotListeners.delete(fn);
  }

  onWelcome(fn: Listener<WelcomeMsg>): Unsubscribe {
    this.welcomeListeners.add(fn);
    return () => this.welcomeListeners.delete(fn);
  }

  onEvent(fn: Listener<GameEvent>): Unsubscribe {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onStatus(fn: Listener<ConnectionStatus>): Unsubscribe {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  private handleMessage(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return; // malformed message from the network layer — ignore
    }

    switch (msg.type) {
      case "welcome": {
        this.playerId = msg.playerId;
        this.token = msg.token;
        storeToken(msg.token);
        for (const fn of this.welcomeListeners) fn(msg);
        break;
      }
      case "snapshot": {
        this.pushSnapshot(msg);
        for (const fn of this.snapshotListeners) fn(msg);
        break;
      }
      case "event": {
        for (const fn of this.eventListeners) fn(msg.event);
        break;
      }
    }
  }

  private pushSnapshot(snapshot: SnapshotMsg): void {
    const recvAt = Date.now();
    this.snapshots.push({ recvAt, snapshot });
    const cutoff = recvAt - SNAPSHOT_BUFFER_MS;
    while (this.snapshots.length > 0 && this.snapshots[0].recvAt < cutoff) {
      this.snapshots.shift();
    }
  }
}

function defaultHost(): string {
  return typeof window !== "undefined" && window.location?.hostname
    ? window.location.hostname
    : "localhost";
}
