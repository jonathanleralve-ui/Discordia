// Voice channel + screen share module.
// Uses a mesh of RTCPeerConnections (one per remote participant) with the
// "perfect negotiation" pattern so renegotiation (e.g. starting/stopping a
// screen share) works cleanly without offer/answer glare.
//
// Wired up by app.js via VoiceChat.init(socket, me) once, then
// VoiceChat.showGroup(groupId, name) / joinCurrentGroup() / leaveCurrent()
// as the user switches groups and joins/leaves voice.

const VoiceChat = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  let socket = null;
  let me = null;

  let currentGroupId = null;   // group whose voice channel UI is currently visible
  let connectedGroupId = null; // group whose voice channel we're actually connected to
  let localMicStream = null;
  let localScreenStream = null;
  let sharingScreen = false;
  let muted = false;

  // socketId -> { pc, polite, makingOffer, ignoreOffer, info: {userId, displayName, avatarColor, sharing}, videoEl }
  const peers = {};

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

    // Reconnect voice cleanly if the socket drops and comes back
    socket.on('disconnect', () => {
      connectedGroupId = null;
      Object.keys(peers).forEach(teardownPeer);
    });
  }

  // Show the voice panel for the group currently open in chat (doesn't auto-join)
  function showGroup(groupId, groupName) {
    currentGroupId = groupId;
    $('#voice-panel').classList.remove('hidden');
    $('#voice-group-name').textContent = groupName;
    const inThisChannel = connectedGroupId === groupId;
    $('#voice-join-btn').classList.toggle('hidden', inThisChannel);
    $('#voice-controls').classList.toggle('hidden', !inThisChannel);
    renderParticipants();
  }

  function hidePanel() {
    currentGroupId = null;
    $('#voice-panel').classList.add('hidden');
  }

  async function joinCurrentGroup() {
    if (!currentGroupId || connectedGroupId === currentGroupId) return;

    if (connectedGroupId) await leaveCurrent();

    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Couldn't access your microphone: " + err.message);
      return;
    }

    muted = false;
    connectedGroupId = currentGroupId;
    socket.emit('voice:join', { groupId: connectedGroupId });

    $('#voice-join-btn').classList.add('hidden');
    $('#voice-controls').classList.remove('hidden');
    updateMuteButton();
    renderParticipants();
  }

  async function leaveCurrent() {
    if (!connectedGroupId) return;
    const gid = connectedGroupId;

    socket.emit('voice:leave', { groupId: gid });
    Object.keys(peers).forEach(teardownPeer);

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
    connectedGroupId = null;

    clearVideoGrid();

    if (currentGroupId === gid) {
      $('#voice-join-btn').classList.remove('hidden');
      $('#voice-controls').classList.add('hidden');
    }
    renderParticipants();
  }

  function toggleMute() {
    if (!localMicStream) return;
    muted = !muted;
    localMicStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    updateMuteButton();
  }

  async function toggleScreenShare() {
    if (!connectedGroupId) return;
    if (sharingScreen) {
      stopScreenShare();
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      // user cancelled the picker, or it's unsupported
      return;
    }

    const track = localScreenStream.getVideoTracks()[0];
    track.onended = () => stopScreenShare(); // user clicked "Stop sharing" in the browser's own UI

    Object.values(peers).forEach(({ pc }) => pc.addTrack(track, localScreenStream));

    sharingScreen = true;
    socket.emit('voice:screen-share-toggle', { groupId: connectedGroupId, sharing: true });
    showLocalVideoTile(localScreenStream);
    updateShareButton();
  }

  function stopScreenShare() {
    if (!sharingScreen) return;
    const track = localScreenStream && localScreenStream.getVideoTracks()[0];

    Object.values(peers).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) pc.removeTrack(sender);
    });

    if (localScreenStream) localScreenStream.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
    sharingScreen = false;

    if (connectedGroupId) socket.emit('voice:screen-share-toggle', { groupId: connectedGroupId, sharing: false });
    removeLocalVideoTile();
    updateShareButton();
  }

  // ============ INTERNAL: PEER CONNECTIONS ============

  function connectToPeer(socketId, info, isInitiator) {
    if (peers[socketId]) return;

    const polite = socket.id > socketId; // consistent tie-break: higher id defers on glare

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
        audioEl.srcObject = event.streams[0] || new MediaStream([event.track]);
      } else if (event.track.kind === 'video') {
        showRemoteVideoTile(socketId, entry.info, event.streams[0] || new MediaStream([event.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) teardownPeer(socketId);
    };

    // isInitiator is informational only here — onnegotiationneeded handles offer creation
    // for whichever side adds tracks first, per the perfect-negotiation pattern.
  }

  function teardownPeer(socketId) {
    const entry = peers[socketId];
    if (!entry) return;
    try { entry.pc.close(); } catch (e) { /* noop */ }
    delete peers[socketId];

    const audioEl = document.getElementById(`voice-audio-${socketId}`);
    if (audioEl) audioEl.remove();

    removeRemoteVideoTile(socketId);
  }

  // ============ INTERNAL: UI ============

  function renderParticipants() {
    const list = $('#voice-participants');
    if (!list) return;
    list.innerHTML = '';

    if (connectedGroupId === currentGroupId && connectedGroupId) {
      list.appendChild(participantChip(me.displayName, me.avatarColor, muted, sharingScreen, true));
    }
    Object.values(peers).forEach(({ info }) => {
      list.appendChild(participantChip(info.displayName, info.avatarColor, false, info.sharing, false));
    });

    if (list.children.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No one is in voice chat.</div>';
    }
  }

  function participantChip(name, color, isMuted, isSharing, isSelf) {
    const chip = document.createElement('div');
    chip.className = 'voice-chip';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = color || '#5865F2';
    av.textContent = (name || '?').trim().charAt(0).toUpperCase();
    chip.appendChild(av);
    const label = document.createElement('span');
    label.textContent = name + (isSelf ? ' (you)' : '');
    chip.appendChild(label);
    if (isMuted) {
      const m = document.createElement('span');
      m.className = 'voice-chip-icon';
      m.textContent = '🔇';
      chip.appendChild(m);
    }
    if (isSharing) {
      const s = document.createElement('span');
      s.className = 'voice-chip-icon';
      s.textContent = '🖥️';
      chip.appendChild(s);
    }
    return chip;
  }

  function showRemoteVideoTile(socketId, info, stream) {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    let tile = document.getElementById(`voice-tile-${socketId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'voice-tile';
      tile.id = `voice-tile-${socketId}`;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'voice-tile-label';
      label.textContent = `${info.displayName}'s screen`;
      tile.appendChild(label);
      grid.appendChild(tile);
    }
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
    grid.classList.remove('hidden');
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
      tile.className = 'voice-tile';
      tile.id = 'voice-tile-local';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'voice-tile-label';
      label.textContent = 'You are sharing your screen';
      tile.appendChild(label);
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
    btn.textContent = muted ? '🔇 Unmute' : '🎙️ Mute';
    btn.classList.toggle('active-danger', muted);
  }

  function updateShareButton() {
    const btn = $('#voice-share-btn');
    if (!btn) return;
    btn.textContent = sharingScreen ? '🛑 Stop Sharing' : '🖥️ Share Screen';
    btn.classList.toggle('active-danger', sharingScreen);
  }

  function isConnectedTo(groupId) {
    return connectedGroupId === groupId;
  }

  return {
    init,
    showGroup,
    hidePanel,
    joinCurrentGroup,
    leaveCurrent,
    toggleMute,
    toggleScreenShare,
    isConnectedTo
  };
})();
