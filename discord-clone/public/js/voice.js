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
  const { avatarEl, initials } = Utils;

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

    socket.on('voice:peer-mute-update', ({ socketId, muted: peerMuted }) => {
      if (peers[socketId]) peers[socketId].info.muted = peerMuted;
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
    resetPanelHeight();
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
    if (connectedChannelId) socket.emit('voice:mute-toggle', { channelId: connectedChannelId, muted });
    updateMuteButton();
    renderParticipants();
  }

  const SCREEN_SHARE_CONSTRAINTS = {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 }
    },
    audio: false
  };
  const SCREEN_SHARE_MAX_BITRATE = 6_000_000; // 6 Mbps — headroom to sustain 1080p without the encoder needing to shrink it

  // Screen shares are mostly static text/UI, not fast motion, so bias the
  // encoder toward resolution over frame rate and give it enough bitrate
  // headroom that WebRTC's default bandwidth estimate doesn't blur things out.
  //
  // scaleResolutionDownBy: 1 + degradationPreference: 'maintain-resolution'
  // together tell WebRTC it is NEVER allowed to shrink the encoded resolution
  // to cope with bandwidth — it must drop frame rate/quality instead. On a
  // poor connection this can mean stutter or lag rather than a smaller,
  // smoother picture; that's the explicit tradeoff of forcing a fixed
  // resolution instead of letting WebRTC adapt.
  async function applyScreenShareEncoding(sender) {
    if (!sender) return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE;
      params.encodings[0].scaleResolutionDownBy = 1;
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch (err) {
      console.error('Could not raise screen-share quality', err);
    }
  }

  async function toggleScreenShare() {
    if (!connectedChannelId) return;
    if (sharingScreen) {
      stopScreenShare();
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia(SCREEN_SHARE_CONSTRAINTS);
    } catch (err) {
      return;
    }

    const track = localScreenStream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => stopScreenShare();

    Object.values(peers).forEach(({ pc }) => applyScreenShareEncoding(pc.addTrack(track, localScreenStream)));

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
      localScreenStream.getTracks().forEach((t) => applyScreenShareEncoding(pc.addTrack(t, localScreenStream)));
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
      list.appendChild(participantTile('self', me.displayName, me.avatarColor, muted, sharingScreen, true, me.avatarUrl));
    }
    Object.entries(peers).forEach(([socketId, { info }]) => {
      list.appendChild(participantTile(socketId, info.displayName, info.avatarColor, !!info.muted, info.sharing, false, info.avatarUrl));
    });

    if (list.children.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No one is in voice chat.</div>';
    }
  }

  function participantTile(key, name, color, isMuted, isSharing, isSelf, avatarUrl) {
    const tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.dataset.speaker = key;

    const ring = document.createElement('div');
    ring.className = 'avatar-ring';
    ring.style.setProperty('--ring-color', color || '#5865F2');

    const avatar = avatarEl({ displayName: name, avatarColor: color, avatarUrl: avatarUrl });
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
    ensureStreamVisible();
    updateStreamTileHeight();
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
    ensureStreamVisible();
    updateStreamTileHeight();
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
    if (!grid) return;
    const empty = grid.children.length === 0;
    grid.classList.toggle('hidden', empty);
    // No streams left visible — undo any auto-grow/drag sizing that was only
    // there to accommodate the stream tile, back to the default panel size.
    if (empty) resetPanelHeight();
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
  // below it to make the participant/video area taller or shorter. Height is
  // stored as a CSS custom property on the panel. The size is intentionally
  // NOT remembered across sessions: every time a channel is (re)joined the
  // panel snaps back to the default height (see resetPanelHeight).

  const STREAM_TILE_MIN = 90;   // smallest a screen-share tile is allowed to shrink to
  const RESIZE_ABSOLUTE_MIN = 150; // fallback floor if layout can't be measured yet

  // Measures the real, currently-rendered pieces of the panel (controls bar,
  // an avatar tile, the share tile) so the min-height/stream-height math is
  // based on actual sizes rather than guessed constants that drift out of
  // sync with the CSS.
  function getPanelLayoutMetrics(panel) {
    const top = panel.querySelector('.voice-panel-top');
    const participants = panel.querySelector('#voice-participants');
    const grid = panel.querySelector('#voice-video-grid');

    const panelStyles = getComputedStyle(panel);
    const paddingTop = parseFloat(panelStyles.paddingTop) || 0;
    const paddingBottom = parseFloat(panelStyles.paddingBottom) || 0;

    const topHeight = top ? top.getBoundingClientRect().height : 0;

    const tile = participants ? participants.querySelector('.voice-tile') : null;
    const tileHeight = tile ? tile.getBoundingClientRect().height : 0;
    const participantsMarginBottom = participants
      ? (parseFloat(getComputedStyle(participants).marginBottom) || 0)
      : 0;

    const isStreaming = !!(grid && !grid.classList.contains('hidden') && grid.children.length > 0);
    const gridMarginBottom = grid ? (parseFloat(getComputedStyle(grid).marginBottom) || 0) : 0;

    return { paddingTop, paddingBottom, topHeight, tileHeight, participantsMarginBottom, isStreaming, gridMarginBottom };
  }

  // Smallest the panel can be dragged to: enough room for the controls bar
  // plus one full row of avatar tiles, and — while someone is streaming —
  // enough extra room so the share tile stays visible too.
  function computeMinHeight(panel) {
    const m = getPanelLayoutMetrics(panel);
    if (!m.tileHeight) return RESIZE_ABSOLUTE_MIN;

    let min = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight + m.participantsMarginBottom;

    if (m.isStreaming) {
      min += m.gridMarginBottom + STREAM_TILE_MIN;
    }

    return Math.max(Math.ceil(min), RESIZE_ABSOLUTE_MIN);
  }

  // While streaming, grows/shrinks the share tile so it fills whatever extra
  // room dragging the panel bigger/smaller frees up (or takes away).
  function updateStreamTileHeight(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;
    const grid = $('#voice-video-grid');
    if (!grid || grid.classList.contains('hidden') || grid.children.length === 0) return;

    const m = getPanelLayoutMetrics(panel);
    const panelHeight = panel.getBoundingClientRect().height;
    const reserved = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight
      + m.participantsMarginBottom + m.gridMarginBottom;

    const maxAvailable = window.innerHeight * 0.6;
    let available = panelHeight - reserved;
    available = Math.min(Math.max(available, STREAM_TILE_MIN), maxAvailable);

    panel.style.setProperty('--stream-tile-height', `${Math.round(available)}px`);
  }

  const STREAM_TILE_DEFAULT = 180; // comfortable height a stream tile opens at, no drag needed

  // Called the moment a share starts. If the panel is currently too small to
  // show the stream at a comfortable size, grow it automatically — the user
  // shouldn't have to drag the handle just to see what was just shared.
  // Never shrinks a panel the user already made bigger themselves.
  function ensureStreamVisible(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;

    const m = getPanelLayoutMetrics(panel);
    if (!m.isStreaming) return;

    const needed = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight
      + m.participantsMarginBottom + m.gridMarginBottom + STREAM_TILE_DEFAULT;

    const maxHeight = window.innerHeight * 0.7;
    const target = Math.min(Math.ceil(needed), maxHeight);
    const currentHeight = panel.getBoundingClientRect().height;

    if (currentHeight < target) {
      panel.style.setProperty('--voice-panel-height', `${target}px`);
    }
  }

  // Snaps the panel back to its default (CSS-defined) height. Called every
  // time a voice channel is joined so a previous drag never carries over.
  function resetPanelHeight() {
    const panel = $('#voice-panel');
    if (!panel) return;
    panel.style.removeProperty('--voice-panel-height');
    updateStreamTileHeight(panel);
  }

  function initResizeHandle() {
    const handle = $('#voice-resize-handle');
    const panel = $('#voice-panel');
    if (!handle || !panel) return;

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
      const minHeight = computeMinHeight(panel);
      let newHeight = startHeight + (e.clientY - startY);
      newHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
      panel.style.setProperty('--voice-panel-height', `${newHeight}px`);
      updateStreamTileHeight(panel);
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
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