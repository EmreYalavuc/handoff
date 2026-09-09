import { makeDCMessage, type DCMessage, type ChatMsg } from './DataChannelProtocol';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  ts: number;
  own: boolean; // true if sent by this client
}

type ChatHandler = (msg: ChatMessage) => void;

/**
 * Maintains chat history and provides send/receive.
 * Wired to HostConnection or ViewerConnection via their dc-message events.
 */
export class ChatManager {
  readonly history: ChatMessage[] = [];
  private handlers: ChatHandler[] = [];
  private myId: string;
  private myName: string;

  constructor(myId: string, myName: string) {
    this.myId = myId;
    this.myName = myName;
  }

  /** Call from room.ts when a 'chat' dc-message arrives. */
  receive(msg: DCMessage) {
    if (msg.type !== 'chat') return;
    const p = msg.payload as ChatMsg;
    const chat: ChatMessage = {
      id: msg.id,
      senderId: p.senderId,
      senderName: p.senderName,
      text: p.text,
      ts: msg.ts,
      own: p.senderId === this.myId,
    };
    this.history.push(chat);
    this.handlers.forEach((h) => h(chat));
  }

  /** Returns a DCMessage ready to be sent via sendDC / broadcastDC. */
  buildMessage(text: string): DCMessage {
    const payload: ChatMsg = { text, senderId: this.myId, senderName: this.myName };
    const msg = makeDCMessage('chat', payload, this.myId);
    // Record locally
    this.receive(msg);
    return msg;
  }

  on(handler: ChatHandler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }
}
