import type { RoomUser } from '../types/signaling';

export type ControlState = 'none' | 'requested' | 'granted';

interface UserListOptions {
  role: 'host' | 'viewer';
  onGrantControl?: (userId: string) => void;
  onRevokeControl?: (userId: string) => void;
}

export class UserList {
  private container: HTMLElement;
  private users: RoomUser[] = [];
  private myId: string = '';
  private opts: UserListOptions;
  private controlStates = new Map<string, ControlState>();

  constructor(containerId: string, opts: UserListOptions) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.opts = opts;
  }

  setMyId(id: string) {
    this.myId = id;
  }

  setUsers(users: RoomUser[]) {
    this.users = users;
    this.render();
  }

  addUser(user: RoomUser) {
    if (!this.users.find((u) => u.id === user.id)) {
      this.users.push(user);
      this.render();
    }
  }

  removeUser(userId: string) {
    this.users = this.users.filter((u) => u.id !== userId);
    this.controlStates.delete(userId);
    this.render();
  }

  setControlState(userId: string, state: ControlState) {
    this.controlStates.set(userId, state);
    this.render();
  }

  getUserName(userId: string): string {
    return this.users.find((u) => u.id === userId)?.name ?? 'Unknown';
  }

  private render() {
    const hosts = this.users.filter((u) => u.role === 'host');
    const viewers = this.users.filter((u) => u.role === 'viewer');

    this.container.innerHTML = '';

    if (hosts.length > 0) {
      this.container.appendChild(this.renderGroup('HOST', hosts));
    }
    if (viewers.length > 0) {
      this.container.appendChild(this.renderGroup('VIEWERS', viewers));
    }
    if (this.users.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'user-list-empty';
      empty.textContent = 'No users yet';
      this.container.appendChild(empty);
    }
  }

  private renderGroup(label: string, users: RoomUser[]): HTMLElement {
    const group = document.createElement('div');
    group.className = 'user-group';

    const title = document.createElement('div');
    title.className = 'user-group-title';
    title.textContent = label;
    group.appendChild(title);

    users.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'user-item' + (user.id === this.myId ? ' user-item--me' : '');

      const meta = document.createElement('div');
      meta.className = 'user-item-meta';

      const dot = document.createElement('span');
      dot.className = `user-dot user-dot--${user.role}`;

      const name = document.createElement('span');
      name.className = 'user-name';
      name.textContent = user.name + (user.id === this.myId ? ' (you)' : '');

      meta.appendChild(dot);
      meta.appendChild(name);
      item.appendChild(meta);

      // Host-side: control action buttons next to each viewer
      if (this.opts.role === 'host' && user.role === 'viewer' && user.id !== this.myId) {
        const state = this.controlStates.get(user.id) ?? 'none';
        const actions = document.createElement('div');
        actions.className = 'user-item-actions';

        if (state === 'requested') {
          const badge = document.createElement('span');
          badge.className = 'control-badge control-badge--requested';
          badge.textContent = 'Wants control';
          actions.appendChild(badge);

          const allow = document.createElement('button');
          allow.className = 'btn btn--sm btn--primary';
          allow.textContent = 'Allow';
          allow.addEventListener('click', () => this.opts.onGrantControl?.(user.id));
          actions.appendChild(allow);

          const deny = document.createElement('button');
          deny.className = 'btn btn--sm btn--danger';
          deny.textContent = 'Deny';
          deny.addEventListener('click', () => this.opts.onRevokeControl?.(user.id));
          actions.appendChild(deny);
        } else if (state === 'granted') {
          const badge = document.createElement('span');
          badge.className = 'control-badge control-badge--granted';
          badge.textContent = 'Has control';
          actions.appendChild(badge);

          const revoke = document.createElement('button');
          revoke.className = 'btn btn--sm btn--danger';
          revoke.textContent = 'Revoke';
          revoke.addEventListener('click', () => this.opts.onRevokeControl?.(user.id));
          actions.appendChild(revoke);
        } else {
          const grant = document.createElement('button');
          grant.className = 'btn btn--sm btn--ghost';
          grant.textContent = 'Give Control';
          grant.addEventListener('click', () => this.opts.onGrantControl?.(user.id));
          actions.appendChild(grant);
        }

        item.appendChild(actions);
        item.classList.add('user-item--with-actions');
      }

      group.appendChild(item);
    });

    return group;
  }
}
