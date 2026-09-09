/** Virtual file/folder structure shared across all room members. */

export interface SharedFolder {
  id: string;
  name: string;
  parentId: string | null; // null = root
  createdAt: number;
  ownerId: string;
  ownerName: string;
}

export interface SharedFile {
  id: string;
  name: string;
  extension: string;
  mimeType: string;
  size: number;
  createdAt: number;    // file.lastModified
  modifiedAt: number;
  uploadedAt: number;
  ownerId: string;
  ownerName: string;
  folderId: string | null;
  // local-only — never synced
  localFile?: File;
}

export interface RoomMember {
  id: string;
  name: string;
  online: boolean;
}

export type FileShareEvent =
  | { type: 'files-changed' }
  | { type: 'folders-changed' }
  | { type: 'members-changed' };

type EventHandler = (e: FileShareEvent) => void;

export class FileShareState {
  readonly folders = new Map<string, SharedFolder>();
  readonly files = new Map<string, SharedFile>();
  readonly members = new Map<string, RoomMember>();

  private handlers: EventHandler[] = [];

  on(h: EventHandler) { this.handlers.push(h); return () => { this.handlers = this.handlers.filter(x => x !== h); }; }
  private emit(e: FileShareEvent) { this.handlers.forEach(h => h(e)); }

  // ---- Members ----
  addMember(member: RoomMember) {
    this.members.set(member.id, member);
    this.emit({ type: 'members-changed' });
  }
  removeMember(id: string) {
    this.members.delete(id);
    this.emit({ type: 'members-changed' });
  }
  setMemberOffline(id: string) {
    const m = this.members.get(id);
    if (m) { m.online = false; this.emit({ type: 'members-changed' }); }
  }

  // ---- Folders ----
  addFolder(folder: SharedFolder) {
    this.folders.set(folder.id, folder);
    this.emit({ type: 'folders-changed' });
  }
  deleteFolder(folderId: string) {
    if (!this.folders.has(folderId)) return;
    // Move files in this folder to root
    for (const f of this.files.values()) {
      if (f.folderId === folderId) f.folderId = null;
    }
    // Move sub-folders to parent
    for (const folder of this.folders.values()) {
      if (folder.parentId === folderId) {
        folder.parentId = this.folders.get(folderId)!.parentId;
      }
    }
    this.folders.delete(folderId);
    this.emit({ type: 'folders-changed' });
    this.emit({ type: 'files-changed' });
  }

  // ---- Files ----
  addFile(file: SharedFile) {
    this.files.set(file.id, file);
    this.emit({ type: 'files-changed' });
  }
  removeFile(fileId: string) {
    this.files.delete(fileId);
    this.emit({ type: 'files-changed' });
  }

  /** Files in a given folder (null = root). */
  filesInFolder(folderId: string | null): SharedFile[] {
    return Array.from(this.files.values()).filter(f => f.folderId === folderId);
  }

  /** Direct sub-folders of a given folder (null = root level). */
  foldersInParent(parentId: string | null): SharedFolder[] {
    return Array.from(this.folders.values()).filter(f => f.parentId === parentId);
  }

  // ---- Serialization (for state sync) ----
  toJSON() {
    return {
      folders: Array.from(this.folders.values()),
      files: Array.from(this.files.values()).map(f => ({ ...f, localFile: undefined })),
    };
  }

  loadFromJSON(data: { folders: SharedFolder[]; files: SharedFile[] }) {
    for (const folder of data.folders) {
      if (!this.folders.has(folder.id)) this.folders.set(folder.id, folder);
    }
    for (const file of data.files) {
      if (!this.files.has(file.id)) this.files.set(file.id, file);
    }
    this.emit({ type: 'folders-changed' });
    this.emit({ type: 'files-changed' });
  }
}
