/**
 * ScreenMirror Desktop Agent
 *
 * Listens on ws://localhost:9001 (127.0.0.1 only — localhost connections only)
 * Security model:
 *   1. First message must be { type: 'auth', secret } matching AGENT_SECRET
 *   2. Control inputs require { token } matching the active control token
 *   3. Host sends { type: 'arm', token } to activate, { type: 'disarm' } to deactivate
 *   4. Input events are rate-limited to MAX_INPUT_RATE per second
 *   5. Emergency stop always works regardless of token state
 *
 * Run: npm run dev
 * Set AGENT_SECRET env var to override the default shared secret.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { InputSimulator } from './InputSimulator';
import { LocalFileServer } from './LocalFileServer';

const PORT = 9001;
const FILE_SERVER_PORT = parseInt(process.env.FILE_SERVER_PORT ?? '9002', 10);

// Shared secret between agent and HOST browser page.
// Override via AGENT_SECRET env var in production.
const AGENT_SECRET = process.env.AGENT_SECRET ?? 'screenmirror';

// Input rate limiting: max events per second per session
const MAX_INPUT_RATE = 300;
const INPUT_WINDOW_MS = 1000;

const simulator = new InputSimulator();
const fileServer = new LocalFileServer(FILE_SERVER_PORT);

console.log(`[Agent] Screen size: ${JSON.stringify(simulator.getScreenSize())}`);
console.log(`[Agent] Starting WebSocket server on ws://localhost:${PORT}`);
console.log(`[Agent] Using ${process.env.AGENT_SECRET ? 'custom' : 'default'} agent secret`);

// Start HTTP file server (LAN accessible)
fileServer.start().catch((e: Error) => {
  console.error(`[Agent] File server failed to start: ${e.message}`);
});

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

interface SessionState {
  authenticated: boolean;
  activeToken: string | null;
  inputCount: number;
  inputWindowReset: number;
}

function createSession(): SessionState {
  return {
    authenticated: false,
    activeToken: null,
    inputCount: 0,
    inputWindowReset: Date.now() + INPUT_WINDOW_MS,
  };
}

function isRateLimited(session: SessionState): boolean {
  const now = Date.now();
  if (now >= session.inputWindowReset) {
    session.inputCount = 0;
    session.inputWindowReset = now + INPUT_WINDOW_MS;
  }
  session.inputCount++;
  return session.inputCount > MAX_INPUT_RATE;
}

// Validate normalized coordinates are in [0, 1]
function isValidCoord(x: unknown, y: unknown): boolean {
  return typeof x === 'number' && typeof y === 'number'
    && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

// Validate mouse button index (0=left, 1=middle, 2=right)
function isValidButton(b: unknown): boolean {
  return b === 0 || b === 1 || b === 2;
}

wss.on('connection', (ws: WebSocket) => {
  const session = createSession();
  console.log('[Agent] Browser connected — awaiting auth');

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      ws.close(1003, 'Invalid message format');
      return;
    }

    // Auth handshake — must be first message
    if (!session.authenticated) {
      if (msg.type !== 'auth' || msg.secret !== AGENT_SECRET) {
        console.warn('[Agent] Auth failed — closing connection');
        ws.close(4001, 'Authentication failed');
        return;
      }
      session.authenticated = true;
      ws.send(JSON.stringify({
        type: 'auth-ok',
        screenSize: simulator.getScreenSize(),
        localIPs: fileServer.getLocalIPs(),
        fileServerPort: FILE_SERVER_PORT,
      }));
      console.log('[Agent] Browser authenticated');
      return;
    }

    handleMessage(msg, ws, session);
  });

  ws.on('close', () => {
    // Disarm on disconnect — safety guarantee
    session.activeToken = null;
    console.log('[Agent] Browser disconnected — control disarmed');
  });

  ws.on('error', (e) => console.error('[Agent] WS error:', e.message));
});

wss.on('error', (e) => {
  console.error('[Agent] Server error:', e.message);
});

function handleMessage(msg: Record<string, unknown>, ws: WebSocket, session: SessionState) {
  switch (msg.type) {
    // ---- Control session management ----
    case 'arm': {
      if (typeof msg.token !== 'string' || !msg.token) {
        ws.send(JSON.stringify({ type: 'error', message: 'arm: missing token' }));
        return;
      }
      session.activeToken = msg.token as string;
      console.log('[Agent] Control armed');
      ws.send(JSON.stringify({ type: 'armed' }));
      break;
    }

    case 'disarm': {
      session.activeToken = null;
      console.log('[Agent] Control disarmed');
      ws.send(JSON.stringify({ type: 'disarmed' }));
      break;
    }

    case 'emergency-stop': {
      // Always works — no token required
      session.activeToken = null;
      console.log('[Agent] EMERGENCY STOP — all input halted');
      ws.send(JSON.stringify({ type: 'stopped' }));
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }

    // ---- Input events (require valid token + rate limit) ----
    case 'mousemove':
    case 'mousedown':
    case 'mouseup':
    case 'wheel':
    case 'keydown':
    case 'keyup': {
      // Token validation
      if (!session.activeToken || msg.token !== session.activeToken) return;

      // Rate limiting
      if (isRateLimited(session)) return;

      handleInput(msg);
      break;
    }

    default:
      // Silently ignore unknown types
      break;
  }
}

function handleInput(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'mousemove':
      if (!isValidCoord(msg.x, msg.y)) return;
      simulator.mouseMove(msg.x as number, msg.y as number);
      break;

    case 'mousedown':
      if (!isValidCoord(msg.x, msg.y) || !isValidButton(msg.button)) return;
      simulator.mouseDown(msg.x as number, msg.y as number, msg.button as number);
      break;

    case 'mouseup':
      if (!isValidCoord(msg.x, msg.y) || !isValidButton(msg.button)) return;
      simulator.mouseUp(msg.x as number, msg.y as number, msg.button as number);
      break;

    case 'wheel':
      if (!isValidCoord(msg.x, msg.y)) return;
      if (typeof msg.deltaX !== 'number' || typeof msg.deltaY !== 'number') return;
      simulator.scroll(msg.x as number, msg.y as number, msg.deltaX, msg.deltaY);
      break;

    case 'keydown':
      if (typeof msg.key !== 'string' || !msg.key) return;
      if (!Array.isArray(msg.modifiers)) return;
      simulator.keyDown(msg.key, msg.modifiers as string[]);
      break;

    case 'keyup':
      if (typeof msg.key !== 'string' || !msg.key) return;
      if (!Array.isArray(msg.modifiers)) return;
      simulator.keyUp(msg.key, msg.modifiers as string[]);
      break;
  }
}

process.on('SIGINT', () => {
  console.log('[Agent] Shutting down...');
  fileServer.stop();
  wss.close(() => process.exit(0));
});
