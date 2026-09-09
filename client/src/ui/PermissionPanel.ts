import type { Permissions } from '../webrtc/DataChannelProtocol';

type PermissionChangeHandler = (viewerId: string, patch: Partial<Permissions>) => void;

interface ViewerPermEntry {
  viewerId: string;
  name: string;
  permissions: Permissions;
}

const LABELS: Record<keyof Permissions, string> = {
  remoteControl: 'Remote Control',
  clipboard: 'Clipboard',
  fileTransfer: 'File Transfer',
  chat: 'Chat',
  recording: 'Recording',
};

/** Host-only panel showing per-viewer permission toggles. */
export class PermissionPanel {
  private container: HTMLElement;
  private entries = new Map<string, ViewerPermEntry>();
  private onChange: PermissionChangeHandler;

  constructor(containerId: string, onChange: PermissionChangeHandler) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.onChange = onChange;
    this.render();
  }

  setViewer(viewerId: string, name: string, permissions: Permissions) {
    this.entries.set(viewerId, { viewerId, name, permissions: { ...permissions } });
    this.render();
  }

  removeViewer(viewerId: string) {
    this.entries.delete(viewerId);
    this.render();
  }

  updatePermissions(viewerId: string, permissions: Permissions) {
    const entry = this.entries.get(viewerId);
    if (!entry) return;
    Object.assign(entry.permissions, permissions);
    this.render();
  }

  private render() {
    this.container.innerHTML = '';

    if (this.entries.size === 0) {
      this.container.innerHTML = '<p class="perm-empty">No viewers connected</p>';
      return;
    }

    for (const entry of this.entries.values()) {
      const section = document.createElement('div');
      section.className = 'perm-viewer';

      const name = document.createElement('div');
      name.className = 'perm-viewer-name';
      name.textContent = entry.name;
      section.appendChild(name);

      for (const [key, label] of Object.entries(LABELS) as [keyof Permissions, string][]) {
        const row = document.createElement('label');
        row.className = 'perm-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'perm-check';
        checkbox.checked = entry.permissions[key];
        checkbox.addEventListener('change', () => {
          entry.permissions[key] = checkbox.checked;
          this.onChange(entry.viewerId, { [key]: checkbox.checked });
        });

        const span = document.createElement('span');
        span.className = 'perm-label';
        span.textContent = label;

        row.appendChild(checkbox);
        row.appendChild(span);
        section.appendChild(row);
      }

      this.container.appendChild(section);
    }
  }
}
