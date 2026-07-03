import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SHARED_PLACEHOLDER } from "@frogtato/shared";

const PORT = 8080;

console.log("[frogtato] shared placeholder:", SHARED_PLACEHOLDER);

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Frogtato server\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  console.log(`[frogtato] client connected from ${req.socket.remoteAddress}`);

  ws.on("close", () => {
    console.log("[frogtato] client disconnected");
  });
});

httpServer.listen(PORT, () => {
  console.log(`[frogtato] server listening on :${PORT}`);
});
