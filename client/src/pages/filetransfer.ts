import { SignalingClient } from '../signaling/SignalingClient';
import { FileShareState, SharedFile, SharedFolder } from '../fileshare/FileShareState';
import { PeerTransfer, TransferState } from '../fileshare/PeerTransfer';
import { SpeedLimiter } from '../fileshare/SpeedLimiter';
import { t, applyTranslations } from '../i18n';
import { initLangSwitcher } from '../ui/LangSwitcher';

// ── URL params ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const ROOM_ID  = params.get('roomId') ?? '';
const MY_NAME  = params.get('name')   ?? 'Anonymous';

// ── Constants ───────────────────────────────────────────────────────────────
const WS_URL = (import.meta.env.PROD && import.meta.env.VITE_WS_URL)
  ? (import.meta.env.VITE_WS_URL as string)
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const SPEED_STEPS: Array<number | null> = [null, 1, 5, 10, 25, 50, 100, 250, 1_000];
// index 0 = unlimited, 1-8 = Mbps values
function stepLabel(idx: number): string {
  const s = SPEED_STEPS[idx];
  if (s === null) return t('ft.unlimited');
  if (s >= 1000) return `${s / 1000} Gbps`;
  return `${s} Mbps`;
}
function stepBps(idx: number): number | null {
  const s = SPEED_STEPS[idx];
  return s === null ? null : s * 1_000_000 / 8; // Mbps → bytes/sec
}

// ── Global state ────────────────────────────────────────────────────────────
let myUserId = '';
let currentFolderId: string | null = null; // null = root
let selectedFileId: string | null = null;

// ── Local file server (Desktop Agent) ───────────────────────────────────────
const LOCAL_FS_PORT = 9002;
const LOCAL_FS_BASE = `http://localhost:${LOCAL_FS_PORT}`;
let localFSActive = false;
let localFSIPs: string[] = [];

const state     = new FileShareState();
const peers     = new Map<string, PeerTransfer>();
const dlLimiter = new SpeedLimiter(null); // download limiter (shared stub)

// Aggregate speed tracking (across all active transfers)
let totalUlBps = 0;
let totalDlBps = 0;

// ── Signaling ────────────────────────────────────────────────────────────────
const signaling = new SignalingClient({ url: WS_URL });

// ── DOM refs ─────────────────────────────────────────────────────────────────
const elRoomId     = document.getElementById('ft-room-id')!;
const elCopyBtn    = document.getElementById('ft-copy-room-btn')!;
const elLeaveBtn   = document.getElementById('ft-leave-btn')!;
const elUlSpeed    = document.getElementById('ft-ul-speed')!;
const elDlSpeed    = document.getElementById('ft-dl-speed')!;
const elTransport  = document.getElementById('ft-transport')!;
const elUserCount  = document.getElementById('ft-user-count-num')!;
const elFolderTree = document.getElementById('ft-folder-tree')!;
const elMemberList = document.getElementById('ft-member-list')!;
const elBreadcrumb = document.getElementById('ft-breadcrumb')!;
const elFileList   = document.getElementById('ft-file-list')!;
const elEmptyState = document.getElementById('ft-empty-state')!;
const elTransferList  = document.getElementById('ft-transfer-list')!;
const elNoTransfers   = document.getElementById('ft-no-transfers')!;
const elActiveCount   = document.getElementById('ft-active-count')!;
const elDetailEmpty   = document.getElementById('ft-detail-empty')!;
const elDetailContent = document.getElementById('ft-detail-content')!;
const elDetailIcon    = document.getElementById('ft-detail-icon')!;
const elDetailName    = document.getElementById('ft-detail-name')!;
const elDetailTable   = document.getElementById('ft-detail-table')!;
const elDetailActions = document.getElementById('ft-detail-actions')!;
const elDropOverlay   = document.getElementById('ft-drop-overlay')!;
const elFileInput     = document.getElementById('ft-file-input') as HTMLInputElement;
const elFolderInput   = document.getElementById('ft-folder-input') as HTMLInputElement;
const elUploadBtn     = document.getElementById('ft-upload-btn')!;
const elUploadFolderBtn = document.getElementById('ft-upload-folder-btn')!;
const elNewFolderBtn  = document.getElementById('ft-new-folder-btn')!;
const elUlSlider      = document.getElementById('ft-ul-limit-slider') as HTMLInputElement;
const elUlLabel       = document.getElementById('ft-ul-limit-label')!;
const elDlSlider      = document.getElementById('ft-dl-limit-slider') as HTMLInputElement;
const elDlLabel       = document.getElementById('ft-dl-limit-label')!;

// ── Utility ──────────────────────────────────────────────────────────────────
function uuid(): string {
  return crypto.randomUUID();
}

function fmtBytes(b: number): string {
  if (b < 1024)          return `${b} B`;
  if (b < 1024 ** 2)     return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)     return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function fmtSpeed(bps: number): string {
  return `${fmtBytes(bps)}/s`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function fileIcon(mimeType: string, ext: string): string {
  if (mimeType.startsWith('image/'))  return '🖼️';
  if (mimeType.startsWith('video/'))  return '🎬';
  if (mimeType.startsWith('audio/'))  return '🎵';
  if (mimeType.startsWith('text/'))   return '📝';
  if (mimeType.includes('pdf'))       return '📕';
  if (mimeType.includes('zip') || mimeType.includes('compressed') || ['zip','rar','7z','tar','gz'].includes(ext)) return '🗜️';
  if (['js','ts','py','go','rs','c','cpp','java','json','xml','html','css'].includes(ext)) return '💻';
  return '📄';
}

function eta(bps: number, remaining: number): string {
  if (bps <= 0) return '—';
  const secs = remaining / bps;
  if (secs < 60)   return `${Math.ceil(secs)}s`;
  if (secs < 3600) return `${Math.ceil(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

// ── Signaling helpers ─────────────────────────────────────────────────────────
function sendSignal(type: string, payload: unknown, to?: string) {
  signaling.send(type as never, payload, to);
}

// ── Peer management ───────────────────────────────────────────────────────────
function getOrCreatePeer(peerId: string): PeerTransfer {
  if (peers.has(peerId)) return peers.get(peerId)!;

  const pt = new PeerTransfer(peerId, sendSignal);
  peers.set(peerId, pt);

  pt.on((e) => {
    if (e.type === 'transfer-update') onTransferUpdate(e.state);
    if (e.type === 'transfer-done')   onTransferDone(e.transferId, e.fileName);
    if (e.type === 'closed') {
      peers.delete(peerId);
      renderTransfers();
    }
  });

  return pt;
}

function getPeer(peerId: string): PeerTransfer | undefined {
  return peers.get(peerId);
}

// ── Speed limit sliders ───────────────────────────────────────────────────────
elUlSlider.addEventListener('input', () => {
  const idx = parseInt(elUlSlider.value, 10);
  elUlLabel.textContent = stepLabel(idx);
  const bps = stepBps(idx);
  for (const pt of peers.values()) pt.uploadLimiter.setLimit(bps);
});

elDlSlider.addEventListener('input', () => {
  const idx = parseInt(elDlSlider.value, 10);
  elDlLabel.textContent = stepLabel(idx);
  dlLimiter.setLimit(stepBps(idx));
});

// ── Room ID display ───────────────────────────────────────────────────────────
function initRoomDisplay() {
  elRoomId.textContent = ROOM_ID || '—';
  elCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(ROOM_ID).then(() => {
      elCopyBtn.setAttribute('title', 'Copied!');
      setTimeout(() => elCopyBtn.setAttribute('title', 'Copy Room ID'), 1500);
    });
  });
  elLeaveBtn.addEventListener('click', () => {
    signaling.disconnect();
    window.location.href = '/';
  });
}

// ── Local file server helpers ─────────────────────────────────────────────────

async function detectLocalFileServer(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`${LOCAL_FS_BASE}/info`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const info = await res.json() as { localIPs: string[]; port: number };
    localFSIPs = info.localIPs ?? [];
    localFSActive = true;
    renderLocalFSBadge();
    return true;
  } catch {
    return false;
  }
}

async function registerFileWithLocalFS(file: SharedFile): Promise<void> {
  if (!localFSActive || !file.localFile) return;
  try {
    const url = `${LOCAL_FS_BASE}/register?id=${encodeURIComponent(file.id)}&name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.mimeType)}&size=${file.size}`;
    await fetch(url, { method: 'POST', body: file.localFile });
  } catch {
    // Agent went offline — not fatal, WebRTC P2P still works
  }
}

function renderLocalFSBadge() {
  const existing = document.getElementById('ft-local-fs-wrap');
  if (existing) existing.remove();

  if (!localFSActive || localFSIPs.length === 0) return;

  const primaryIP = localFSIPs[0];
  const url = `http://${primaryIP}:${LOCAL_FS_PORT}`;

  const wrap = document.createElement('div');
  wrap.id = 'ft-local-fs-wrap';
  wrap.className = 'ft-local-fs-wrap';
  wrap.innerHTML = `
    <span class="ft-local-fs-label">Lokal İndir</span>
    <a class="ft-local-fs-url mono" href="${url}" target="_blank" title="Aynı ağdaki mobil cihazdan açın">${url}</a>
    ${localFSIPs.length > 1 ? `<span class="ft-local-fs-extra">+${localFSIPs.length - 1} IP</span>` : ''}
  `;

  // Insert into topbar center
  const center = document.querySelector('.ft-topbar-center');
  if (center) center.appendChild(wrap);
}

// ── Aggregate speed display ───────────────────────────────────────────────────
function updateSpeedDisplay() {
  let ul = 0, dl = 0;
  for (const pt of peers.values()) {
    for (const t of pt.getAllTransfers()) {
      if (t.state === 'active') {
        if (t.direction === 'send')    ul += t.speedBps;
        else                           dl += t.speedBps;
      }
    }
  }
  totalUlBps = ul;
  totalDlBps = dl;
  elUlSpeed.textContent = `↑ ${fmtSpeed(ul)}`;
  elDlSpeed.textContent = `↓ ${fmtSpeed(dl)}`;
}

setInterval(updateSpeedDisplay, 500);

// ── Folder tree rendering ─────────────────────────────────────────────────────
function renderFolderTree() {
  elFolderTree.innerHTML = '';

  const rootEl = document.createElement('div');
  rootEl.className = 'ft-folder-item' + (currentFolderId === null ? ' ft-folder-item--active' : '');
  rootEl.dataset['folderId'] = 'root';
  rootEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${t('ft.all_files')}`;
  rootEl.addEventListener('click', () => navigateFolder(null));
  elFolderTree.appendChild(rootEl);

  renderFolderChildren(null, elFolderTree, 0);
}

function renderFolderChildren(parentId: string | null, container: Element, depth: number) {
  for (const folder of state.foldersInParent(parentId)) {
    const el = document.createElement('div');
    el.className = 'ft-folder-item' + (currentFolderId === folder.id ? ' ft-folder-item--active' : '');
    el.dataset['folderId'] = folder.id;
    el.style.paddingLeft = `${12 + depth * 14}px`;
    el.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${esc(folder.name)}`;
    el.addEventListener('click', () => navigateFolder(folder.id));
    container.appendChild(el);
    renderFolderChildren(folder.id, container, depth + 1);
  }
}

function navigateFolder(folderId: string | null) {
  currentFolderId = folderId;
  renderFolderTree();
  renderFileList();
  updateBreadcrumb();
}

function updateBreadcrumb() {
  if (currentFolderId === null) { elBreadcrumb.textContent = t('ft.all_files'); return; }
  const folder = state.folders.get(currentFolderId);
  elBreadcrumb.textContent = folder ? folder.name : t('ft.folder_type');
}

// ── Member list rendering ─────────────────────────────────────────────────────
function renderMembers() {
  elMemberList.innerHTML = '';
  elUserCount.textContent = String(state.members.size);
  for (const m of state.members.values()) {
    const li = document.createElement('li');
    li.className = 'ft-member-item' + (m.online ? '' : ' ft-member-item--offline');
    li.innerHTML = `<span class="ft-member-dot"></span><span class="ft-member-name">${esc(m.name)}${m.id === myUserId ? ' ' + t('ft.you') : ''}</span>`;
    elMemberList.appendChild(li);
  }
}

// ── File list rendering ───────────────────────────────────────────────────────
function renderFileList() {
  // Remove old file rows (keep header + empty state)
  elFileList.querySelectorAll('.ft-file-row, .ft-folder-row').forEach(el => el.remove());

  const folders = state.foldersInParent(currentFolderId);
  const files   = state.filesInFolder(currentFolderId);
  const empty   = folders.length === 0 && files.length === 0;

  elEmptyState.style.display = empty ? '' : 'none';

  // Render sub-folders
  for (const folder of folders) {
    const row = document.createElement('div');
    row.className = 'ft-file-cols ft-folder-row';
    row.innerHTML = `
      <span class="ft-col-name">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        ${esc(folder.name)}
      </span>
      <span class="ft-col-size">—</span>
      <span class="ft-col-type">${t('ft.folder_type')}</span>
      <span class="ft-col-date">${fmtDate(folder.createdAt)}</span>
      <span class="ft-col-owner">${esc(folder.ownerName)}</span>
      <span class="ft-col-action"></span>
    `;
    row.addEventListener('click', () => navigateFolder(folder.id));
    elFileList.appendChild(row);
  }

  // Render files
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'ft-file-cols ft-file-row' + (selectedFileId === file.id ? ' ft-file-row--selected' : '');
    row.dataset['fileId'] = file.id;

    const icon = fileIcon(file.mimeType, file.extension);
    const isOwn = file.ownerId === myUserId;

    row.innerHTML = `
      <span class="ft-col-name">${icon} ${esc(file.name)}</span>
      <span class="ft-col-size">${fmtBytes(file.size)}</span>
      <span class="ft-col-type">${esc(file.extension.toUpperCase() || file.mimeType)}</span>
      <span class="ft-col-date">${fmtDate(file.modifiedAt)}</span>
      <span class="ft-col-owner">${esc(file.ownerName)}</span>
      <span class="ft-col-action">${isOwn ? '' : `<button class="btn btn--primary btn--xs ft-dl-btn" data-file-id="${file.id}">${t('ft.download')}</button>`}</span>
    `;
    row.addEventListener('click', () => selectFile(file.id));
    const dlBtn = row.querySelector<HTMLButtonElement>('.ft-dl-btn');
    dlBtn?.addEventListener('click', (ev) => { ev.stopPropagation(); downloadFile(file.id); });
    elFileList.appendChild(row);
  }
}

// ── File detail panel ─────────────────────────────────────────────────────────
function selectFile(fileId: string) {
  selectedFileId = fileId;
  renderFileList(); // re-render to update selected row

  const file = state.files.get(fileId);
  if (!file) { showDetailEmpty(); return; }

  elDetailEmpty.hidden = true;
  elDetailContent.hidden = false;
  elDetailIcon.textContent = fileIcon(file.mimeType, file.extension);
  elDetailName.textContent = file.name;

  const rows: [string, string][] = [
    [t('ft.detail.size'),     fmtBytes(file.size)],
    [t('ft.detail.type'),     file.mimeType || file.extension],
    [t('ft.detail.uploaded'), fmtDate(file.uploadedAt)],
    [t('ft.detail.modified'), fmtDate(file.modifiedAt)],
    [t('ft.detail.owner'),    file.ownerName],
  ];
  if (file.folderId) {
    const folder = state.folders.get(file.folderId);
    if (folder) rows.push([t('ft.detail.folder'), folder.name]);
  }

  elDetailTable.innerHTML = rows.map(([k, v]) =>
    `<tr><td class="ft-detail-key">${k}</td><td class="ft-detail-val">${esc(v)}</td></tr>`
  ).join('');

  elDetailActions.innerHTML = '';
  if (file.ownerId !== myUserId) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--primary';
    btn.textContent = t('ft.download');
    btn.addEventListener('click', () => downloadFile(fileId));
    elDetailActions.appendChild(btn);
  }

  // Preview for own files (local File object available)
  renderPreview(file);
}

function renderPreview(file: SharedFile) {
  // Remove old preview
  elDetailContent.querySelector('.ft-preview')?.remove();

  if (!file.localFile) return; // remote file — no preview

  const wrap = document.createElement('div');
  wrap.className = 'ft-preview';

  if (file.mimeType.startsWith('image/')) {
    const url = URL.createObjectURL(file.localFile);
    const img = document.createElement('img');
    img.src = url;
    img.className = 'ft-preview-img';
    img.onload = () => URL.revokeObjectURL(url);
    wrap.appendChild(img);
  } else if (file.mimeType.startsWith('video/')) {
    const url = URL.createObjectURL(file.localFile);
    const vid = document.createElement('video');
    vid.src = url;
    vid.className = 'ft-preview-video';
    vid.controls = false;
    vid.muted = true;
    // Seek to first frame as thumbnail
    vid.addEventListener('loadeddata', () => {
      vid.currentTime = 0;
      URL.revokeObjectURL(url);
    }, { once: true });
    wrap.appendChild(vid);
  } else if (file.mimeType.startsWith('text/') || ['json','xml','csv','md','ts','js','py','go','rs','java','html','css'].includes(file.extension)) {
    const reader = new FileReader();
    reader.onload = () => {
      const pre = document.createElement('pre');
      pre.className = 'ft-preview-text';
      pre.textContent = (reader.result as string).slice(0, 2000);
      wrap.appendChild(pre);
    };
    reader.readAsText(file.localFile.slice(0, 8192));
  } else {
    return; // no preview for other types
  }

  elDetailContent.appendChild(wrap);
}

function showDetailEmpty() {
  elDetailEmpty.hidden = false;
  elDetailContent.hidden = true;
}

// ── Download ──────────────────────────────────────────────────────────────────
async function downloadFile(fileId: string) {
  const file = state.files.get(fileId);
  if (!file) return;
  if (file.ownerId === myUserId) return; // own file — nothing to download

  const owner = state.members.get(file.ownerId);
  if (!owner) { alert(t('ft.owner_offline')); return; }

  let pt = getPeer(file.ownerId);
  if (!pt) {
    // Create peer connection and offer
    pt = getOrCreatePeer(file.ownerId);
    await pt.createOffer();
  }

  const transferId = uuid();
  await pt.requestDownload(transferId, file.id, file.name, file.size);
}

// ── Transfer events ───────────────────────────────────────────────────────────
function onTransferUpdate(ts: TransferState) {
  updateSpeedDisplay();
  renderTransferCard(ts);
}

function onTransferDone(transferId: string, fileName: string) {
  renderTransfers();
  showToast(`${t('ft.toast.download_done')} ${fileName}`);
}

// ── Transfer manager rendering ────────────────────────────────────────────────
function renderTransfers() {
  const all: TransferState[] = [];
  for (const pt of peers.values()) all.push(...pt.getAllTransfers());

  const active = all.filter(t => t.state === 'active' || t.state === 'paused' || t.state === 'starting');

  if (active.length === 0) {
    elNoTransfers.hidden = false;
    elActiveCount.hidden = true;
  } else {
    elNoTransfers.hidden = true;
    elActiveCount.hidden = false;
    elActiveCount.textContent = String(active.length);
  }

  for (const ts of active) renderTransferCard(ts);

  // Remove cards for finished transfers
  elTransferList.querySelectorAll<HTMLElement>('.ft-transfer-card').forEach(card => {
    const id = card.dataset['transferId']!;
    if (!active.find(t => t.transferId === id)) card.remove();
  });
}

function renderTransferCard(ts: TransferState) {
  const cardId = `tc-${ts.transferId}`;
  let card = document.getElementById(cardId);
  const isNew = !card;

  if (isNew) {
    card = document.createElement('div');
    card.className = 'ft-transfer-card';
    card.id = cardId;
    card.dataset['transferId'] = ts.transferId;
    elTransferList.insertBefore(card, elTransferList.firstChild);
    elNoTransfers.hidden = true;
  }

  const pct = ts.totalChunks > 0 ? Math.round((Math.max(ts.sentChunks, ts.receivedChunks) / ts.totalChunks) * 100) : 0;
  const dir  = ts.direction === 'send' ? '↑' : '↓';
  const remaining = ts.size - (Math.max(ts.sentChunks, ts.receivedChunks) / ts.totalChunks) * ts.size;
  const etaStr = eta(ts.speedBps, remaining);

  const peer = peers.get(ts.direction === 'send' ? ts.transferId : '');

  card!.innerHTML = `
    <div class="ft-tc-header">
      <span class="ft-tc-dir">${dir}</span>
      <span class="ft-tc-name">${esc(ts.fileName)}</span>
      <span class="ft-tc-state ft-tc-state--${ts.state}">${t(`ft.state.${ts.state}`)}</span>
    </div>
    <div class="ft-tc-progress-wrap">
      <div class="ft-tc-progress-bar" style="width:${pct}%"></div>
    </div>
    <div class="ft-tc-meta">
      <span>${fmtBytes(ts.size)} · ${pct}%</span>
      <span>${ts.speedBps > 0 ? fmtSpeed(ts.speedBps) : '—'}</span>
      <span>ETA ${etaStr}</span>
    </div>
    <div class="ft-tc-actions">
      ${ts.state === 'active'  ? `<button class="btn btn--ghost btn--xs" data-action="pause"  data-tid="${ts.transferId}" data-pid="${ts.direction === 'send' ? ts.transferId : findPeerForTransfer(ts.transferId)}">${t('ft.btn.pause')}</button>` : ''}
      ${ts.state === 'paused'  ? `<button class="btn btn--ghost btn--xs" data-action="resume" data-tid="${ts.transferId}" data-pid="${findPeerForTransfer(ts.transferId)}">${t('ft.btn.resume')}</button>` : ''}
      <button class="btn btn--ghost btn--xs" data-action="cancel" data-tid="${ts.transferId}" data-pid="${findPeerForTransfer(ts.transferId)}">${t('ft.btn.cancel')}</button>
    </div>
  `;

  card!.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset['action']!;
      const tid    = btn.dataset['tid']!;
      const pid    = btn.dataset['pid']!;
      const pt     = peers.get(pid);
      if (!pt) return;
      if (action === 'pause')  pt.pauseTransfer(tid);
      if (action === 'resume') pt.resumeTransfer(tid);
      if (action === 'cancel') { pt.cancelTransfer(tid); renderTransfers(); }
    });
  });
}

function findPeerForTransfer(transferId: string): string {
  for (const [pid, pt] of peers) {
    if (pt.getTransfer(transferId)) return pid;
  }
  return '';
}

// ── Share files ───────────────────────────────────────────────────────────────
function registerFiles(files: File[], folderId: string | null) {
  for (const f of files) {
    const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '';
    const shared: SharedFile = {
      id: uuid(), name: f.name, extension: ext, mimeType: f.type || 'application/octet-stream',
      size: f.size, createdAt: f.lastModified, modifiedAt: f.lastModified,
      uploadedAt: Date.now(), ownerId: myUserId, ownerName: MY_NAME,
      folderId, localFile: f,
    };
    state.addFile(shared);

    // Register file with all existing peers so they can serve it
    for (const pt of peers.values()) pt.registerLocalFile(shared.id, f);

    // Also register with local file server if agent is running (LAN fast path)
    registerFileWithLocalFS(shared);

    // Broadcast tree update to all peers
    sendSignal('fs-tree-update', {
      files: [{ ...shared, localFile: undefined }],
      folders: [],
    });
  }
}

function handleFileDrop(fileList: FileList | File[], folderId: string | null) {
  registerFiles(Array.from(fileList as FileList), folderId);
}

// ── Folder creation ───────────────────────────────────────────────────────────
function createFolder(name: string, parentId: string | null) {
  const folder: SharedFolder = {
    id: uuid(), name, parentId, createdAt: Date.now(),
    ownerId: myUserId, ownerName: MY_NAME,
  };
  state.addFolder(folder);
  sendSignal('fs-folder-create', folder);
}

// ── New Folder button ─────────────────────────────────────────────────────────
elNewFolderBtn.addEventListener('click', () => {
  const name = prompt(t('ft.folder_name_prompt'));
  if (name?.trim()) createFolder(name.trim(), currentFolderId);
});

// ── Upload buttons ────────────────────────────────────────────────────────────
elUploadBtn.addEventListener('click', () => elFileInput.click());
elFileInput.addEventListener('change', () => {
  if (elFileInput.files) handleFileDrop(elFileInput.files, currentFolderId);
  elFileInput.value = '';
});

elUploadFolderBtn.addEventListener('click', () => {
  (elFolderInput as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
  elFolderInput.click();
});
elFolderInput.addEventListener('change', async () => {
  if (!elFolderInput.files) return;
  const files = Array.from(elFolderInput.files);

  // Group by relative folder path (webkitRelativePath)
  const seen = new Map<string, string>(); // path → folderId

  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const parts = rel.split('/');
    // Build folder hierarchy
    let parentId: string | null = currentFolderId;
    for (let i = 0; i < parts.length - 1; i++) {
      const pathKey = parts.slice(0, i + 1).join('/');
      if (!seen.has(pathKey)) {
        const name = parts[i];
        const folderObj: SharedFolder = {
          id: uuid(), name, parentId, createdAt: Date.now(),
          ownerId: myUserId, ownerName: MY_NAME,
        };
        state.addFolder(folderObj);
        sendSignal('fs-folder-create', folderObj);
        seen.set(pathKey, folderObj.id);
      }
      parentId = seen.get(pathKey)!;
    }
    // Register the file in the last folder
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    const shared: SharedFile = {
      id: uuid(), name: file.name, extension: ext, mimeType: file.type || 'application/octet-stream',
      size: file.size, createdAt: file.lastModified, modifiedAt: file.lastModified,
      uploadedAt: Date.now(), ownerId: myUserId, ownerName: MY_NAME,
      folderId: parentId, localFile: file,
    };
    state.addFile(shared);
    for (const pt of peers.values()) pt.registerLocalFile(shared.id, file);
    sendSignal('fs-tree-update', { files: [{ ...shared, localFile: undefined }], folders: [] });
  }

  elFolderInput.value = '';
});

// ── Drag & Drop ───────────────────────────────────────────────────────────────
const filesPanel = document.querySelector('.ft-files-panel')!;
let dragCounter = 0;

filesPanel.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; elDropOverlay.classList.add('ft-drop-overlay--active'); });
filesPanel.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; elDropOverlay.classList.remove('ft-drop-overlay--active'); } });
filesPanel.addEventListener('dragover', (e) => e.preventDefault());
filesPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  elDropOverlay.classList.remove('ft-drop-overlay--active');
  const dt = (e as DragEvent).dataTransfer;
  if (dt?.files.length) handleFileDrop(dt.files, currentFolderId);
});

// ── Signaling message handlers ────────────────────────────────────────────────
signaling.on('joined', (msg) => {
  const payload = msg.payload as { userId: string; roomId: string };
  myUserId = payload.userId;
  elTransport.textContent = 'WS';

  state.addMember({ id: myUserId, name: MY_NAME, online: true });

  // Request current state from any existing members
  sendSignal('fs-state-request', {});
});

signaling.on('room-state', (msg) => {
  const payload = msg.payload as { users: Array<{ id: string; name: string; role: string }> };
  for (const u of payload.users) {
    if (u.id !== myUserId) state.addMember({ id: u.id, name: u.name, online: true });
  }
});

signaling.on('user-joined', (msg) => {
  const payload = msg.payload as { user: { id: string; name: string } };
  state.addMember({ id: payload.user.id, name: payload.user.name, online: true });

  // Send current state to new joiner
  if (myUserId) {
    sendSignal('fs-state-full', { payload: state.toJSON(), to: payload.user.id });
  }
});

signaling.on('user-left', (msg) => {
  const payload = msg.payload as { userId: string };
  state.setMemberOffline(payload.userId);
  const pt = peers.get(payload.userId);
  if (pt) { pt.close(); peers.delete(payload.userId); }
});

// fs-state-request: someone asked for current state
signaling.on('fs-state-request' as never, (msg) => {
  sendSignal('fs-state-full', { payload: state.toJSON(), to: msg.from });
});

// fs-state-full: received full state from a peer
signaling.on('fs-state-full' as never, (msg) => {
  const payload = msg.payload as { payload?: { folders: SharedFolder[]; files: SharedFile[] } };
  const data = payload.payload;
  if (data) state.loadFromJSON(data);
});

// fs-tree-update: incremental file/folder additions
signaling.on('fs-tree-update' as never, (msg) => {
  const payload = msg.payload as { files?: SharedFile[]; folders?: SharedFolder[] };
  if (payload.files) for (const f of payload.files) if (!state.files.has(f.id)) state.addFile(f);
  if (payload.folders) for (const f of payload.folders) if (!state.folders.has(f.id)) state.addFolder(f);
});

// fs-folder-create
signaling.on('fs-folder-create' as never, (msg) => {
  const folder = msg.payload as SharedFolder;
  if (!state.folders.has(folder.id)) state.addFolder(folder);
});

// fs-folder-delete
signaling.on('fs-folder-delete' as never, (msg) => {
  const payload = msg.payload as { folderId: string };
  state.deleteFolder(payload.folderId);
});

// WebRTC signaling for file transfer peer connections
signaling.on('fs-offer' as never, async (msg) => {
  const payload = msg.payload as { sdp: RTCSessionDescriptionInit };
  const fromId = msg.from!;
  const pt = getOrCreatePeer(fromId);
  await pt.handleOffer(payload.sdp);
  elTransport.textContent = 'P2P';
});

signaling.on('fs-answer' as never, async (msg) => {
  const payload = msg.payload as { sdp: RTCSessionDescriptionInit };
  const pt = getPeer(msg.from!);
  if (pt) await pt.handleAnswer(payload.sdp);
  elTransport.textContent = 'P2P';
});

signaling.on('fs-ice' as never, async (msg) => {
  const payload = msg.payload as { candidate: RTCIceCandidateInit };
  const pt = getPeer(msg.from!);
  if (pt) await pt.handleIce(payload.candidate);
});

// Register own local files with any new peer
function registerLocalFilesWithPeer(pt: PeerTransfer) {
  for (const f of state.files.values()) {
    if (f.ownerId === myUserId && f.localFile) {
      pt.registerLocalFile(f.id, f.localFile);
    }
  }
}

// ── State change → re-render ──────────────────────────────────────────────────
state.on((e) => {
  if (e.type === 'files-changed')   renderFileList();
  if (e.type === 'folders-changed') { renderFolderTree(); renderFileList(); }
  if (e.type === 'members-changed') renderMembers();
});

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg: string) {
  const el = document.createElement('div');
  el.className = 'ft-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('ft-toast--show'));
  setTimeout(() => {
    el.classList.remove('ft-toast--show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ── XSS-safe text escaping ────────────────────────────────────────────────────
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  if (!ROOM_ID) { window.location.href = '/'; return; }

  initLangSwitcher();
  initRoomDisplay();

  // Detect local file server (Desktop Agent) — optional LAN fast path
  detectLocalFileServer();

  // Re-render translatable dynamic content when language changes
  window.addEventListener('langchange', () => {
    applyTranslations();
    renderFolderTree();
    renderFileList();
    renderMembers();
    // Refresh speed slider labels
    elUlLabel.textContent = stepLabel(parseInt(elUlSlider.value, 10));
    elDlLabel.textContent = stepLabel(parseInt(elDlSlider.value, 10));
  });

  try {
    await signaling.connect();
  } catch {
    showToast(t('ft.toast.connect_fail'));
    return;
  }

  signaling.join({ roomId: ROOM_ID, name: MY_NAME, role: 'host' }); // everyone is equal in file transfer rooms
}

document.addEventListener('DOMContentLoaded', init);
