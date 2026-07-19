// Friends list (online/all/pending tabs), friend requests, and the
// "Add Friend" form.
const Friends = (() => {
  const { $, $$, escapeHtml, avatarEl, avatarWithStatus } = Utils;

  function refresh() {
    return Api.friends.list().then((data) => {
      AppState.friendsData = data;
      renderTabs();
    });
  }

  function handlePresenceUpdate(userId, status) {
    const f = AppState.friendsData.friends.find((x) => x.id === userId);
    if (f) {
      f.status = status;
      renderTabs();
    }
  }

  function renderTabs() {
    const { friends, incoming, outgoing } = AppState.friendsData;

    const online = friends.filter((f) => f.status === 'online');
    renderFriendList('#tab-online', online, 'No one is online right now.');
    renderFriendList('#tab-all', friends, "You haven't added anyone yet.");

    const pendingEl = $('#tab-pending');
    pendingEl.innerHTML = '';
    if (incoming.length === 0 && outgoing.length === 0) {
      pendingEl.innerHTML = '<div class="empty-list-hint">No pending requests.</div>';
      return;
    }
    if (incoming.length) {
      pendingEl.appendChild(sectionLabel(`INCOMING — ${incoming.length}`));
      incoming.forEach((u) => pendingEl.appendChild(buildIncomingRow(u)));
    }
    if (outgoing.length) {
      pendingEl.appendChild(sectionLabel(`OUTGOING — ${outgoing.length}`));
      outgoing.forEach((u) => pendingEl.appendChild(buildOutgoingRow(u)));
    }
  }

  function sectionLabel(text) {
    const label = document.createElement('div');
    label.className = 'panel-hint';
    label.textContent = text;
    return label;
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
      row.addEventListener('click', () => Chat.openDM(f));
      el.appendChild(row);
    });
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
      Api.friends.accept(u.friendshipId).then(refresh);
    });

    const declineBtn = document.createElement('button');
    declineBtn.className = 'icon-btn decline';
    declineBtn.textContent = '✕';
    declineBtn.title = 'Decline';
    declineBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Api.friends.remove(u.friendshipId).then(refresh);
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
      Api.friends.remove(u.friendshipId).then(refresh);
    });
    actions.appendChild(cancelBtn);
    row.appendChild(actions);
    return row;
  }

  function openAddFriendPanel() {
    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-error').textContent = '';
    $('#add-friend-input').value = '';
    $('#add-friend-panel').classList.remove('hidden');
    $('#add-friend-input').focus();
  }

  function closeAddFriendPanel() {
    $('#add-friend-panel').classList.add('hidden');
    if (AppState.activeChat) {
      $('#chat-panel').classList.remove('hidden');
    } else {
      $('#empty-state').classList.remove('hidden');
    }
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $('.tab-btn[data-tab="online"]').classList.add('active');
    $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $('#tab-online').classList.remove('hidden');
  }

  function initUI() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.tab === 'add') {
          openAddFriendPanel();
          return;
        }

        $('#add-friend-panel').classList.add('hidden');
        if (AppState.activeChat) {
          $('#chat-panel').classList.remove('hidden');
        } else {
          $('#empty-state').classList.remove('hidden');
        }
        $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
        $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
      });
    });

    $('#add-friend-close').addEventListener('click', closeAddFriendPanel);

    $('#add-friend-submit').addEventListener('click', () => {
      const username = $('#add-friend-input').value.trim();
      $('#add-friend-error').textContent = '';
      if (!username) return;
      Api.friends.sendRequest(username)
        .then(() => {
          $('#add-friend-input').value = '';
          refresh();
        })
        .catch((err) => { $('#add-friend-error').textContent = err.message; });
    });
  }

  return { refresh, renderTabs, handlePresenceUpdate, initUI };
})();
