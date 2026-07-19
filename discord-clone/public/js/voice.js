const VoiceChat = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  const SPEAKING_THRESHOLD = 0.02; // RMS volume above this counts as "talking"
  const SPEAKING_HOLD_MS = 350;    // keep ring lit briefly between words

  let socket = null;
  let me = null;

  let connectedChannelId = null;
  let connectedChannelName = null;
  let connectedGroupId = null;
  let openGroupId = null;

  let localMicStream = null;
  let localScreenStream = null;
  let sharingScreen = false;
  let muted = false;

  const peers = {};
  const speakingDetectors = {}; // key ('self' or socketId) -> { audioCtx, source, rafId }

  function $(sel) { return document.querySelector(sel); }

  // ============ PUBLIC API ============

  function init(_socket, _me) {
    socket = _socket;
    me = _me;

    socket.on('voice:existing-peers', ({ peers: list }) => {
      list.forEach((p) => connectToPeer(p.socketId, p, true));
      renderParticipants();
    });

    socket.on('voice:peer-joined', (p) => {
      connectToPeer(p.socketId, p, false);
      renderParticipants();
    });

    socket.on('voice:peer-left', ({ socketId }) => {
      teardownPeer(socketId);
      renderParticipants();
    });

    socket.on('voice:peer-screen-update', ({ socketId, sharing }) => {
      if (peers[socketId]) peers[socketId].info.sharing = sharing;
      if (!sharing) removeRemoteVideoTile(socketId);
      renderParticipants();
    });

    socket.on('voice:signal', async ({ from, data }) => {
      const entry = peers[from];
      if (!entry) return;
      const pc = entry.pc;
      try {
        if (data.description) {
          const isOffer = data.description.type === 'offer';
          const collision = isOffer && (entry.makingOffer || pc.signalingState !== 'stable');
          entry.ignoreOffer = !entry.polite && collision;
          if (entry.ignoreOffer) return;

          await pc.setRemoteDescription(data.description);
          if (isOffer) {
            await pc.setLocalDescription();
            socket.emit('voice:signal', { to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!entry.ignoreOffer) console.error('addIceCandidate failed', err);
          }
        }
      } catch (err) {
        console.error('voice:signal handling error', err);
      }
    });

    socket.on('disconnect', () => {
      connectedChannelId = null;
      connectedGroupId = null;
      Object.keys(peers).forEach(teardownPeer);
      stopSpeakingDetection('self');
    });
  }

  function refreshPanelForGroup(groupId) {
    openGroupId = groupId;
    const panel = $('#voice-panel');
    if (!panel) return;

    const visible = connectedChannelId && connectedGroupId === groupId;
    panel.classList.toggle('hidden', !visible);
    if (visible) {
      $('#voice-controls').classList.remove('hidden');
      updateMuteButton();
      updateShareButton();
      renderParticipants();
    }
  }

  function isConnectedTo(channelId) {
    return connectedChannelId === channelId;
  }

  function isConnectedToGroup(groupId) {
    return connectedChannelId && connectedGroupId === groupId;
  }

  async function joinChannel(channelId, channelName, groupId) {
    if (connectedChannelId === channelId) return;
    if (connectedChannelId) await leaveCurrent();

    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Couldn't access your microphone: " + err.message);
      return;
    }

    muted = false;
    connectedChannelId = channelId;
    connectedChannelName = channelName;
    connectedGroupId = groupId;
    socket.emit('voice:join', { channelId });

    startSpeakingDetection('self', localMicStream);

    if (typeof Groups !== 'undefined') Groups.refreshChannelHighlight();
    refreshPanelForGroup(openGroupId);
  }

  async function leaveCurrent() {
    if (!connectedChannelId) return;
    const cid = connectedChannelId;
    const gid = connectedGroupId;

    socket.emit('voice:leave', { channelId: cid });
    Object.keys(peers).forEach(teardownPeer);
    stopSpeakingDetection('self');

    if (localMicStream) {
      localMicStream.getTracks().forEach((t) => t.stop());
      localMicStream = null;
    }
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => t.stop());
      localScreenStream = null;
    }
    sharingScreen = false;
    muted = false;
    connectedChannelId = null;
    connectedChannelName = null;
    connectedGroupId = null;

    clearVideoGrid();

    if (typeof Groups !== 'undefined') Groups.refreshChannelHighlight();
    refreshPanelForGroup(openGroupId);
    void gid;
  }

  function toggleMute() {
    if (!localMicStream) return;
    muted = !muted;
    localMicStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    updateMuteButton();
  }

  async function toggleScreenShare() {
    if (!connectedChannelId) return;
    if (sharingScreen) {
      stopScreenShare();
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      return;
    }

    const track = localScreenStream.getVideoTracks()[0];
    track.onended = () => stopScreenShare();

    Object.values(peers).forEach(({ pc }) => pc.addTrack(track, localScreenStream));

    sharingScreen = true;
    socket.emit('voice:screen-share-toggle', { channelId: connectedChannelId, sharing: true });
    showLocalVideoTile(localScreenStream);
    updateShareButton();
    renderParticipants();
  }

  function stopScreenShare() {
    if (!sharingScreen) return;

    Object.values(peers).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) pc.removeTrack(sender);
    });

    if (localScreenStream) localScreenStream.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
    sharingScreen = false;

    if (connectedChannelId) socket.emit('voice:screen-share-toggle', { channelId: connectedChannelId, sharing: false });
    removeLocalVideoTile();
    updateShareButton();
    renderParticipants();
  }

  // ============ INTERNAL: PEER CONNECTIONS ============

  function connectToPeer(socketId, info, isInitiator) {
    if (peers[socketId]) return;

    const polite = socket.id > socketId;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, polite, makingOffer: false, ignoreOffer: false, info: { ...info }, videoEl: null };
    peers[socketId] = entry;

    if (localMicStream) {
      localMicStream.getTracks().forEach((t) => pc.addTrack(t, localMicStream));
    }
    if (sharingScreen && localScreenStream) {
      localScreenStream.getTracks().forEach((t) => pc.addTrack(t, localScreenStream));
    }

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('voice:signal', { to: socketId, data: { description: pc.localDescription } });
      } catch (err) {
        console.error('negotiation error', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('voice:signal', { to: socketId, data: { candidate } });
    };

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        let audioEl = document.getElementById(`voice-audio-${socketId}`);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = `voice-audio-${socketId}`;
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);
        }
        const stream = event.streams[0] || new MediaStream([event.track]);
        audioEl.srcObject = stream;
        startSpeakingDetection(socketId, stream);
      } else if (event.track.kind === 'video') {
        showRemoteVideoTile(socketId, entry.info, event.streams[0] || new MediaStream([event.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) teardownPeer(socketId);
    };
  }

  function teardownPeer(socketId) {
    const entry = peers[socketId];
    if (!entry) return;
    try { entry.pc.close(); } catch (e) { /* noop */ }
    delete peers[socketId];

    const audioEl = document.getElementById(`voice-audio-${socketId}`);
    if (audioEl) audioEl.remove();

    stopSpeakingDetection(socketId);
    removeRemoteVideoTile(socketId);
  }

  // ============ INTERNAL: SPEAKING DETECTION ============

  function startSpeakingDetection(key, stream) {
    stopSpeakingDetection(key);
    if (!stream || stream.getAudioTracks().length === 0) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let lastAboveThresholdAt = 0;
      let isSpeaking = false;

      const detector = { audioCtx, source, rafId: null };
      speakingDetectors[key] = detector;

      function tick() {
        if (!speakingDetectors[key]) return; // stopped
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = performance.now();
        if (rms > SPEAKING_THRESHOLD) lastAboveThresholdAt = now;

        const nowSpeaking = now - lastAboveThresholdAt < SPEAKING_HOLD_MS;
        if (nowSpeaking !== isSpeaking) {
          isSpeaking = nowSpeaking;
          setSpeakingClass(key, isSpeaking);
        }
        detector.rafId = requestAnimationFrame(tick);
      }
      tick();
    } catch (err) {
      console.error('speaking detection failed to start', err);
    }
  }

  function stopSpeakingDetection(key) {
    const d = speakingDetectors[key];
    if (!d) return;
    if (d.rafId) cancelAnimationFrame(d.rafId);
    try { d.source.disconnect(); } catch (e) { /* noop */ }
    try { d.audioCtx.close(); } catch (e) { /* noop */ }
    delete speakingDetectors[key];
    setSpeakingClass(key, false);
  }

  function setSpeakingClass(key, isSpeaking) {
    const tile = document.querySelector(`[data-speaker="${CSS.escape(String(key))}"]`);
    if (!tile) return;
    const ring = tile.querySelector('.avatar-ring');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
  }

  // ============ INTERNAL: UI ============

  function renderParticipants() {
    const list = $('#voice-participants');
    if (!list) return;
    list.innerHTML = '';

    if (connectedChannelId) {
      list.appendChild(participantTile('self', me.displayName, me.avatarColor, muted, sharingScreen, true));
    }
    Object.entries(peers).forEach(([socketId, { info }]) => {
      list.appendChild(participantTile(socketId, info.displayName, info.avatarColor, false, info.sharing, false));
    });

    if (list.children.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No one is in voice chat.</div>';
    }
  }

  function participantTile(key, name, color, isMuted, isSharing, isSelf) {
    const tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.dataset.speaker = key;

    const ring = document.createElement('div');
    ring.className = 'avatar-ring';
    ring.style.setProperty('--ring-color', color || '#5865F2');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = color || '#5865F2';
    avatar.textContent = (name || '?').trim().charAt(0).toUpperCase();
    ring.appendChild(avatar);

    if (isMuted) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge muted-badge';
      badge.textContent = '🔇';
      ring.appendChild(badge);
    }
    if (isSharing) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge share-badge';
      badge.textContent = '🖥️';
      ring.appendChild(badge);
    }

    const label = document.createElement('div');
    label.className = 'voice-tile-name';
    label.textContent = name + (isSelf ? ' (you)' : '');

    tile.appendChild(ring);
    tile.appendChild(label);
    return tile;
  }

  function showRemoteVideoTile(socketId, info, stream) {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    let tile = document.getElementById(`voice-tile-${socketId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'stream-tile';
      tile.id = `voice-tile-${socketId}`;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'stream-tile-label';
      label.textContent = `${info.displayName}'s screen`;
      tile.appendChild(label);
      tile.appendChild(buildExpandButton(tile));
      grid.appendChild(tile);
    }
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
    grid.classList.remove('hidden');
  }

  function buildExpandButton(tile) {
    const btn = document.createElement('button');
    btn.className = 'stream-expand-btn';
    btn.type = 'button';
    btn.title = 'Fullscreen';
    btn.textContent = '⛶';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTileFullscreen(tile, btn);
    });

    // Keep the icon in sync if the user exits fullscreen via Esc, browser
    // controls, or by fullscreening a different tile.
    const syncIcon = () => {
      const active = document.fullscreenElement === tile || document.webkitFullscreenElement === tile;
      btn.textContent = active ? '✕' : '⛶';
      btn.title = active ? 'Exit fullscreen' : 'Fullscreen';
    };
    document.addEventListener('fullscreenchange', syncIcon);
    document.addEventListener('webkitfullscreenchange', syncIcon);

    return btn;
  }

  function toggleTileFullscreen(tile, btn) {
    const isActive = document.fullscreenElement === tile || document.webkitFullscreenElement === tile;
    if (isActive) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (tile.requestFullscreen) {
      tile.requestFullscreen().catch(() => { /* user gesture or platform restriction */ });
    } else if (tile.webkitRequestFullscreen) {
      tile.webkitRequestFullscreen();
    }
  }

  function removeRemoteVideoTile(socketId) {
    const tile = document.getElementById(`voice-tile-${socketId}`);
    if (tile) tile.remove();
    updateGridVisibility();
  }

  function showLocalVideoTile(stream) {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    let tile = document.getElementById('voice-tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'stream-tile';
      tile.id = 'voice-tile-local';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'stream-tile-label';
      label.textContent = 'You are sharing your screen';
      tile.appendChild(label);
      tile.appendChild(buildExpandButton(tile));
      grid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    grid.classList.remove('hidden');
  }

  function removeLocalVideoTile() {
    const tile = document.getElementById('voice-tile-local');
    if (tile) tile.remove();
    updateGridVisibility();
  }

  function clearVideoGrid() {
    const grid = $('#voice-video-grid');
    if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
  }

  function updateGridVisibility() {
    const grid = $('#voice-video-grid');
    if (grid) grid.classList.toggle('hidden', grid.children.length === 0);
  }

  function updateMuteButton() {
    const btn = $('#voice-mute-btn');
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🎙️';
    btn.title = muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('active-danger', muted);
  }

  function updateShareButton() {
    const btn = $('#voice-share-btn');
    if (!btn) return;
    btn.textContent = sharingScreen ? '🛑' : '🖥️';
    btn.title = sharingScreen ? 'Stop Sharing' : 'Share Screen';
    btn.classList.toggle('active-danger', sharingScreen);
  }

  // ============ RESIZE HANDLE ============
  // Lets the user drag the boundary between the voice panel and the chat
  // below it to make the participant/video area taller or shorter. Height
  // is stored as a CSS custom property on the panel and remembered across
  // sessions via localStorage.

  const RESIZE_STORAGE_KEY = 'voicePanelHeight';
  const RESIZE_MIN = 120;

  function initResizeHandle() {
    const handle = $('#voice-resize-handle');
    const panel = $('#voice-panel');
    if (!handle || !panel) return;

    try {
      const saved = parseInt(localStorage.getItem(RESIZE_STORAGE_KEY), 10);
      if (saved) panel.style.setProperty('--voice-panel-height', `${saved}px`);
    } catch (err) { /* localStorage unavailable — ignore */ }

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = panel.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxHeight = window.innerHeight * 0.7;
      let newHeight = startHeight + (e.clientY - startY);
      newHeight = Math.min(Math.max(newHeight, RESIZE_MIN), maxHeight);
      panel.style.setProperty('--voice-panel-height', `${newHeight}px`);
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      const finalHeight = panel.getBoundingClientRect().height;
      try { localStorage.setItem(RESIZE_STORAGE_KEY, String(Math.round(finalHeight))); } catch (err) { /* ignore */ }
    });
  }

  return {
    init,
    joinChannel,
    leaveCurrent,
    toggleMute,
    toggleScreenShare,
    refreshPanelForGroup,
    isConnectedTo,
    isConnectedToGroup,
    initResizeHandle
  };
})();