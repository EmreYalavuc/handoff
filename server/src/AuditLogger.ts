import { appendFileSync } from 'fs';
import { join } from 'path';

export type AuditEventType =
  | 'ROOM_CREATED'
  | 'ROOM_JOIN_ATTEMPT'
  | 'ROOM_JOIN_FAILED'
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'CONTROL_REQUESTED'
  | 'CONTROL_GRANTED'
  | 'CONTROL_REVOKED'
  | 'PERMISSION_CHANGED'
  | 'FILE_TRANSFER_STARTED'
  | 'FILE_TRANSFER_COMPLETED'
  | 'SESSION_STARTED'
  | 'SESSION_ENDED'
  | 'RATE_LIMIT_TRIGGERED'
  | 'SECURITY_VIOLATION';

export interface AuditEvent {
  type: AuditEventType;
  ts: number;
  roomId?: string;
  userId?: string;
  ip?: string;
  detail?: string;
}

export class AuditLogger {
  private logToFile: boolean;
  private logPath: string;

  constructor(options?: { logToFile?: boolean; logPath?: string }) {
    this.logToFile = options?.logToFile ?? false;
    this.logPath = options?.logPath ?? join(process.cwd(), 'audit.log');
  }

  log(event: Omit<AuditEvent, 'ts'>) {
    const entry: AuditEvent = { ...event, ts: Date.now() };
    console.log(`[AUDIT] ${JSON.stringify(entry)}`);
    if (this.logToFile) {
      try { appendFileSync(this.logPath, JSON.stringify(entry) + '\n'); } catch { /* io error, continue */ }
    }
  }
}
