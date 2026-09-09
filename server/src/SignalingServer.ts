import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { RoomManager } from './RoomManager';
import { RateLimiter } from './RateLimiter';
import { MessageValidator } from './MessageValidator';
import { ControlTokenManager } from './ControlTokenManager';
import { AuditLogger } from './AuditLogger';
import {
  SignalingMessage, JoinPayload, JoinedPayload,
  RoomStatePayload, UserEventPayload, Room,
  ControlTokenPayload,
} from './types';

const MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MB hard limit

let wsCounter = 0;

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim())
    ?? req.socket.remoteAddress
    ?? 'unknown';
}

function toPublicUsers(room: Room) {
  return Array.from(room.users.values()).map(({ id, name, role }) => ({ id, name, role }));
}

export class SignalingServer {
  private wss: WebSocketServer;
  private rooms: RoomManager;
  private sockets = new Map<string, WebSocket>();
  private clientIps = new Map<string, string>();
  private rateLimiter: RateLimiter;
  private validator: MessageValidator;
  private controlTokens: ControlTokenManager;
  private audit: AuditLogger;
  private allowedOrigins: string[];
  private onRoomClosed?: (roomId: string) => void;

  constructor(wss: WebSocketServer, audit?: AuditLogger, options?: { onRoomClosed?: (roomId: string) => void }) {
    this.wss = wss;
    this.rooms = new RoomManager();
    this.rateLimiter = new RateLimiter();
    this.validator = new MessageValidator();
    this.controlTokens = new ControlTokenManager();
    this.audit = audit ?? new AuditLogger();
    this.allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
    this.onRoomClosed = options?.onRoomClosed;
    this.init();
    setInterval(() => this.rateLimiter.cleanup(), 60_000);
  }

  private init() {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const wsId = `ws_${++wsCounter}`;
      const clientIp = getClientIp(req);

      // Origin validation (production only — dev allows all)
      if (process.env.NODE_ENV === 'production' && this.allowedOrigins.length > 0) {
        const origin = req.headers.origin ?? '';
        if (!this.allowedOrigins.includes(origin)) {
          this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: `Bad origin: ${origin}` });
          ws.close(1008, 'Unauthorized origin');
          return;
        }
      }

      // Connection rate limit: 30 new WS connections per minute per IP
      if (!this.rateLimiter.check(`conn:${clientIp}`, 30, 60_000)) {
        this.audit.log({ type: 'RATE_LIMIT_TRIGGERED', ip: clientIp, detail: 'connection_flood' });
        ws.close(1008, 'Rate limit exceeded');
        return;
      }

      this.sockets.set(wsId, ws);
      this.clientIps.set(wsId, clientIp);

      ws.on('message', (raw: Buffer | string) => {
        // Message size limit
        const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw as string, 'utf8');
        if (size > MAX_MESSAGE_BYTES) {
          this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: 'Oversized message' });
          this.send(ws, { type: 'error', payload: { message: 'Message too large' } });
          return;
        }

        // Per-connection message rate limit: 200 messages per minute
        if (!this.rateLimiter.check(`msg:${wsId}`, 200, 60_000)) {
          this.audit.log({ type: 'RATE_LIMIT_TRIGGERED', ip: clientIp, detail: 'message_flood' });
          this.send(ws, { type: 'error', payload: { message: 'Rate limit exceeded' } });
          return;
        }

        let msg: SignalingMessage;
        try {
          msg = JSON.parse(raw.toString()) as SignalingMessage;
        } catch {
          this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: 'Invalid JSON' });
          this.send(ws, { type: 'error', payload: { message: 'Invalid message format' } });
          return;
        }

        // Unknown message type rejection
        if (!this.validator.isKnownType(msg.type as string)) {
          this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: `Unknown type: ${msg.type}` });
          this.send(ws, { type: 'error', payload: { message: 'Unknown message type' } });
          return;
        }

        // Schema / payload validation
        const schemaError = this.validator.validate(msg);
        if (schemaError) {
          this.send(ws, { type: 'error', payload: { message: schemaError } });
          return;
        }

        this.handleMessage(wsId, ws, msg, clientIp);
      });

      ws.on('close', () => {
        this.handleDisconnect(wsId, clientIp);
        this.sockets.delete(wsId);
        this.clientIps.delete(wsId);
      });

      ws.on('error', (err) => {
        console.error(`[WS ${wsId}] error:`, err.message);
      });
    });
  }

  private handleMessage(wsId: string, ws: WebSocket, msg: SignalingMessage, clientIp: string) {
    switch (msg.type) {
      case 'join':
        this.handleJoin(wsId, ws, msg.payload as JoinPayload, clientIp);
        break;

      // HOST-only messages
      case 'offer':
        if (!this.requireRole(wsId, ws, 'host', clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;
      case 'control-response':
        this.handleControlResponse(wsId, ws, msg, clientIp);
        break;
      case 'control-revoke':
        this.handleControlRevoke(wsId, ws, msg, clientIp);
        break;
      case 'swap-answer':
        if (!this.requireRole(wsId, ws, 'host', clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;

      // VIEWER-only messages
      case 'answer':
        if (!this.requireRole(wsId, ws, 'viewer', clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;
      case 'control-request':
        this.handleControlRequest(wsId, ws, clientIp);
        break;
      case 'swap-offer':
        if (!this.requireRole(wsId, ws, 'viewer', clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;
      case 'swap-stop':
        if (!this.requireRole(wsId, ws, 'viewer', clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;

      // Either role (ICE candidates, swap ICE)
      case 'ice-candidate':
      case 'swap-ice':
        if (!this.requireRoomMember(wsId, ws, clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;

      // File-transfer room messages: any room member, no role restriction
      case 'fs-offer':
      case 'fs-answer':
      case 'fs-ice':
      case 'fs-tree-update':
      case 'fs-state-request':
      case 'fs-state-full':
      case 'fs-folder-create':
      case 'fs-folder-delete':
      case 'fs-download-request':
      case 'fs-transfer-progress':
      case 'fs-transfer-done':
      case 'fs-cancel':
        if (!this.requireRoomMember(wsId, ws, clientIp, msg.type)) return;
        this.routeMessage(wsId, msg);
        break;
    }
  }

  private requireRole(
    wsId: string, ws: WebSocket,
    required: 'host' | 'viewer',
    clientIp: string, action: string,
  ): boolean {
    const entry = this.rooms.getUserByWsId(wsId);
    if (!entry) {
      this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: `${action}: not in a room` });
      this.send(ws, { type: 'error', payload: { message: 'Not in a room' } });
      return false;
    }
    const room = this.rooms.getRoom(entry.roomId);
    const user = room?.users.get(entry.userId);
    if (!user || user.role !== required) {
      this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, userId: entry.userId, detail: `${action}: role violation (need ${required}, got ${user?.role})` });
      this.send(ws, { type: 'error', payload: { message: 'Unauthorized' } });
      return false;
    }
    return true;
  }

  private requireRoomMember(wsId: string, ws: WebSocket, clientIp: string, action: string): boolean {
    const entry = this.rooms.getUserByWsId(wsId);
    if (!entry) {
      this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: `${action}: not in a room` });
      this.send(ws, { type: 'error', payload: { message: 'Not in a room' } });
      return false;
    }
    return true;
  }

  private handleJoin(wsId: string, ws: WebSocket, payload: JoinPayload, clientIp: string) {
    // Rate limit join attempts: 10 per minute per IP
    if (!this.rateLimiter.check(`join:${clientIp}`, 10, 60_000)) {
      this.audit.log({ type: 'RATE_LIMIT_TRIGGERED', ip: clientIp, detail: 'join_flood' });
      this.send(ws, { type: 'error', payload: { message: 'Too many join attempts. Try again later.' } });
      return;
    }

    this.audit.log({ type: 'ROOM_JOIN_ATTEMPT', ip: clientIp, roomId: payload.roomId, detail: `role=${payload.role}` });

    const result = this.rooms.joinRoom(payload.roomId, payload.name, payload.role, wsId, payload.pin);

    if ('error' in result) {
      this.audit.log({ type: 'ROOM_JOIN_FAILED', ip: clientIp, roomId: payload.roomId, detail: result.error });
      this.send(ws, { type: 'error', payload: { message: result.error } });
      return;
    }

    const { userId, room } = result;

    if (payload.role === 'host') {
      this.audit.log({ type: 'ROOM_CREATED', ip: clientIp, roomId: room.id, userId });
    } else {
      this.audit.log({ type: 'USER_APPROVED', ip: clientIp, roomId: room.id, userId });
    }
    this.audit.log({ type: 'SESSION_STARTED', ip: clientIp, roomId: room.id, userId });

    const joinedPayload: JoinedPayload = { userId, roomId: room.id, role: payload.role };
    this.send(ws, { type: 'joined', payload: joinedPayload });

    const statePayload: RoomStatePayload = {
      roomId: room.id,
      users: toPublicUsers(room),
      hostId: room.hostId,
    };
    this.send(ws, { type: 'room-state', payload: statePayload });

    const joiningUser = room.users.get(userId)!;
    const userEventPayload: UserEventPayload = {
      user: { id: userId, name: joiningUser.name, role: joiningUser.role },
    };
    this.broadcastToRoom(room.id, { type: 'user-joined', payload: userEventPayload }, wsId);

    console.log(`[Room ${room.id}] ${payload.name} joined as ${payload.role} (${userId})`);
  }

  private handleControlRequest(wsId: string, ws: WebSocket, clientIp: string) {
    if (!this.requireRole(wsId, ws, 'viewer', clientIp, 'control-request')) return;

    const entry = this.rooms.getUserByWsId(wsId)!;

    // Rate limit: 3 control requests per viewer per minute
    if (!this.rateLimiter.check(`ctrl-req:${entry.userId}`, 3, 60_000)) {
      this.audit.log({ type: 'RATE_LIMIT_TRIGGERED', ip: clientIp, userId: entry.userId, detail: 'control_request_flood' });
      this.send(ws, { type: 'error', payload: { message: 'Too many control requests.' } });
      return;
    }

    this.audit.log({ type: 'CONTROL_REQUESTED', roomId: entry.roomId, userId: entry.userId, ip: clientIp });
    this.routeMessage(wsId, { type: 'control-request' });
  }

  private handleControlResponse(wsId: string, ws: WebSocket, msg: SignalingMessage, clientIp: string) {
    if (!this.requireRole(wsId, ws, 'host', clientIp, 'control-response')) return;

    const entry = this.rooms.getUserByWsId(wsId)!;
    const room = this.rooms.getRoom(entry.roomId)!;
    const payload = msg.payload as { granted: boolean };
    const targetId = msg.to!;

    // Validate target is a viewer in the same room
    const target = room.users.get(targetId);
    if (!target || target.role !== 'viewer') {
      this.audit.log({ type: 'SECURITY_VIOLATION', ip: clientIp, detail: `control-response to non-viewer: ${targetId}` });
      this.send(ws, { type: 'error', payload: { message: 'Invalid control target' } });
      return;
    }

    if (payload.granted) {
      // Server issues the control token and tracks state
      const token = this.controlTokens.issue(targetId, entry.roomId);
      this.rooms.grantControl(entry.roomId, targetId);

      // Send token to HOST so it can arm the Desktop Agent
      const tokenPayload: ControlTokenPayload = { token, viewerId: targetId };
      this.send(ws, { type: 'control-token', payload: tokenPayload });

      this.audit.log({ type: 'CONTROL_GRANTED', roomId: entry.roomId, userId: targetId, ip: clientIp });
    } else {
      this.audit.log({ type: 'USER_REJECTED', roomId: entry.roomId, userId: targetId, ip: clientIp });
    }

    // Route the original response to the viewer
    this.routeMessage(wsId, msg);
  }

  private handleControlRevoke(wsId: string, ws: WebSocket, msg: SignalingMessage, clientIp: string) {
    if (!this.requireRole(wsId, ws, 'host', clientIp, 'control-revoke')) return;

    const entry = this.rooms.getUserByWsId(wsId)!;
    const targetId = msg.to!;

    this.controlTokens.revokeByViewer(targetId, entry.roomId);
    this.rooms.revokeControl(entry.roomId, targetId);

    this.audit.log({ type: 'CONTROL_REVOKED', roomId: entry.roomId, userId: targetId, ip: clientIp });

    // Route revoke to viewer
    this.routeMessage(wsId, msg);
  }

  /**
   * Routes a directed or broadcast message, with cross-room injection prevention.
   * The 'to' field is validated to be a user in the sender's room.
   */
  private routeMessage(wsId: string, msg: SignalingMessage) {
    const entry = this.rooms.getUserByWsId(wsId);
    if (!entry) return;

    const room = this.rooms.getRoom(entry.roomId);
    if (!room) return;

    const outMsg: SignalingMessage = { ...msg, from: entry.userId };

    if (msg.to) {
      // Cross-room injection prevention: target must be in the same room
      const target = room.users.get(msg.to);
      if (!target) return; // silent drop — unknown target in this room
      const targetWs = this.sockets.get(target.wsId);
      if (targetWs) this.send(targetWs, outMsg);
    } else {
      this.broadcastToRoom(entry.roomId, outMsg, wsId);
    }
  }

  private handleDisconnect(wsId: string, clientIp: string) {
    const result = this.rooms.leaveByWsId(wsId);
    if (!result) return;

    const { userId, roomId, room } = result;

    // Revoke any active control tokens for this user
    this.controlTokens.revokeByViewer(userId, roomId);

    // If room is now empty, clean up all its tokens and notify listeners
    if (room.users.size === 0) {
      this.controlTokens.revokeByRoom(roomId);
      this.onRoomClosed?.(roomId);
    }

    this.audit.log({ type: 'SESSION_ENDED', roomId, userId, ip: clientIp });
    console.log(`[Room ${roomId}] user ${userId} disconnected`);

    // Notify remaining room members
    this.broadcastToRoom(roomId, { type: 'user-left', payload: { userId } });
  }

  private broadcastToRoom(roomId: string, msg: SignalingMessage, excludeWsId?: string) {
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    for (const user of room.users.values()) {
      if (user.wsId === excludeWsId) continue;
      const ws = this.sockets.get(user.wsId);
      if (ws) this.send(ws, msg);
    }
  }

  private send(ws: WebSocket, msg: SignalingMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
