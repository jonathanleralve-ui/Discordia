(() => {
  'use strict';

  // ============ STATE ============
  let token = localStorage.getItem('chatter_token') || null;
  let me = null;
  let socket = null;

  let friendsData = { friends: [], incoming: [], outgoing: [] };
  let groupsData = [];

  // current open chat: { type: 'dm'|'group', id, name }
  let activeChat = null;
  let typingTimeout = null;
  let typingClearTimers = {};

  // ============ HELPERS ============
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function api(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`/api${path}`, Object.assign({}, options, { headers })).then(async (res) => {
      let data = {};
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    });
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(iso) {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function avatarEl(user, size = '') {
    const el = document.createElement('div');
    el.className = `avatar ${size}`;
    el.style.background = user.avatarColor || user.senderColor || '#5865F2';
    el.textContent = initials(user.displayName || user.senderName);
    return el;
  }

  // ============ AUTH SCREENS ============
  $('#show-register').addEventListener('click', (e) => {
    e.preventDefault();
    $('#login-form').classList.add('hidden');
    $('#register-form').classList.remove('hidden');
  });
  $('#show-login').addEventListener('click', (e) => {
    e.preventDefault();
    $('#register-form').classList.add('hidden');
    $('#login-form').classList.remove('hidden');
  });

  $('#login-submit').addEventListener('click', doLogin);
  $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#register-submit').addEventListener('click', doRegister);
  $('#register-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });

  function doLogin() {
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    $('#login-error').textContent = '';
    api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      .then((data) => onAuthSuccess(data))
      .catch((err) => { $('#login-error').textContent = err.message; });
  }

  function doRegister() {
    const displayName = $('#register-displayname').value.trim();
    const username = $('#register-username').value.trim();
    const password = $('#register-password').value;
    $('#register-error').textContent = '';
    api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) })
      .then((data) => onAuthSuccess(data))
      .catch((err) => { $('#register-error').textContent = err.message; });
  }

  function onAuthSuccess(data) {
    token = data.token;
    me = data.user;
    localStorage.setItem('chatter_token', token);
    enterApp();
  }

  $('#logout-btn').addEventListener('click', () => {
    VoiceChat.leaveCurrent();
    localStorage.removeItem('chatter_token');
    token = null;
    me = null;
    if (socket) socket.disconnect();
    location.reload();
  });

  // ============ APP ENTRY ============
  function enterApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');

    $('#me-name').textContent = me.displayName;
    const meAvatar = $('#me-avatar');
    meAvatar.style.background = me.avatarColor;
    meAvatar.textContent = initials(me.displayName);

    connectSocket();
    VoiceChat.init(socket, me);
    initVoiceControls();
    refreshFriends();
    refreshGroups();
    showFriendsHome();
  }

  function initVoiceControls() {
    $('#voice-join-btn').addEventListener('click', () => VoiceChat.joinCurrentGroup());
    $('#voice-leave-btn').addEventListener('click', () => VoiceChat.leaveCurrent());
    $('#voice-mute-btn').addEventListener('click', () => VoiceChat.toggleMute());
    $('#voice-share-btn').addEventListener('click', () => VoiceChat.toggleScreenShare());
  }

  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });

    socket.on('presence:update', ({ userId, status }) => {
      const f = friendsData.friends.find((x) => x.id === userId);
      if (f) { f.status = status; renderFriendsTabs(); }
    });

    socket.on('dm:message', (msg) => {
      if (activeChat && activeChat.type === 'dm' && (msg.senderId === activeChat.id || msg.recipientId === activeChat.id)) {
        appendMessage(msg);
      }
    });

    socket.on('group:message', (msg) => {
      if (activeChat && activeChat.type === 'group' && msg.groupId === activeChat.id) {
        appendMessage(msg);
      }
    });

    socket.on('typing', ({ scope, from, groupId }) => {
      if (!activeChat) return;
      if (scope === 'dm' && activeChat.type === 'dm' && from === activeChat.id) {
        showTyping(activeChat.id);
      } else if (scope === 'group' && activeChat.type === 'group' && groupId === activeChat.id) {
        showTyping(`g${groupId}-${from}`);
      }
    });

    socket.on('error:message', ({ error }) => {
      alert(error);
    });
  }

  function showTyping(key) {
    const el = $('#typing-indicator');
    el.textContent = 'Someone is typing...';
    clearTimeout(typingClearTimers[key]);
    typingClearTimers[key] = setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ============ RAIL NAV ============
  $('#rail-home').addEventListener('click', showFriendsHome);
  $('#rail-add-group').addEventListener('click', openCreateGroupModal);

  function showFriendsHome() {
    setActiveRail($('#rail-home'));
    $('#sidebar-header').textContent = 'Friends';
    $('#friends-panel').classList.remove('hidden');
    $('#group-panel').classList.add('hidden');
  }

  function setActiveRail(el) {
    $$('.rail-item').forEach((r) => r.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function renderRailGroups() {
    const container = $('#rail-groups');
    container.innerHTML = '';
    groupsData.forEach((g) => {
      const el = document.createElement('div');
      el.className = 'rail-item';
      el.title = g.name;
      el.dataset.groupId = g.id;
      el.style.background = g.iconColor;
      el.textContent = initials(g.name);
      el.addEventListener('click', () => openGroup(g));
      container.appendChild(el);
    });
  }

  // ============ FRIENDS ============
  function refreshFriends() {
    return api('/friends').then((data) => {
      friendsData = data;
      renderFriendsTabs();
    });
  }

  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
      $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  function renderFriendsTabs() {
    // Online tab
    const online = friendsData.friends.filter((f) => f.status === 'online');
    renderFriendList('#tab-online', online, 'No one is online right now.');

    // All tab
    renderFriendList('#tab-all', friendsData.friends, "You haven't added anyone yet.");

    // Pending tab
    const pendingEl = $('#tab-pending');
    pendingEl.innerHTML = '';
    if (friendsData.incoming.length === 0 && friendsData.outgoing.length === 0) {
      pendingEl.innerHTML = '<div class="empty-list-hint">No pending requests.</div>';
    } else {
      if (friendsData.incoming.length) {
        const label = document.createElement('div');
        label.className = 'panel-hint';
        label.textContent = `INCOMING — ${friendsData.incoming.length}`;
        pendingEl.appendChild(label);
        friendsData.incoming.forEach((u) => pendingEl.appendChild(buildIncomingRow(u)));
      }
      if (friendsData.outgoing.length) {
        const label = document.createElement('div');
        label.className = 'panel-hint';
        label.textContent = `OUTGOING — ${friendsData.outgoing.length}`;
        pendingEl.appendChild(label);
        friendsData.outgoing.forEach((u) => pendingEl.appendChild(buildOutgoingRow(u)));
      }
    }
  }

  function renderFriendList(selector, list, emptyMsg) {
    const el = $(selector);
    el.innerHTML = '';
    if (list.length === 0) {
      el.innerHTML = `<div class="empty-list-hint">${emptyMsg}</div>`;
      return;
    }
    list.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'friend-row';
      row.appendChild(avatarWithStatus(f));
      const meta = document.createElement('div');
      meta.className = 'friend-meta';
      meta.innerHTML = `<div class="friend-name">${escapeHtml(f.displayName)}</div><div class="friend-sub">${f.status === 'online' ? 'Online' : 'Offline'}</div>`;
      row.appendChild(meta);
      row.addEventListener('click', () => openDM(f));
      el.appendChild(row);
    });
  }

  function avatarWithStatus(user) {
    const wrap = avatarEl(user);
    const dot = document.createElement('div');
    dot.className = `status-dot ${user.status === 'online' ? 'online' : ''}`;
    wrap.appendChild(dot);
    return wrap;
  }

  function buildIncomingRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.appendChild(avatarEl(u));
    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">Incoming request</div>`;
    row.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'friend-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'icon-btn';
    acceptBtn.textContent = '✓';
    acceptBtn.title = 'Accept';
    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api(`/friends/${u.friendshipId}/accept`, { method: 'POST' }).then(refreshFriends);
    });
    const declineBtn = document.createElement('button');
    declineBtn.className = 'icon-btn decline';
    declineBtn.textContent = '✕';
    declineBtn.title = 'Decline';
    declineBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api(`/friends/${u.friendshipId}`, { method: 'DELETE' }).then(refreshFriends);
    });
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    return row;
  }

  function buildOutgoingRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.appendChild(avatarEl(u));
    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">Pending...</div>`;
    row.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'friend-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'icon-btn decline';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel request';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api(`/friends/${u.friendshipId}`, { method: 'DELETE' }).then(refreshFriends);
    });
    actions.appendChild(cancelBtn);
    row.appendChild(actions);
    return row;
  }

  $('#add-friend-submit').addEventListener('click', () => {
    const username = $('#add-friend-input').value.trim();
    $('#add-friend-error').textContent = '';
    if (!username) return;
    api('/friends/request', { method: 'POST', body: JSON.stringify({ username }) })
      .then(() => {
        $('#add-friend-input').value = '';
        refreshFriends();
      })
      .catch((err) => { $('#add-friend-error').textContent = err.message; });
  });

  // ============ GROUPS ============
  function refreshGroups() {
    return api('/groups').then((data) => {
      groupsData = data.groups;
      renderRailGroups();
    });
  }

  function openCreateGroupModal() {
    $('#create-group-name').value = '';
    const list = $('#create-group-friends');
    list.innerHTML = '';
    if (friendsData.friends.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">Add some friends first!</div>';
    }
    friendsData.friends.forEach((f) => {
      const row = document.createElement('label');
      row.className = 'friend-check-row';
      row.innerHTML = `<input type="checkbox" value="${f.id}" /> <span>${escapeHtml(f.displayName)}</span>`;
      list.appendChild(row);
    });
    $('#modal-overlay').classList.remove('hidden');
    $('#create-group-modal').classList.remove('hidden');
    $('#add-member-modal').classList.add('hidden');
  }

  $('#create-group-cancel').addEventListener('click', closeModals);
  function closeModals() {
    $('#modal-overlay').classList.add('hidden');
  }
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModals();
  });

  $('#create-group-confirm').addEventListener('click', () => {
    const name = $('#create-group-name').value.trim();
    if (!name) return;
    const memberIds = Array.from($('#create-group-friends').querySelectorAll('input:checked')).map((i) => Number(i.value));
    api('/groups', { method: 'POST', body: JSON.stringify({ name, memberIds }) })
      .then(({ group }) => {
        closeModals();
        return refreshGroups().then(() => {
          const g = groupsData.find((x) => x.id === group.id);
          if (g) openGroup(g);
        });
      })
      .catch((err) => alert(err.message));
  });

  let activeMemberIds = [];
  function openGroup(g) {
    activeChat = { type: 'group', id: g.id, name: g.name };
    setActiveRail(document.querySelector(`.rail-item[data-group-id="${g.id}"]`));
    $('#sidebar-header').textContent = g.name;
    $('#friends-panel').classList.add('hidden');
    $('#group-panel').classList.remove('hidden');
    $('#group-panel-title').textContent = 'Members';

    socket.emit('group:join', g.id);
    VoiceChat.showGroup(g.id, g.name);

    api(`/groups/${g.id}/members`).then((data) => {
      activeMemberIds = data.members.map((m) => m.id);
      renderGroupMembers(data.members);
    });

    openChatWindow();
  }

  function renderGroupMembers(members) {
    const el = $('#group-members-list');
    el.innerHTML = '';
    members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.appendChild(avatarWithStatus(m));
      const meta = document.createElement('div');
      meta.className = 'friend-meta';
      meta.innerHTML = `<div class="friend-name">${escapeHtml(m.displayName)}${m.id === me.id ? ' (you)' : ''}</div>`;
      row.appendChild(meta);
      el.appendChild(row);
    });
  }

  $('#group-add-member-btn').addEventListener('click', () => {
    if (!activeChat || activeChat.type !== 'group') return;
    const list = $('#add-member-friends');
    list.innerHTML = '';
    const addable = friendsData.friends.filter((f) => !activeMemberIds.includes(f.id));
    if (addable.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">All your friends are already in this group.</div>';
    }
    addable.forEach((f) => {
      const row = document.createElement('label');
      row.className = 'friend-check-row';
      row.innerHTML = `<input type="checkbox" value="${f.id}" /> <span>${escapeHtml(f.displayName)}</span>`;
      list.appendChild(row);
    });
    $('#modal-overlay').classList.remove('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.remove('hidden');
  });

  $('#add-member-cancel').addEventListener('click', closeModals);
  $('#add-member-confirm').addEventListener('click', () => {
    const ids = Array.from($('#add-member-friends').querySelectorAll('input:checked')).map((i) => Number(i.value));
    if (ids.length === 0) { closeModals(); return; }
    const groupId = activeChat.id;
    Promise.all(ids.map((userId) => api(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ userId }) })))
      .then(() => {
        closeModals();
        return api(`/groups/${groupId}/members`).then((data) => {
          activeMemberIds = data.members.map((m) => m.id);
          renderGroupMembers(data.members);
        });
      })
      .catch((err) => alert(err.message));
  });

  // ============ CHAT WINDOW ============
  function openChatWindow() {
    $('#empty-state').classList.add('hidden');
    $('#chat-panel').classList.remove('hidden');
    $('#chat-title').textContent = activeChat.type === 'dm' ? `@${activeChat.name}` : `# ${activeChat.name}`;
    $('#chat-messages').innerHTML = '';
    $('#typing-indicator').textContent = '';
    loadHistory();
    $('#chat-input').value = '';
    $('#chat-input').focus();
  }

  function openDM(friend) {
    activeChat = { type: 'dm', id: friend.id, name: friend.displayName, color: friend.avatarColor };
    setActiveRail($('#rail-home'));
    $('#sidebar-header').textContent = 'Friends';
    VoiceChat.hidePanel();
    openChatWindow();
  }

  function loadHistory() {
    const path = activeChat.type === 'dm' ? `/messages/dm/${activeChat.id}` : `/messages/group/${activeChat.id}`;
    api(path).then((data) => {
      $('#chat-messages').innerHTML = '';
      data.messages.forEach((m) => appendMessage(m, false));
      scrollToBottom();
    }).catch((err) => {
      $('#chat-messages').innerHTML = `<div class="empty-list-hint">${escapeHtml(err.message)}</div>`;
    });
  }

  function appendMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `message-row ${m.senderId === me.id ? 'own' : ''}`;
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = m.senderColor || '#5865F2';
    av.textContent = initials(m.senderName);
    row.appendChild(av);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = `
      <div class="message-head">
        <span class="message-author">${escapeHtml(m.senderName)}</span>
        <span class="message-time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="message-content"></div>
    `;
    body.querySelector('.message-content').textContent = m.content;
    row.appendChild(body);
    list.appendChild(row);
    scrollToBottom();
  }

  function scrollToBottom() {
    const el = $('#chat-messages');
    el.scrollTop = el.scrollHeight;
  }

  $('#chat-send').addEventListener('click', sendMessage);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    } else {
      emitTyping();
    }
  });

  function emitTyping() {
    if (!activeChat || !socket) return;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('typing', { scope: activeChat.type, id: activeChat.id });
    }, 150);
  }

  function sendMessage() {
    const input = $('#chat-input');
    const content = input.value.trim();
    if (!content || !activeChat) return;
    input.value = '';

    if (activeChat.type === 'dm') {
      socket.emit('dm:send', { recipientId: activeChat.id, content });
    } else {
      socket.emit('group:send', { groupId: activeChat.id, content });
    }
  }

  // ============ BOOTSTRAP ============
  if (token) {
    api('/auth/me').then((data) => {
      me = data.user;
      enterApp();
    }).catch(() => {
      localStorage.removeItem('chatter_token');
      token = null;
    });
  }
})();

// Voice channel + screen share module.
// Uses a mesh of RTCPeerConnections (one per remote participant) with the
// "perfect negotiation" pattern so renegotiation (e.g. starting/stopping a
// screen share) works cleanly without offer/answer glare.
//
// Wired up by app.js via VoiceChat.init(socket, me) once, then
// VoiceChat.enterGroup(groupId) / leaveCurrent() as the user switches groups.

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