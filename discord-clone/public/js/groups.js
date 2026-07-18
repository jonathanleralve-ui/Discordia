// Group rail icons, create-group / add-member modals, and the member list
// panel shown when a group chat is open.
const Groups = (() => {
  const { $, $$, escapeHtml, initials, avatarWithStatus } = Utils;

  function refresh() {
    return Api.groups.list().then((data) => {
      AppState.groupsData = data.groups;
      renderRail();
    });
  }

  function renderRail() {
    const container = $('#rail-groups');
    container.innerHTML = '';
    AppState.groupsData.forEach((g) => {
      const el = document.createElement('div');
      el.className = 'rail-item';
      el.title = g.name;
      el.dataset.groupId = g.id;
      el.style.background = g.iconColor;
      el.textContent = initials(g.name);
      el.addEventListener('click', () => open(g));
      container.appendChild(el);
    });
  }

  function open(g) {
    AppState.activeChat = { type: 'group', id: g.id, name: g.name };
    App.setActiveRail(document.querySelector(`.rail-item[data-group-id="${g.id}"]`));
    $('#sidebar-header').textContent = g.name;
    $('#friends-panel').classList.add('hidden');
    $('#group-panel').classList.remove('hidden');
    $('#group-panel-title').textContent = 'Members';

    AppState.socket.emit('group:join', g.id);
    VoiceChat.showGroup(g.id, g.name);

    Api.groups.members(g.id).then((data) => {
      AppState.activeMemberIds = data.members.map((m) => m.id);
      renderMembers(data.members);
    });

    Chat.openChatWindow();
  }

  function renderMembers(members) {
    const el = $('#group-members-list');
    el.innerHTML = '';
    members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.appendChild(avatarWithStatus(m));
      const meta = document.createElement('div');
      meta.className = 'friend-meta';
      meta.innerHTML = `<div class="friend-name">${escapeHtml(m.displayName)}${m.id === AppState.me.id ? ' (you)' : ''}</div>`;
      row.appendChild(meta);
      el.appendChild(row);
    });
  }

  function openCreateModal() {
    $('#create-group-name').value = '';
    const list = $('#create-group-friends');
    list.innerHTML = '';
    if (AppState.friendsData.friends.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">Add some friends first!</div>';
    }
    AppState.friendsData.friends.forEach((f) => {
      const row = document.createElement('label');
      row.className = 'friend-check-row';
      row.innerHTML = `<input type="checkbox" value="${f.id}" /> <span>${escapeHtml(f.displayName)}</span>`;
      list.appendChild(row);
    });
    $('#modal-overlay').classList.remove('hidden');
    $('#create-group-modal').classList.remove('hidden');
    $('#add-member-modal').classList.add('hidden');
  }

  function closeModals() {
    $('#modal-overlay').classList.add('hidden');
  }

  function openAddMemberModal() {
    if (!AppState.activeChat || AppState.activeChat.type !== 'group') return;
    const list = $('#add-member-friends');
    list.innerHTML = '';
    const addable = AppState.friendsData.friends.filter((f) => !AppState.activeMemberIds.includes(f.id));
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
  }

  function leaveActiveGroup() {
    if (!AppState.activeChat || AppState.activeChat.type !== 'group') return;
    if (!confirm(`Leave "${AppState.activeChat.name}"?`)) return;
    const groupId = AppState.activeChat.id;
    Api.groups.leave(groupId)
      .then(() => {
        VoiceChat.leaveCurrent();
        VoiceChat.hidePanel();
        AppState.activeChat = null;
        return refresh();
      })
      .then(() => App.showFriendsHome())
      .catch((err) => alert(err.message));
  }

  function initUI() {
    $('#rail-add-group').addEventListener('click', openCreateModal);

    $('#create-group-cancel').addEventListener('click', closeModals);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModals();
    });

    $('#create-group-confirm').addEventListener('click', () => {
      const name = $('#create-group-name').value.trim();
      if (!name) return;
      const memberIds = Array.from($('#create-group-friends').querySelectorAll('input:checked')).map((i) => Number(i.value));
      Api.groups.create(name, memberIds)
        .then(({ group }) => {
          closeModals();
          return refresh().then(() => {
            const g = AppState.groupsData.find((x) => x.id === group.id);
            if (g) open(g);
          });
        })
        .catch((err) => alert(err.message));
    });

    $('#group-add-member-btn').addEventListener('click', openAddMemberModal);
    $('#add-member-cancel').addEventListener('click', closeModals);
    $('#add-member-confirm').addEventListener('click', () => {
      const ids = Array.from($('#add-member-friends').querySelectorAll('input:checked')).map((i) => Number(i.value));
      if (ids.length === 0) { closeModals(); return; }
      const groupId = AppState.activeChat.id;
      Promise.all(ids.map((userId) => Api.groups.addMember(groupId, userId)))
        .then(() => {
          closeModals();
          return Api.groups.members(groupId).then((data) => {
            AppState.activeMemberIds = data.members.map((m) => m.id);
            renderMembers(data.members);
          });
        })
        .catch((err) => alert(err.message));
    });

    const leaveBtn = $('#group-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', leaveActiveGroup);
  }

  return { refresh, open, initUI };
})();
