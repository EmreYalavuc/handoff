export type UserRole = 'host' | 'viewer';

export interface RoomUser {
  id: string;
  name: string;
  role: UserRole;
}

export interface RoomState {
  roomId: string;
  users: RoomUser[];
  hostId: string | null;
}

// Outgoing message types (client -> server)
export type C2SType =
  | 'join'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'control-request'
  | 'control-response'
  | 'control-revoke'
  | 'swap-offer'
  | 'swap-answer'
  | 'swap-ice'
  | 'swap-stop'
  | 'fs-offer'
  | 'fs-answer'
  | 'fs-ice'
  | 'fs-tree-update'
  | 'fs-state-request'
  | 'fs-state-full'
  | 'fs-folder-create'
  | 'fs-folder-delete'
  | 'fs-download-request'
  | 'fs-transfer-progress'
  | 'fs-transfer-done'
  | 'fs-cancel';

// Incoming message types (server -> client)
export type S2CType =
  | 'joined'
  | 'room-state'
  | 'user-joined'
  | 'user-left'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'control-request'
  | 'control-response'
  | 'control-revoked'
  | 'control-token'   // server → host: cryptographic token after granting control
  | 'swap-offer'
  | 'swap-answer'
  | 'swap-ice'
  | 'swap-stop'
  | 'fs-offer'
  | 'fs-answer'
  | 'fs-ice'
  | 'fs-tree-update'
  | 'fs-state-request'
  | 'fs-state-full'
  | 'fs-folder-create'
  | 'fs-folder-delete'
  | 'fs-download-request'
  | 'fs-transfer-progress'
  | 'fs-transfer-done'
  | 'fs-cancel'
  | 'error';

export interface SignalingMessage {
  type: C2SType | S2CType;
  payload?: unknown;
  from?: string;
  to?: string;
}

export interface JoinPayload {
  roomId: string;
  name: string;
  role: UserRole;
  pin?: string;
}

export interface JoinedPayload {
  userId: string;
  roomId: string;
  role: UserRole;
}

export interface RoomStatePayload {
  roomId: string;
  users: RoomUser[];
  hostId: string | null;
}

export interface UserEventPayload {
  user: RoomUser;
}

export interface UserLeftPayload {
  userId: string;
}

export interface ControlResponsePayload {
  granted: boolean;
  viewerId?: string;
}

// Input events sent over DataChannel (viewer -> host direction)
export type InputEventType =
  | 'mousemove'
  | 'mousedown'
  | 'mouseup'
  | 'wheel'
  | 'keydown'
  | 'keyup';

export interface RemoteInputEvent {
  type: InputEventType;
  x?: number;
  y?: number;
  button?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  modifiers?: {
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
  };
}
