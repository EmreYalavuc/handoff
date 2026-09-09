/** Lightweight in-session notes saved to sessionStorage. */
export class SessionNotes {
  private textarea: HTMLTextAreaElement;
  private storageKey: string;

  constructor(containerId: string, sessionId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);

    this.storageKey = `notes_${sessionId}`;

    const header = document.createElement('div');
    header.className = 'notes-header';
    header.textContent = 'Session Notes';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'notes-textarea form-input';
    this.textarea.placeholder = 'Customer reported:\n– Issue description\n\nResolution:\n– Steps taken';
    this.textarea.value = sessionStorage.getItem(this.storageKey) ?? '';

    this.textarea.addEventListener('input', () => {
      sessionStorage.setItem(this.storageKey, this.textarea.value);
    });

    el.appendChild(header);
    el.appendChild(this.textarea);
  }

  getText(): string { return this.textarea.value; }
}
