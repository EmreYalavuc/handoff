export type UserRole = 'host' | 'viewer';

export interface RoomUser {
  id: string;
  name: string;
  role: UserRole;
  wsId: string;
}

export interface Room {
  id: string;
  users: Map<string, RoomUser>;
  hostId: string | null;
  createdAt: number;
  pin?: string;                          // optional PIN (plaintext, in-memory only)
  controlGrantedViewers: Set<string>;   // viewer userIds with active control grant
}

// Client -> Server message types
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
  // File-transfer room types (no role restriction — any room member)
  | 'fs-offer'
  | 'fs-answer'
  | 'fs-ice'
  | 'fs-tree-update'       // broadcast: user's shared file list changed
  | 'fs-state-request'     // directed: new user requests full room state from host
  | 'fs-state-full'        // directed: host sends full room state to new user
  | 'fs-folder-create'     // broadcast: user created a virtual folder
  | 'fs-folder-delete'     // broadcast: user deleted a virtual folder
  | 'fs-download-request'  // directed: peer wants to download a file
  | 'fs-transfer-progress' // broadcast: transfer speed update (for room visibility)
  | 'fs-transfer-done'     // broadcast: transfer completed
  | 'fs-cancel';           // directed or broadcast: cancel a transfer

// Server -> Client message types
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
  | 'control-token'     // server → host: cryptographic token after granting control
  | 'swap-offer'
  | 'swap-answer'
  | 'swap-ice'
  | 'swap-stop'
  // File-transfer room types (mirrored from C2S, routed by server)
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

// Payload shapes
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
  users: Array<{ id: string; name: string; role: UserRole }>;
  hostId: string | null;
}

export interface UserEventPayload {
  user: { id: string; name: string; role: UserRole };
}

export interface ControlResponsePayload {
  granted: boolean;
  viewerId?: string;
}

export interface ControlTokenPayload {
  token: string;
  viewerId: string;
}
