import type { C2SType, SignalingMessage } from './types';

const KNOWN_C2S_TYPES = new Set<string>([
  'join', 'offer', 'answer', 'ice-candidate',
  'control-request', 'control-response', 'control-revoke',
  'swap-offer', 'swap-answer', 'swap-ice', 'swap-stop',
  // File-transfer room types
  'fs-offer', 'fs-answer', 'fs-ice',
  'fs-tree-update', 'fs-state-request', 'fs-state-full',
  'fs-folder-create', 'fs-folder-delete',
  'fs-download-request', 'fs-transfer-progress', 'fs-transfer-done', 'fs-cancel',
]);

export class MessageValidator {
  isKnownType(type: string): type is C2SType {
    return KNOWN_C2S_TYPES.has(type);
  }

  /** Returns an error string or null if valid. */
  validate(msg: SignalingMessage): string | null {
    if (!msg || typeof msg !== 'object') return 'Invalid message';
    if (typeof msg.type !== 'string') return 'Missing type field';

    switch (msg.type as C2SType) {
      case 'join': {
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p) return 'join: missing payload';
        if (typeof p.roomId !== 'string' || !p.roomId.trim()) return 'join: missing roomId';
        if (typeof p.name !== 'string' || !p.name.trim()) return 'join: missing name';
        if (p.role !== 'host' && p.role !== 'viewer') return 'join: invalid role';
        if ((p.roomId as string).length > 32) return 'join: roomId too long';
        if ((p.name as string).length > 64) return 'join: name too long';
        if (p.pin !== undefined && (typeof p.pin !== 'string' || (p.pin as string).length > 32)) return 'join: invalid pin';
        break;
      }
      case 'offer':
      case 'answer': {
        if (!msg.to || typeof msg.to !== 'string') return `${msg.type}: missing 'to'`;
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p?.sdp) return `${msg.type}: missing sdp`;
        if (typeof p.sdp !== 'object') return `${msg.type}: invalid sdp`;
        break;
      }
      case 'ice-candidate': {
        if (!msg.to || typeof msg.to !== 'string') return 'ice-candidate: missing to';
        break;
      }
      case 'control-request':
        break; // no payload required
      case 'control-response': {
        if (!msg.to || typeof msg.to !== 'string') return 'control-response: missing to';
        const p = msg.payload as Record<string, unknown> | undefined;
        if (typeof p?.granted !== 'boolean') return 'control-response: missing granted';
        break;
      }
      case 'control-revoke': {
        if (!msg.to || typeof msg.to !== 'string') return 'control-revoke: missing to';
        break;
      }
      case 'swap-offer':
      case 'swap-answer': {
        if (!msg.to || typeof msg.to !== 'string') return `${msg.type}: missing to`;
        const p = msg.payload as Record<string, unknown> | undefined;
        if (!p?.sdp) return `${msg.type}: missing sdp`;
        break;
      }
      case 'swap-ice': {
        if (!msg.to || typeof msg.to !== 'string') return 'swap-ice: missing to';
        break;
      }
      case 'swap-stop':
        break; // no payload required

      // File-transfer room messages — light validation (room membership enforced in router)
      case 'fs-offer':
      case 'fs-answer':
        if (!msg.to || typeof msg.to !== 'string') return `${msg.type}: missing to`;
        break;
      case 'fs-ice':
        if (!msg.to || typeof msg.to !== 'string') return 'fs-ice: missing to';
        break;
      case 'fs-download-request':
        if (!msg.to || typeof msg.to !== 'string') return 'fs-download-request: missing to';
        break;
      case 'fs-state-request':
        if (!msg.to || typeof msg.to !== 'string') return 'fs-state-request: missing to';
        break;
      case 'fs-state-full':
        if (!msg.to || typeof msg.to !== 'string') return 'fs-state-full: missing to';
        break;
      case 'fs-cancel':
        // can be directed or broadcast
        break;
      case 'fs-tree-update':
      case 'fs-folder-create':
      case 'fs-folder-delete':
      case 'fs-transfer-progress':
      case 'fs-transfer-done':
        // broadcast, no to required
        break;
    }

    // Cross-room injection guard: if 'to' is present, it must be a non-empty string
    if (msg.to !== undefined && (typeof msg.to !== 'string' || !msg.to.trim())) {
      return 'Invalid to field';
    }

    return null;
  }
}
