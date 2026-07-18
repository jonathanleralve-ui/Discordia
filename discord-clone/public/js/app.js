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
    refreshFriends();
    refreshGroups();
    showFriendsHome();
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
