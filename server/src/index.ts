import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { SignalingServer } from './SignalingServer';
import { QuickSupportManager } from './QuickSupportManager';
import { AuditLogger } from './AuditLogger';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const app = express();

// Request body size limit (protect API endpoints)
app.use(express.json({ limit: '16kb' }));

const audit = new AuditLogger({ logToFile: process.env.AUDIT_LOG === 'true' });
const quickSupport = new QuickSupportManager();

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(CLIENT_DIST));
}

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Quick Support: host generates a code
app.post('/api/quick/generate', (req, res) => {
  const { roomId, hostId } = req.body as { roomId?: string; hostId?: string };
  if (!roomId || !hostId) {
    res.status(400).json({ error: 'roomId and hostId required' });
    return;
  }
  if (typeof roomId !== 'string' || roomId.length > 32) {
    res.status(400).json({ error: 'Invalid roomId' });
    return;
  }
  if (typeof hostId !== 'string' || hostId.length > 64) {
    res.status(400).json({ error: 'Invalid hostId' });
    return;
  }
  const entry = quickSupport.generate(roomId, hostId);
  audit.log({ type: 'PERMISSION_CHANGED', roomId, userId: hostId, detail: 'quick-code-generated' });
  res.json({ code: entry.code, expiresIn: 10 * 60 * 1000 });
});

// Quick Support: technician redeems a code
app.post('/api/quick/redeem', (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code required' });
    return;
  }
  if (code.length > 16) {
    res.status(400).json({ error: 'Invalid code' });
    return;
  }
  const result = quickSupport.redeem(code);
  if (!result) {
    res.status(404).json({ error: 'Invalid or expired code' });
    return;
  }
  res.json({ roomId: result.roomId });
});

if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

new SignalingServer(wss, audit, {
  // Invalidate all Quick Support codes when a room closes
  onRoomClosed: (roomId) => quickSupport.invalidateRoom(roomId),
});

server.listen(PORT, () => {
  console.log(`Signaling server  ws://localhost:${PORT}/ws`);
  console.log(`Health check      http://localhost:${PORT}/health`);
  console.log(`Quick Support     POST http://localhost:${PORT}/api/quick/generate`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`Allowed origins   ${process.env.ALLOWED_ORIGINS ?? '(none set)'}`);
  }
});
