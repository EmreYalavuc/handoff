import type { ChatMessage } from '../webrtc/ChatManager';

type SendHandler = (text: string) => void;

export class ChatPanel {
  private container: HTMLElement;
  private messagesEl: HTMLElement;
  private input: HTMLInputElement;
  private onSend: SendHandler;
  private unread = 0;
  private visible = false;
  private unreadHandlers: Array<(n: number) => void> = [];

  constructor(containerId: string, onSend: SendHandler) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.onSend = onSend;
    this.build();
    this.input = this.container.querySelector<HTMLInputElement>('.chat-input')!;
    this.messagesEl = this.container.querySelector<HTMLElement>('.chat-messages')!;
  }

  show() {
    this.visible = true;
    this.container.classList.add('chat-panel--open');
    this.unread = 0;
    this.emitUnread();
    setTimeout(() => this.scrollBottom(), 50);
  }

  hide() {
    this.visible = false;
    this.container.classList.remove('chat-panel--open');
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  appendMessage(msg: ChatMessage) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg' + (msg.own ? ' chat-msg--own' : '');

    const header = document.createElement('div');
    header.className = 'chat-msg-header';
    header.textContent = msg.own ? 'You' : msg.senderName;

    const time = document.createElement('span');
    time.className = 'chat-msg-time';
    time.textContent = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    body.textContent = msg.text;

    header.appendChild(time);
    wrap.appendChild(header);
    wrap.appendChild(body);
    this.messagesEl.appendChild(wrap);
    this.scrollBottom();

    if (!this.visible) {
      this.unread++;
      this.emitUnread();
    }
  }

  onUnread(handler: (n: number) => void) {
    this.unreadHandlers.push(handler);
    return () => { this.unreadHandlers = this.unreadHandlers.filter((h) => h !== handler); };
  }

  private emitUnread() { this.unreadHandlers.forEach((h) => h(this.unread)); }

  private scrollBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private build() {
    this.container.className = 'chat-panel';
    this.container.innerHTML = `
      <div class="chat-panel-header">
        <span class="chat-panel-title">Chat</span>
        <button class="chat-close-btn btn btn--ghost btn--sm" title="Close">✕</button>
      </div>
      <div class="chat-messages"></div>
      <div class="chat-input-row">
        <input class="chat-input form-input" type="text" placeholder="Message..." maxlength="2000" autocomplete="off" />
        <button class="chat-send-btn btn btn--primary btn--sm">Send</button>
      </div>
    `;

    this.container.querySelector('.chat-close-btn')!
      .addEventListener('click', () => this.hide());

    this.container.querySelector('.chat-send-btn')!
      .addEventListener('click', () => this.submit());

    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.submit(); }
    });
  }

  private submit() {
    const input = this.container.querySelector<HTMLInputElement>('.chat-input')!;
    const text = input.value.trim();
    if (!text) return;
    this.onSend(text);
    input.value = '';
  }
}
