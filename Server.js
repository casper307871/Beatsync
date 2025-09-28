import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Simple signaling:
 *  - One "dj" (broadcaster) per room (default room "main")
 *  - Viewers join and get paired with the DJ through the server
 *  - We relay SDP offers/answers + ICE candidates
 */

const rooms = new Map(); // roomId -> { dj: ws | null, viewers: Map<viewerId, ws> }
function getRoom(roomId = "main") {
  if (!rooms.has(roomId)) rooms.set(roomId, { dj: null, viewers: new Map() });
  return rooms.get(roomId);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  let role = null;       // "dj" or "viewer"
  let roomId = "main";
  let viewerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join" && msg.role) {
      role = msg.role;
      roomId = msg.roomId || "main";
      const room = getRoom(roomId);

      if (role === "dj") {
        room.dj = ws;
        // Notify existing viewers that DJ is online (optional)
        for (const [, vws] of room.viewers) send(vws, { type: "dj-online" });
        return;
      }

      if (role === "viewer") {
        // Assign viewer an id
        viewerId = msg.viewerId || Math.random().toString(36).slice(2);
        room.viewers.set(viewerId, ws);
        // Ask DJ to create an offer for this viewer
        if (room.dj) {
          send(room.dj, { type: "viewer-join", viewerId });
        } else {
          send(ws, { type: "no-dj" });
        }
        return;
      }
    }

    // Relay messages
    const room = getRoom(roomId);
    if (!room) return;

    if (msg.type === "offer" && role === "dj") {
      // DJ -> Viewer
      const vws = room.viewers.get(msg.viewerId);
      if (vws) send(vws, { type: "offer", sdp: msg.sdp });
      return;
    }

    if (msg.type === "answer" && role === "viewer") {
      // Viewer -> DJ
      if (room.dj) send(room.dj, { type: "answer", viewerId, sdp: msg.sdp });
      return;
    }

    if (msg.type === "ice-candidate") {
      if (role === "dj") {
        // DJ candidate to specific viewer
        const vws = room.viewers.get(msg.viewerId);
        if (vws) send(vws, { type: "ice-candidate", candidate: msg.candidate });
      } else if (role === "viewer") {
        // Viewer candidate to DJ
        if (room.dj) send(room.dj, { type: "ice-candidate", viewerId, candidate: msg.candidate });
      }
    }
  });

  ws.on("close", () => {
    const room = getRoom(roomId);
    if (!room) return;

    if (role === "dj" && room.dj === ws) {
      room.dj = null;
      // Tell viewers the DJ left (optional)
      for (const [, vws] of room.viewers) send(vws, { type: "dj-offline" });
    }

    if (role === "viewer" && viewerId) {
      room.viewers.delete(viewerId);
      if (room.dj) send(room.dj, { type: "viewer-left", viewerId });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
});
