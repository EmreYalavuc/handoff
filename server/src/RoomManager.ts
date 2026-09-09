import { randomBytes } from 'crypto';
import { Room, RoomUser, UserRole } from './types';

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () =>
    Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

function generateUserId(): string {
  return randomBytes(8).toString('hex');
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private wsToUser = new Map<string, { userId: string; roomId: string }>();

  createRoom(): string {
    let id: string;
    do { id = generateRoomId(); } while (this.rooms.has(id));
    this.rooms.set(id, {
      id, users: new Map(), hostId: null,
      createdAt: Date.now(), controlGrantedViewers: new Set(),
    });
    return id;
  }

  joinRoom(
    roomId: string,
    name: string,
    role: UserRole,
    wsId: string,
    pin?: string,
  ): { userId: string; room: Room } | { error: string } {
    let room = this.rooms.get(roomId);

    if (role === 'host') {
      if (!room) {
        this.rooms.set(roomId, {
          id: roomId, users: new Map(), hostId: null,
          createdAt: Date.now(), controlGrantedViewers: new Set(),
          pin,
        });
        room = this.rooms.get(roomId)!;
      } else if (room.hostId !== null) {
        return { error: 'Room already has a host' };
      }
    } else {
      if (!room) return { error: 'Room not found' };
      // PIN enforcement for viewers
      if (room.pin) {
        if (!pin) return { error: 'PIN required' };
        if (pin !== room.pin) return { error: 'Invalid PIN' };
      }
    }

    const userId = generateUserId();
    const user: RoomUser = { id: userId, name, role, wsId };
    room.users.set(userId, user);
    if (role === 'host') room.hostId = userId;

    this.wsToUser.set(wsId, { userId, roomId });
    return { userId, room };
  }

  leaveByWsId(wsId: string): { userId: string; roomId: string; room: Room; wasHost: boolean } | null {
    const entry = this.wsToUser.get(wsId);
    if (!entry) return null;

    const { userId, roomId } = entry;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const wasHost = room.hostId === userId;
    room.users.delete(userId);
    room.controlGrantedViewers.delete(userId);
    this.wsToUser.delete(wsId);

    if (wasHost) {
      room.hostId = null;
      // Revoke all control grants when host leaves
      room.controlGrantedViewers.clear();
    }

    if (room.users.size === 0) {
      this.rooms.delete(roomId);
    }

    return { userId, roomId, room, wasHost };
  }

  grantControl(roomId: string, viewerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.controlGrantedViewers.add(viewerId);
    return true;
  }

  revokeControl(roomId: string, viewerId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.controlGrantedViewers.delete(viewerId);
  }

  hasControlGrant(roomId: string, viewerId: string): boolean {
    return this.rooms.get(roomId)?.controlGrantedViewers.has(viewerId) ?? false;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getUserByWsId(wsId: string): { userId: string; roomId: string } | undefined {
    return this.wsToUser.get(wsId);
  }

  getRoomByWsId(wsId: string): Room | undefined {
    const entry = this.wsToUser.get(wsId);
    if (!entry) return undefined;
    return this.rooms.get(entry.roomId);
  }
}
