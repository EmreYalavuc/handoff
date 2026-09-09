import { RoomCrypto } from '../crypto/RoomCrypto';
import { t, applyTranslations } from '../i18n';
import { initLangSwitcher } from '../ui/LangSwitcher';

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () =>
    Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

function goFileTransfer(roomId: string, name: string) {
  const params = new URLSearchParams({ roomId, name });
  window.location.href = `/filetransfer.html?${params}`;
}

async function go(roomId: string, name: string, role: 'host' | 'viewer') {
  const params = new URLSearchParams({ roomId, name, role });
  if (role === 'host') {
    const { keyB64 } = await RoomCrypto.generate();
    window.location.href = `/room.html?${params}#key=${keyB64}`;
  } else {
    window.location.href = `/room.html?${params}${location.hash}`;
  }
}

function init() {
  initLangSwitcher();

  const nameInput     = document.getElementById('name-input')      as HTMLInputElement;
  const roomIdInput   = document.getElementById('room-id-input')   as HTMLInputElement;
  const hostBtn       = document.getElementById('host-btn')         as HTMLButtonElement;
  const joinBtn       = document.getElementById('join-btn')         as HTMLButtonElement;
  const errorEl       = document.getElementById('error-msg')!;
  const quickCodeInput = document.getElementById('quick-code-input') as HTMLInputElement;
  const quickJoinBtn  = document.getElementById('quick-join-btn')   as HTMLButtonElement;
  const quickErrorEl  = document.getElementById('quick-error-msg')!;

  const showError      = (msg: string) => { errorEl.textContent = msg;      errorEl.style.display = 'block'; };
  const clearError     = () =>            { errorEl.textContent = '';        errorEl.style.display = 'none'; };
  const showQuickError = (msg: string) => { quickErrorEl.textContent = msg;  quickErrorEl.style.display = 'block'; };
  const clearQuickError = () =>           { quickErrorEl.textContent = '';   quickErrorEl.style.display = 'none'; };

  hostBtn.addEventListener('click', () => {
    clearError();
    const name = nameInput.value.trim();
    if (!name) { showError(t('home.err.enter_name')); return; }
    go(generateRoomId(), name, 'host').catch(() => showError(t('home.err.init_fail')));
  });

  joinBtn.addEventListener('click', () => {
    clearError();
    const name   = nameInput.value.trim();
    const roomId = roomIdInput.value.trim().toUpperCase();
    if (!name)   { showError(t('home.err.enter_name')); return; }
    if (!roomId) { showError(t('home.err.enter_room_id')); return; }
    if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomId)) {
      showError(t('home.err.room_id_format')); return;
    }
    go(roomId, name, 'viewer').catch(() => showError(t('home.err.join_fail')));
  });

  // Auto-format Room ID input
  roomIdInput.addEventListener('input', () => {
    let val = roomIdInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length > 3) val = val.slice(0, 3) + '-' + val.slice(3);
    if (val.length > 7) val = val.slice(0, 7) + '-' + val.slice(7);
    roomIdInput.value = val.slice(0, 11);
  });

  // Quick Support
  quickCodeInput.addEventListener('input', () => {
    let val = quickCodeInput.value.replace(/\D/g, '');
    if (val.length > 3) val = val.slice(0, 3) + ' ' + val.slice(3, 6);
    quickCodeInput.value = val;
  });

  quickJoinBtn.addEventListener('click', async () => {
    clearQuickError();
    const name = nameInput.value.trim();
    const code = quickCodeInput.value.trim();
    if (!name) { showQuickError(t('home.err.enter_name_quick')); return; }
    if (!code || code.replace(/\s/g, '').length < 6) { showQuickError(t('home.err.enter_quick_code')); return; }

    quickJoinBtn.disabled = true;
    const connectingSpan = quickJoinBtn.querySelector('[data-i18n]');
    const origKey = connectingSpan?.getAttribute('data-i18n') ?? '';
    if (connectingSpan) connectingSpan.textContent = t('home.connecting');

    try {
      const res = await fetch('/api/quick/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) { showQuickError(t('home.err.invalid_code')); return; }
      const { roomId } = await res.json() as { roomId: string };
      go(roomId, name, 'viewer');
    } catch {
      showQuickError(t('home.err.connection_error'));
    } finally {
      quickJoinBtn.disabled = false;
      if (connectingSpan) connectingSpan.textContent = t(origKey);
    }
  });

  nameInput.focus();

  // ── Mode tab switching ──────────────────────────────────────────
  const panelScreen = document.getElementById('home-panel-screen')!;
  const panelFT     = document.getElementById('home-panel-filetransfer')!;
  const tabs        = document.querySelectorAll<HTMLButtonElement>('.home-mode-tab');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t2 => t2.classList.remove('home-mode-tab--active'));
      tab.classList.add('home-mode-tab--active');
      const mode = tab.dataset['mode'];
      panelScreen.hidden = mode !== 'screen';
      panelFT.hidden     = mode !== 'filetransfer';
    });
  });

  // ── File Transfer panel ─────────────────────────────────────────
  const ftNameInput   = document.getElementById('ft-name-input')    as HTMLInputElement;
  const ftRoomIdInput = document.getElementById('ft-room-id-input') as HTMLInputElement;
  const ftCreateBtn   = document.getElementById('ft-create-btn')    as HTMLButtonElement;
  const ftJoinBtn     = document.getElementById('ft-join-btn')      as HTMLButtonElement;
  const ftErrorEl     = document.getElementById('ft-error-msg')!;

  const showFtError  = (msg: string) => { ftErrorEl.textContent = msg; ftErrorEl.style.display = 'block'; };
  const clearFtError = () =>            { ftErrorEl.textContent = ''; ftErrorEl.style.display = 'none'; };

  ftRoomIdInput.addEventListener('input', () => {
    let val = ftRoomIdInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length > 3) val = val.slice(0, 3) + '-' + val.slice(3);
    if (val.length > 7) val = val.slice(0, 7) + '-' + val.slice(7);
    ftRoomIdInput.value = val.slice(0, 11);
  });

  ftCreateBtn.addEventListener('click', () => {
    clearFtError();
    const name = ftNameInput.value.trim() || nameInput.value.trim();
    if (!name) { showFtError(t('home.err.enter_name')); return; }
    goFileTransfer(generateRoomId(), name);
  });

  ftJoinBtn.addEventListener('click', () => {
    clearFtError();
    const name   = ftNameInput.value.trim() || nameInput.value.trim();
    const roomId = ftRoomIdInput.value.trim().toUpperCase();
    if (!name)   { showFtError(t('home.err.enter_name')); return; }
    if (!roomId) { showFtError(t('home.err.enter_room_ft')); return; }
    if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomId)) {
      showFtError(t('home.err.room_id_format_short')); return;
    }
    goFileTransfer(roomId, name);
  });

  // Re-apply translations when language changes (for dynamically generated content)
  window.addEventListener('langchange', () => applyTranslations());
}

document.addEventListener('DOMContentLoaded', init);
