import { SignalingClient } from '../signaling/SignalingClient';
import { HostConnectionManager } from '../webrtc/HostConnection';
import { ViewerConnection } from '../webrtc/ViewerConnection';
import { SwapSession } from '../webrtc/SwapSession';
import { InputCapture } from '../webrtc/InputCapture';
import { captureScreen, stopStream } from '../webrtc/ScreenCapture';
import { ChatManager } from '../webrtc/ChatManager';
import { FileTransferManager } from '../webrtc/FileTransfer';
import { StatsMonitor } from '../webrtc/StatsMonitor';
import { CursorSync } from '../webrtc/CursorSync';
import { LaserPointer } from '../webrtc/LaserPointer';
import { AnnotationOverlay, type AnnTool } from '../webrtc/AnnotationOverlay';
import { ClipboardSync } from '../webrtc/ClipboardSync';
import { roomCryptoFromHash, type RoomCrypto } from '../crypto/RoomCrypto';
import { AudioManager } from '../webrtc/AudioManager';
import { RecordingManager } from '../webrtc/RecordingManager';
import { makeDCMessage } from '../webrtc/DataChannelProtocol';
import { UserList } from '../ui/UserList';
import { VideoViewer } from '../ui/VideoViewer';
import { ControlBar } from '../ui/ControlBar';
import { NotificationToast } from '../ui/NotificationToast';
import { ChatPanel } from '../ui/ChatPanel';
import { FileTransferPanel } from '../ui/FileTransferPanel';
import { StatsStrip } from '../ui/StatsStrip';
import { PermissionPanel } from '../ui/PermissionPanel';
import { CursorOverlay } from '../ui/CursorOverlay';
import { LaserPointerOverlay } from '../ui/LaserPointerOverlay';
import { ControlSafetyBanner } from '../ui/ControlSafetyBanner';
import { RecordingIndicator } from '../ui/RecordingIndicator';
import { SessionNotes } from '../ui/SessionNotes';
import { t, applyTranslations } from '../i18n';
import { initLangSwitcher } from '../ui/LangSwitcher';
import type {
  RoomUser, RoomStatePayload, UserEventPayload, UserLeftPayload, JoinedPayload,
  RemoteInputEvent,
} from '../types/signaling';
import type { DCMessage } from '../webrtc/DataChannelProtocol';

function getParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    roomId: p.get('roomId') ?? '',
    name: p.get('name') ?? 'Anonymous',
    role: (p.get('role') ?? 'viewer') as 'host' | 'viewer',
  };
}

function getWsUrl(): string {
  if (import.meta.env.PROD && import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL as string;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

async function init() {
  initLangSwitcher();

  const { roomId, name, role } = getParams();
  if (!roomId) { window.location.href = '/'; return; }

  // ---- DOM refs ----
  document.getElementById('room-id-display')!.textContent = roomId;
  const statusEl = document.getElementById('connection-status')!;
  const statusDot = document.getElementById('status-dot')!;
  const swapBadgeWrap = document.getElementById('swap-badge-wrap')!;

  // ---- State ----
  let myId = '';
  let screenStream: MediaStream | null = null;
  let swapStream: MediaStream | null = null;
  let swapActive = false;
  let inputCapture: InputCapture | null = null;
  let hostConn: HostConnectionManager | null = null;
  let viewerConn: ViewerConnection | null = null;
  let swapSession: SwapSession | null = null;
  let agentWs: WebSocket | null = null;
  let agentDotEl: HTMLElement | null = null;
  let isRecording = false;
  let micActive = false;
  let activeControllerId = '';
  let activeControlToken: string | null = null; // server-issued token for current control session

  // Shared secret between agent and this page — must match AGENT_SECRET env var on the agent
  const AGENT_SECRET = (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string> }).env?.VITE_AGENT_SECRET) ?? 'screenmirror';

  const roomUsers = new Map<string, RoomUser>();
  const viewerControlStates = new Map<string, 'none' | 'requested' | 'granted'>();
  const statsMonitors = new Map<string, StatsMonitor>();

  // ---- Feature managers (assigned after join) ----
  let chatManager: ChatManager | null = null;
  let fileTransfer: FileTransferManager | null = null;
  let clipboardSync: ClipboardSync | null = null;
  let chatPanel: ChatPanel | null = null;
  let filePanel: FileTransferPanel | null = null;
  let statsStrip: StatsStrip | null = null;
  let sessionNotes: SessionNotes | null = null;

  // Host-only
  let permPanel: PermissionPanel | null = null;
  let cursorOverlay: CursorOverlay | null = null;
  let laserOverlay: LaserPointerOverlay | null = null;
  let recordingManager: RecordingManager | null = null;
  let recIndicator: RecordingIndicator | null = null;
  let safetyBanner: ControlSafetyBanner | null = null;
  let audioManager: AudioManager | null = null;

  // Viewer-only
  let cursorSync: CursorSync | null = null;
  let laserPointer: LaserPointer | null = null;
  let viewerRecIndicator: RecordingIndicator | null = null;

  // Both roles
  let annotationOverlay: AnnotationOverlay | null = null;
  let roomCrypto: RoomCrypto | null = null;

  // ---- Signaling ----
  const signaling = new SignalingClient({
    url: getWsUrl(),
    onStateChange: (state) => {
      const cls =
        state === 'connected' ? 'connected'
        : state === 'connecting' ? 'connecting'
        : 'offline';
      statusDot.className = `status-dot status-dot--${cls}`;
      statusEl.textContent =
        state === 'connected' ? t('room.connected')
        : state === 'connecting' ? t('room.connecting')
        : state === 'error' ? t('room.error')
        : t('room.disconnected');
    },
  });

  // ---- Core UI ----
  const toast = new NotificationToast();
  const videoViewer = new VideoViewer('video-container');

  // ---- UserList ----
  const userList = new UserList('user-list', {
    role,
    onGrantControl: (viewerId) => {
      hostConn?.grantControl(viewerId);
      viewerControlStates.set(viewerId, 'granted');
      userList.setControlState(viewerId, 'granted');
      activeControllerId = viewerId;
      safetyBanner?.show(roomUsers.get(viewerId)?.name ?? 'Viewer');
      toast.show({ message: `${t('room.toast.control_granted_to')} ${roomUsers.get(viewerId)?.name ?? 'viewer'}`, type: 'warning' });
    },
    onRevokeControl: (viewerId) => {
      const cur = viewerControlStates.get(viewerId);
      if (cur === 'granted') {
        hostConn?.revokeControl(viewerId);
        toast.show({ message: `${t('room.toast.control_revoked_from')} ${roomUsers.get(viewerId)?.name ?? 'viewer'}.`, type: 'info' });
        if (activeControllerId === viewerId) {
          // Disarm Desktop Agent immediately
          if (agentWs?.readyState === WebSocket.OPEN) {
            agentWs.send(JSON.stringify({ type: 'disarm' }));
          }
          activeControlToken = null;
        }
      } else {
        hostConn?.denyControl(viewerId);
      }
      viewerControlStates.set(viewerId, 'none');
      userList.setControlState(viewerId, 'none');
      if (activeControllerId === viewerId) { activeControllerId = ''; safetyBanner?.hide(); }
    },

  });

  // ---- ControlBar ----
  const controlBar = new ControlBar('control-bar', {
    role,
    onFit: (mode) => videoViewer.setFit(mode),
    onFullscreen: () => videoViewer.enterFullscreen(),
    onRequestControl: role === 'viewer' ? () => {
      viewerConn?.requestControl();
      controlBar.setControlState('requested');
    } : undefined,
    onSwapToggle: role === 'viewer' ? () => { swapActive ? stopSwap() : startSwap(); } : undefined,
    onShareScreen: role === 'host' ? startShare : undefined,
    onStopShare: role === 'host' ? stopShare : undefined,
  });

  // Extra controlbar buttons appended after ControlBar renders
  buildExtraButtons();

  // Chat toggle
  document.getElementById('chat-toggle-btn')!.addEventListener('click', () => chatPanel?.toggle());

  // ---- Signaling handlers ----
  signaling.on('joined', (msg) => {
    const payload = msg.payload as JoinedPayload;
    myId = payload.userId;
    userList.setMyId(myId);

    // Initialize shared managers
    chatManager = new ChatManager(myId, name);
    fileTransfer = new FileTransferManager();
    clipboardSync = new ClipboardSync();

    filePanel = new FileTransferPanel('file-transfer-wrap', (fileId) => {
      if (!fileTransfer) return;
      if (role === 'host') fileTransfer.cancel(fileId, (m) => hostConn?.broadcastDC(m));
      else fileTransfer.cancel(fileId, (m) => viewerConn?.sendDC(m));
    });

    fileTransfer.on((progress) => filePanel?.update(progress));

    chatPanel = new ChatPanel('chat-panel', (text) => {
      if (!chatManager) return;
      const outMsg = chatManager.buildMessage(text);
      if (role === 'host') hostConn?.broadcastDC(outMsg);
      else viewerConn?.sendDC(outMsg);
    });

    chatManager.on((chatMsg) => chatPanel?.appendMessage(chatMsg));

    chatPanel.onUnread((n) => {
      const badge = document.getElementById('chat-unread-badge')!;
      if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.removeAttribute('hidden'); }
      else badge.setAttribute('hidden', '');
    });

    // Stats strip
    statsStrip = new StatsStrip('stats-strip-wrap');

    // Session notes
    const notesSection = document.getElementById('notes-section')!;
    notesSection.removeAttribute('hidden');
    sessionNotes = new SessionNotes('session-notes', `${roomId}_${myId}`);

    // Annotation overlay (both roles share same canvas logic)
    const videoContainer = document.getElementById('video-container')!;
    const sendAnnotation = (m: DCMessage) => {
      if (role === 'host') hostConn?.broadcastDC(m);
      else viewerConn?.sendDC(m);
    };
    annotationOverlay = new AnnotationOverlay(videoContainer, myId, name, sendAnnotation);

    if (role === 'host') {
      hostConn = new HostConnectionManager(signaling, myId);
      wireHostEvents();
      setupHostUI();
    } else {
      viewerConn = new ViewerConnection(signaling);
      wireViewerEvents();
    }
  });

  signaling.on('room-state', (msg) => {
    const payload = msg.payload as RoomStatePayload;
    roomUsers.clear();
    payload.users.forEach((u) => roomUsers.set(u.id, u));
    userList.setUsers(payload.users);
  });

  signaling.on('user-joined', (msg) => {
    const payload = msg.payload as UserEventPayload;
    roomUsers.set(payload.user.id, payload.user);
    userList.addUser(payload.user);

    if (role === 'host' && payload.user.role === 'viewer') {
      if (screenStream) hostConn?.initiateOffer(payload.user.id);
      else toast.show({ message: `${payload.user.name} ${t('room.toast.viewer_joined')}`, type: 'info' });
    } else if (role === 'viewer' && payload.user.role === 'host') {
      toast.show({ message: t('room.toast.host_connected'), type: 'success' });
    }
  });

  signaling.on('user-left', (msg) => {
    const payload = msg.payload as UserLeftPayload;
    const leaving = roomUsers.get(payload.userId);
    roomUsers.delete(payload.userId);
    viewerControlStates.delete(payload.userId);
    userList.removeUser(payload.userId);

    if (role === 'host') {
      statsMonitors.get(payload.userId)?.stop();
      statsMonitors.delete(payload.userId);
      permPanel?.removeViewer(payload.userId);
      cursorOverlay?.removeCursor(payload.userId);
      hostConn?.closeSession(payload.userId);
      if (activeControllerId === payload.userId) { activeControllerId = ''; safetyBanner?.hide(); }
      if (leaving) toast.show({ message: `${leaving.name} ${t('room.toast.user_left')}`, type: 'info' });
    }
  });

  // Server-issued control token — host receives this after granting control, then arms the agent
  signaling.on('control-token', (msg) => {
    if (role !== 'host') return;
    const { token, viewerId } = msg.payload as { token: string; viewerId: string };
    activeControlToken = token;
    activeControllerId = viewerId;
    // Arm the Desktop Agent with the new token
    if (agentWs?.readyState === WebSocket.OPEN) {
      agentWs.send(JSON.stringify({ type: 'arm', token }));
    }
  });

  // Handle server errors — specifically PIN challenges during join
  signaling.on('error', (msg) => {
    const { message } = msg.payload as { message: string };
    // Only intercept pre-join errors (myId not yet assigned)
    if (myId) return;
    if (message === 'PIN required' || message === 'Invalid PIN') {
      const prompt = message === 'Invalid PIN'
        ? t('room.pin_incorrect')
        : t('room.pin_required');
      const pin = window.prompt(prompt);
      if (pin) {
        signaling.join({ roomId, name, role, pin });
      }
      return;
    }
    toast.show({ message, type: 'danger', duration: 0 });
  });

  signaling.on('control-request', (msg) => {
    if (role !== 'host' || !msg.from) return;
    const viewerId = msg.from;
    const viewerName = roomUsers.get(viewerId)?.name ?? 'A viewer';
    viewerControlStates.set(viewerId, 'requested');
    userList.setControlState(viewerId, 'requested');
    toast.show({
      message: `${viewerName} ${t('room.toast.control_request')}`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: t('room.toast.allow'),
          variant: 'primary',
          onClick: () => {
            hostConn?.grantControl(viewerId);
            viewerControlStates.set(viewerId, 'granted');
            userList.setControlState(viewerId, 'granted');
            activeControllerId = viewerId;
            safetyBanner?.show(viewerName);
          },
        },
        {
          label: t('room.toast.deny'),
          variant: 'danger',
          onClick: () => {
            hostConn?.denyControl(viewerId);
            viewerControlStates.set(viewerId, 'none');
            userList.setControlState(viewerId, 'none');
          },
        },
      ],
    });
  });

  // ---- Host event wiring ----
  function wireHostEvents() {
    if (!hostConn) return;
    hostConn.on((event) => {
      if (event.type === 'viewer-connected') {
        const pc = hostConn!.getPeerConnection(event.peerId);
        if (pc) {
          const monitor = new StatsMonitor(pc);
          statsMonitors.set(event.peerId, monitor);
          monitor.on((s) => statsStrip?.update(s));
          monitor.start();
        }
        const perms = hostConn!.getPermissions(event.peerId);
        if (perms) permPanel?.setViewer(event.peerId, roomUsers.get(event.peerId)?.name ?? 'Viewer', perms);

      } else if (event.type === 'viewer-disconnected') {
        statsMonitors.get(event.peerId)?.stop();
        statsMonitors.delete(event.peerId);
        permPanel?.removeViewer(event.peerId);
        cursorOverlay?.removeCursor(event.peerId);
        if (activeControllerId === event.peerId) { activeControllerId = ''; safetyBanner?.hide(); }

      } else if (event.type === 'dc-message') {
        handleHostDCMessage(event.peerId, event.message);

      } else if (event.type === 'swap-stream') {
        videoViewer.setSecondaryStream(event.stream, `${roomUsers.get(event.peerId)?.name ?? 'Viewer'}'s screen`);
        toast.show({ message: `${roomUsers.get(event.peerId)?.name ?? 'Viewer'} started swap mode.`, type: 'info' });

      } else if (event.type === 'swap-ended') {
        videoViewer.clearSecondaryStream();
      }
    });
  }

  function handleHostDCMessage(viewerId: string, msg: DCMessage) {
    const viewerName = roomUsers.get(viewerId)?.name ?? 'Viewer';
    switch (msg.type) {
      case 'input':
        forwardToAgent(msg.payload as RemoteInputEvent);
        break;
      case 'cursor': {
        const p = msg.payload as { x: number; y: number; senderName?: string };
        cursorOverlay?.updateCursor(viewerId, p.senderName ?? viewerName, p.x, p.y);
        break;
      }
      case 'laser': {
        const p = msg.payload as { x: number; y: number; senderName?: string };
        laserOverlay?.update(viewerId, p.senderName ?? viewerName, p.x, p.y);
        break;
      }
      case 'annotation-draw':
      case 'annotation-clear':
        annotationOverlay?.receive(msg);
        hostConn!.broadcastDC(msg, viewerId); // relay to all other viewers
        break;
      case 'chat':
        chatManager?.receive(msg);
        hostConn!.broadcastDC(msg, viewerId); // relay to all other viewers
        break;
      case 'clipboard-push':
        receiveClipboard(msg, viewerName);
        break;
      case 'file-offer':
      case 'file-accept':
      case 'file-reject':
      case 'file-chunk':
      case 'file-cancel':
        fileTransfer?.handleMessage(msg, (m) => hostConn!.sendDC(viewerId, m));
        break;
    }
  }

  async function receiveClipboard(msg: DCMessage, fromName: string) {
    let text = (msg.payload as { text: string }).text;
    if (roomCrypto) {
      const decrypted = await roomCrypto.decrypt(text);
      if (decrypted !== null) text = decrypted;
    }
    const synced = await clipboardSync?.receive({ ...msg, payload: { text } });
    if (synced) {
      const clipMsg = fromName === 'host'
        ? t('room.toast.clipboard_from_host')
        : `${t('room.toast.clipboard_from')} ${fromName}`;
      toast.show({ message: clipMsg, type: 'success' });
    }
  }

  function setupHostUI() {
    // Desktop Agent
    renderAgentBanner();
    connectAgent();

    // Permission panel
    document.getElementById('perm-section')!.removeAttribute('hidden');
    permPanel = new PermissionPanel('perm-panel', (viewerId, patch) => {
      hostConn?.updatePermissions(viewerId, patch);
    });

    // Cursor overlay
    cursorOverlay = new CursorOverlay('video-container');
    // Laser pointer overlay
    laserOverlay = new LaserPointerOverlay('video-container');

    // Recording
    recordingManager = new RecordingManager();
    recIndicator = new RecordingIndicator('rec-indicator-wrap');
    recordingManager.on((state) => {
      if (state === 'started') {
        recIndicator?.start();
        hostConn?.broadcastDC(makeDCMessage('recording-start', {}, myId));
      } else {
        recIndicator?.stop();
        hostConn?.broadcastDC(makeDCMessage('recording-stop', {}, myId));
      }
    });

    // Audio
    audioManager = new AudioManager((track, stream) => {
      for (const u of roomUsers.values()) {
        if (u.role === 'viewer') hostConn!.getPeerConnection(u.id)?.addTrack(track, stream);
      }
    });

    // Safety banner — emergency stop always disarms the agent immediately
    safetyBanner = new ControlSafetyBanner(() => {
      if (!activeControllerId) return;
      hostConn?.revokeControl(activeControllerId);
      viewerControlStates.set(activeControllerId, 'none');
      userList.setControlState(activeControllerId, 'none');
      toast.show({ message: 'Remote control stopped.', type: 'info' });
      // Disarm agent immediately — don't wait for signaling round-trip
      if (agentWs?.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ type: 'emergency-stop' }));
      }
      activeControlToken = null;
      activeControllerId = '';
      safetyBanner?.hide();
      toast.show({ message: t('room.toast.control_stopped'), type: 'info' });
    });
  }

  // ---- Viewer event wiring ----
  function wireViewerEvents() {
    if (!viewerConn) return;
    viewerConn.on((event) => {
      if (event.type === 'stream') {
        videoViewer.setStream(event.stream);
        videoViewer.hidePlaceholder();
        const pc = viewerConn!.peerConnection;
        if (pc) {
          const monitor = new StatsMonitor(pc);
          monitor.on((s) => statsStrip?.update(s));
          monitor.start();
        }
        // Start laser pointer once we have a stream to point at
        laserPointer = new LaserPointer(videoViewer.getContainer(), (m) => viewerConn!.sendDC(m), myId, name);
        laserPointer.enable();
      } else if (event.type === 'control-granted') {
        controlBar.setControlState('granted');
        toast.show({ message: t('room.toast.control_granted'), type: 'success' });
        inputCapture = new InputCapture(videoViewer.getContainer(), (e) => {
          viewerConn!.sendDC(makeDCMessage('input', e, myId));
        });
        inputCapture.enable();
        cursorSync = new CursorSync(videoViewer.getContainer(), (m) => viewerConn!.sendDC(m), myId, name);
        cursorSync.enable();
      } else if (event.type === 'control-denied') {
        controlBar.setControlState('none');
        toast.show({ message: t('room.toast.control_denied'), type: 'danger' });
      } else if (event.type === 'control-revoked') {
        controlBar.setControlState('none');
        inputCapture?.disable(); inputCapture = null;
        cursorSync?.disable(); cursorSync = null;
        toast.show({ message: t('room.toast.control_revoked'), type: 'warning' });
      } else if (event.type === 'dc-message') {
        handleViewerDCMessage(event.message);
      }
    });
  }

  function handleViewerDCMessage(msg: DCMessage) {
    switch (msg.type) {
      case 'chat':
        chatManager?.receive(msg);
        break;
      case 'annotation-draw':
      case 'annotation-clear':
        annotationOverlay?.receive(msg);
        break;
      case 'clipboard-push':
        receiveClipboard(msg, 'host');
        break;
      case 'file-offer':
      case 'file-accept':
      case 'file-reject':
      case 'file-chunk':
      case 'file-cancel':
        fileTransfer?.handleMessage(msg, (m) => viewerConn!.sendDC(m));
        break;
      case 'recording-start':
        if (!viewerRecIndicator) viewerRecIndicator = new RecordingIndicator('rec-indicator-wrap');
        viewerRecIndicator.start();
        toast.show({ message: t('room.toast.host_recording'), type: 'warning' });
        break;
      case 'recording-stop':
        viewerRecIndicator?.stop();
        break;
    }
  }

  // ---- Swap mode ----
  async function startSwap() {
    const hostUser = Array.from(roomUsers.values()).find((u) => u.role === 'host');
    if (!hostUser) { toast.show({ message: t('room.toast.no_host'), type: 'warning' }); return; }
    const stream = await captureScreen();
    if (!stream) { toast.show({ message: t('room.toast.screen_cancelled'), type: 'warning' }); return; }
    swapStream = stream;
    swapActive = true;
    controlBar.setSwapState(true);
    swapBadgeWrap.innerHTML = '<span class="swap-badge">⇌ Swap Active</span>';
    swapSession = new SwapSession(signaling, hostUser.id);
    await swapSession.start(stream);
    toast.show({ message: t('room.toast.swap_started'), type: 'success' });
    stream.getVideoTracks()[0].addEventListener('ended', stopSwap);
  }

  function stopSwap() {
    swapSession?.stop(); swapSession = null;
    stopStream(swapStream); swapStream = null;
    swapActive = false;
    controlBar.setSwapState(false);
    swapBadgeWrap.innerHTML = '';
    toast.show({ message: t('room.toast.swap_stopped'), type: 'info' });
  }

  // ---- Screen sharing ----
  async function startShare() {
    const stream = await captureScreen();
    if (!stream) { toast.show({ message: t('room.toast.screen_cancelled'), type: 'warning' }); return; }
    screenStream = stream;
    controlBar.setShareState(true);
    hostConn?.setStream(stream);
    for (const user of roomUsers.values()) {
      if (user.role === 'viewer') hostConn?.initiateOffer(user.id);
    }
    stream.getVideoTracks()[0].addEventListener('ended', stopShare);
  }

  function stopShare() {
    stopStream(screenStream); screenStream = null;
    controlBar.setShareState(false);
    if (isRecording) { recordingManager?.stop(); isRecording = false; }
    toast.show({ message: t('room.toast.screen_stopped'), type: 'info' });
  }

  // ---- Desktop Agent ----
  function connectAgent() {
    try {
      agentWs = new WebSocket('ws://localhost:9001');

      agentWs.onopen = () => {
        // Authenticate immediately on connect
        agentWs!.send(JSON.stringify({ type: 'auth', secret: AGENT_SECRET }));
      };

      agentWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string };
          if (msg.type === 'auth-ok') {
            updateAgentBanner(true);
            // If a viewer already has control (e.g. agent reconnected), re-arm
            if (activeControlToken && activeControllerId) {
              agentWs!.send(JSON.stringify({ type: 'arm', token: activeControlToken }));
            }
          }
        } catch { /* ignore non-JSON messages */ }
      };

      agentWs.onclose = () => {
        // Auto-revoke control if agent disconnects while a viewer has it
        if (activeControllerId) {
          hostConn?.revokeControl(activeControllerId);
          viewerControlStates.set(activeControllerId, 'none');
          userList.setControlState(activeControllerId, 'none');
          toast.show({ message: t('room.toast.agent_disconnected'), type: 'danger', duration: 0 });
          activeControllerId = '';
          activeControlToken = null;
          safetyBanner?.hide();
        }
        agentWs = null;
        updateAgentBanner(false);
      };

      agentWs.onerror = () => { agentWs = null; updateAgentBanner(false); };
    } catch {
      agentWs = null;
    }
  }

  function renderAgentBanner() {
    const wrap = document.getElementById('agent-banner-wrap')!;
    wrap.innerHTML = `
      <div class="agent-banner" style="margin-bottom:16px">
        <div class="agent-banner-header">
          <span class="agent-dot agent-dot--offline" id="agent-status-dot"></span>
          Desktop Agent
        </div>
        <p class="agent-banner-desc">
          Run the Desktop Agent locally to enable OS-level mouse &amp; keyboard control when a viewer gets control access.
        </p>
      </div>`;
    agentDotEl = document.getElementById('agent-status-dot');
  }

  function updateAgentBanner(online: boolean) {
    if (agentDotEl) agentDotEl.className = `agent-dot agent-dot--${online ? 'online' : 'offline'}`;
    if (online) toast.show({ message: t('room.toast.agent_connected'), type: 'success' });
  }

  function forwardToAgent(e: RemoteInputEvent) {
    if (!agentWs || agentWs.readyState !== WebSocket.OPEN) return;
    // Do not forward if no active control token (agent will reject anyway, but fail-fast here)
    if (!activeControlToken) return;

    const mods: string[] = [];
    if (e.modifiers?.ctrl) mods.push('ctrl');
    if (e.modifiers?.alt) mods.push('alt');
    if (e.modifiers?.shift) mods.push('shift');
    if (e.modifiers?.meta) mods.push('meta');

    // Include token in every input message — agent validates it
    const token = activeControlToken;
    let msg: object;
    switch (e.type) {
      case 'mousemove': msg = { type: 'mousemove', x: e.x, y: e.y, token }; break;
      case 'mousedown': msg = { type: 'mousedown', x: e.x, y: e.y, button: e.button, token }; break;
      case 'mouseup':   msg = { type: 'mouseup', x: e.x, y: e.y, button: e.button, token }; break;
      case 'wheel':     msg = { type: 'wheel', x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY, token }; break;
      case 'keydown':   msg = { type: 'keydown', key: e.key, modifiers: mods, token }; break;
      case 'keyup':     msg = { type: 'keyup', key: e.key, modifiers: mods, token }; break;
      default: return;
    }
    agentWs.send(JSON.stringify(msg));
  }

  // ---- Quick Support code generation (host) ----
  async function generateQuickCode() {
    try {
      const res = await fetch('/api/quick/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, hostId: myId }),
      });
      if (!res.ok) throw new Error('failed');
      const { code } = await res.json() as { code: string };
      toast.show({
        message: `Quick Code: ${code}  (valid 10 min)`,
        type: 'success',
        duration: 15_000,
      });
    } catch {
      toast.show({ message: t('room.toast.quick_code_fail'), type: 'danger' });
    }
  }

  // ---- Extra controlbar buttons ----
  function buildExtraButtons() {
    const cbRight = document.querySelector<HTMLElement>('#control-bar .controlbar-right');
    if (!cbRight) return;

    if (role === 'host') {
      // Mic toggle
      const micBtn = createBtn(micIcon(false), t('room.btn.mic'));
      micBtn.addEventListener('click', async () => {
        if (!audioManager) return;
        if (micActive) {
          audioManager.disableMicrophone();
          micActive = false;
          micBtn.innerHTML = micIcon(false);
          micBtn.classList.remove('btn--active');
        } else {
          const ok = await audioManager.enableMicrophone();
          if (ok) { micActive = true; micBtn.innerHTML = micIcon(true); micBtn.classList.add('btn--active'); }
          else toast.show({ message: t('room.toast.mic_denied'), type: 'danger' });
        }
      });

      // Record toggle
      const recBtn = createBtn(recIcon(), t('room.btn.record'));
      recBtn.addEventListener('click', () => {
        if (!recordingManager) return;
        if (isRecording) {
          recordingManager.stop();
          isRecording = false;
          recBtn.classList.remove('btn--active');
        } else {
          if (!screenStream) { toast.show({ message: t('room.toast.record_before_share'), type: 'warning' }); return; }
          const participants = Array.from(roomUsers.values()).map((u) => u.name);
          recordingManager.start(screenStream, participants, roomId);
          isRecording = true;
          recBtn.classList.add('btn--active');
        }
      });

      // Quick Code
      const codeBtn = createBtn('# Code', t('room.btn.quick_code'));
      codeBtn.addEventListener('click', generateQuickCode);

      cbRight.appendChild(micBtn);
      cbRight.appendChild(recBtn);
      cbRight.appendChild(codeBtn);
    }

    // ── Annotation toolbar (both roles) ──────────────────────────
    const annBtn = createBtn(annIcon(), t('room.btn.annotate'));
    let annEnabled = false;
    annBtn.addEventListener('click', () => {
      annEnabled = !annEnabled;
      if (annEnabled) { annotationOverlay?.enable(); annBtn.classList.add('btn--active'); }
      else { annotationOverlay?.disable(); annBtn.classList.remove('btn--active'); }
    });

    // Tool selector (pen/arrow/rect)
    const toolSelect = document.createElement('select');
    toolSelect.className = 'ann-tool-select';
    toolSelect.innerHTML = `<option value="pen">✏️ Pen</option><option value="arrow">➡️ Arrow</option><option value="rect">▭ Rect</option>`;
    toolSelect.addEventListener('change', () => annotationOverlay?.setTool(toolSelect.value as AnnTool));

    // Clear own
    const clearOwnBtn = createBtn(t('room.btn.clear_mine'), t('room.btn.clear_mine'));
    clearOwnBtn.addEventListener('click', () => annotationOverlay?.clearOwn());

    // Clear all (host only)
    if (role === 'host') {
      const clearAllBtn = createBtn(t('room.btn.clear_all'), t('room.btn.clear_all'));
      clearAllBtn.addEventListener('click', () => annotationOverlay?.clearAll());
      cbRight.appendChild(clearAllBtn);
    }

    cbRight.appendChild(annBtn);
    cbRight.appendChild(toolSelect);
    cbRight.appendChild(clearOwnBtn);

    // ── Clipboard (both roles, with optional encryption) ─────────
    const clipBtn = createBtn(clipIcon(), t('room.btn.clipboard'));
    clipBtn.addEventListener('click', async () => {
      const cs = clipboardSync;
      if (!cs) return;
      const sendFn = async (m: DCMessage) => {
        if (roomCrypto && m.type === 'clipboard-push') {
          const payload = m.payload as { text: string };
          const encrypted = await roomCrypto.encrypt(payload.text);
          m = { ...m, payload: { text: encrypted } };
        }
        if (role === 'host') hostConn?.broadcastDC(m);
        else viewerConn?.sendDC(m);
      };
      const ok = await cs.push(sendFn, myId);
      toast.show({ message: ok ? t('room.toast.clipboard_pushed') : t('room.toast.clipboard_denied'), type: ok ? 'success' : 'warning' });
    });

    // Auto-push clipboard on copy event (opt-in: only if user copied something)
    document.addEventListener('copy', async () => {
      const cs = clipboardSync;
      if (!cs || !myId) return;
      const sendFn = async (m: DCMessage) => {
        if (roomCrypto && m.type === 'clipboard-push') {
          const payload = m.payload as { text: string };
          const encrypted = await roomCrypto.encrypt(payload.text);
          m = { ...m, payload: { text: encrypted } };
        }
        if (role === 'host') hostConn?.broadcastDC(m);
        else viewerConn?.sendDC(m);
      };
      // Small delay to let clipboard update
      setTimeout(() => cs.push(sendFn, myId), 50);
    });

    // File send (both roles)
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    const fileBtn = createBtn(fileIcon(), t('room.btn.send_file'));
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      const ft = fileTransfer;
      if (!file || !ft) return;
      fileInput.value = '';
      let result: string | null;
      if (role === 'host') {
        const firstViewer = Array.from(roomUsers.values()).find((u) => u.role === 'viewer');
        if (!firstViewer) { toast.show({ message: t('room.toast.no_viewer'), type: 'warning' }); return; }
        result = await ft.send(file, (m) => hostConn!.sendDC(firstViewer.id, m));
      } else {
        result = await ft.send(file, (m) => viewerConn!.sendDC(m));
      }
      if (result === null) {
        toast.show({ message: t('room.toast.file_too_large'), type: 'danger' });
      }
    });

    cbRight.appendChild(clipBtn);
    cbRight.appendChild(fileBtn);
  }

  function createBtn(html: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost btn--sm';
    btn.innerHTML = html;
    btn.title = title;
    return btn;
  }

  // ---- Placeholder ----
  videoViewer.showPlaceholder(
    role === 'host' ? t('room.placeholder_host') : t('room.placeholder_viewer')
  );

  // ---- Encrypted link (key lives in URL hash, never sent to server) ----
  roomCrypto = await roomCryptoFromHash();
  if (roomCrypto) {
    const badge = document.createElement('span');
    badge.className = 'enc-badge';
    badge.title = t('room.enc_badge');
    badge.innerHTML = t('room.enc_badge');
    document.querySelector('.topbar-room-id')?.appendChild(badge);
  }

  // ---- Connect ----
  try {
    await signaling.connect();
    signaling.join({ roomId, name, role });
  } catch {
    toast.show({
      message: t('room.toast.connect_fail'),
      type: 'danger',
      duration: 0,
    });
  }

  // Re-apply translations when language changes
  window.addEventListener('langchange', () => applyTranslations());

  // ---- Cleanup ----
  window.addEventListener('beforeunload', () => {
    if (swapActive) swapSession?.stop();
    stopStream(screenStream);
    stopStream(swapStream);
    inputCapture?.disable();
    cursorSync?.disable();
    laserPointer?.disable();
    cursorOverlay?.destroy();
    laserOverlay?.destroy();
    annotationOverlay?.destroy();
    for (const m of statsMonitors.values()) m.stop();
    audioManager?.stopAll();
    if (isRecording) recordingManager?.stop();
    agentWs?.close();
    viewerConn?.close();
    hostConn?.closeAll();
    signaling.disconnect();
  });

  // ---- SVG icons ----
  function micIcon(active: boolean) {
    const fill = active ? 'currentColor' : 'none';
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  }
  function recIcon() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
  }
  function clipIcon() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M17 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
  }
  function fileIcon() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
  }
  function annIcon() {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
