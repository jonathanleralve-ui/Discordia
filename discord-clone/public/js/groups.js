// Group rail icons, the channel list + member list shown when a group is
// open, and the create-group / add-member / create-channel modals.
const Groups = (() => {
  const { $, $$, escapeHtml, initials, avatarWithStatus } = Utils;

  let createChannelType = 'text';

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
    AppState.activeGroup = g;
    AppState.activeChat = null;
    App.setActiveRail(document.querySelector(`.rail-item[data-group-id="${g.id}"]`));
    $('#sidebar-header').textContent = g.name;
    $('#friends-panel').classList.add('hidden');
    $('#group-panel').classList.remove('hidden');
    $('#group-panel-title').textContent = g.name;
    $('#empty-state').classList.remove('hidden');
    $('#chat-panel').classList.add('hidden');

    VoiceChat.refreshPanelForGroup(g.id);

    Api.groups.members(g.id).then((data) => {
      AppState.activeMemberIds = data.members.map((m) => m.id);
      renderMembers(data.members);
    });

    loadChannels(g.id);
  }

  function loadChannels(groupId) {
    return Api.channels.list(groupId).then((data) => {
      AppState.activeGroupChannels = data.channels;
      renderChannels();
      // Land on the first text channel automatically, like Discord does.
      const firstText = data.channels.find((c) => c.type === 'text');
      if (firstText) Chat.openChannel(firstText);
    });
  }

  function renderChannels() {
    const container = $('#channel-list');
    container.innerHTML = '';
    if (!AppState.activeGroup) return;

    const isOwner = AppState.activeGroup.ownerId === AppState.me.id;
    const text = AppState.activeGroupChannels.filter((c) => c.type === 'text');
    const voice = AppState.activeGroupChannels.filter((c) => c.type === 'voice');

    container.appendChild(buildCategoryHeader('TEXT CHANNELS', 'text'));
    text.forEach((c) => container.appendChild(buildChannelRow(c, isOwner)));
    if (text.length === 0) container.appendChild(buildEmptyHint('No text channels yet.'));

    container.appendChild(buildCategoryHeader('VOICE CHANNELS', 'voice'));
    voice.forEach((c) => container.appendChild(buildChannelRow(c, isOwner)));
    if (voice.length === 0) container.appendChild(buildEmptyHint('No voice channels yet.'));
  }

  // Re-render without re-fetching, e.g. after switching the active text
  // channel or connecting/disconnecting from a voice channel.
  function refreshChannelHighlight() {
    if (AppState.activeGroup) renderChannels();
  }

  function buildEmptyHint(text) {
    const el = document.createElement('div');
    el.className = 'empty-list-hint';
    el.textContent = text;
    return el;
  }

  function buildCategoryHeader(label, type) {
    const el = document.createElement('div');
    el.className = 'channel-category';
    const span = document.createElement('span');
    span.textContent = label;
    el.appendChild(span);
    const addBtn = document.createElement('button');
    addBtn.className = 'channel-add-btn';
    addBtn.textContent = '+';
    addBtn.title = `Create ${type} channel`;
    addBtn.addEventListener('click', () => openCreateChannelModal(type));
    el.appendChild(addBtn);
    return el;
  }

  function buildChannelRow(c, isOwner) {
    const row = document.createElement('div');
    const isVoice = c.type === 'voice';
    const active = isVoice
      ? VoiceChat.isConnectedTo(c.id)
      : (AppState.activeChat && AppState.activeChat.type === 'channel' && AppState.activeChat.id === c.id);
    row.className = `channel-row ${isVoice ? 'voice-row' : ''} ${active ? 'active' : ''}`;

    const label = document.createElement('span');
    label.className = 'channel-row-label';
    label.textContent = `${isVoice ? '🔊' : '#'} ${c.name}`;
    row.appendChild(label);

    if (isOwner) {
      const delBtn = document.createElement('button');
      delBtn.className = 'channel-delete-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete channel';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete #${c.name}?`)) return;
        Api.channels.remove(c.id)
          .then(() => {
            if (isVoice && VoiceChat.isConnectedTo(c.id)) VoiceChat.leaveCurrent();
            if (!isVoice && AppState.activeChat && AppState.activeChat.id === c.id) {
              AppState.activeChat = null;
              $('#empty-state').classList.remove('hidden');
              $('#chat-panel').classList.add('hidden');
            }
            return loadChannels(AppState.activeGroup.id);
          })
          .catch((err) => alert(err.message));
      });
      row.appendChild(delBtn);
    }

    row.addEventListener('click', () => {
      if (isVoice) {
        if (VoiceChat.isConnectedTo(c.id)) {
          VoiceChat.leaveCurrent();
        } else {
          VoiceChat.joinChannel(c.id, c.name, AppState.activeGroup.id);
        }
      } else {
        Chat.openChannel(c);
      }
    });

    return row;
  }

  function renderMembers(members) {
    const el = $('#group-members-list');
    el.innerHTML = '';
    members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      if (m.id === AppState.activeGroup.ownerId) {
        row.classList.add('owner');
      }
      row.appendChild(avatarWithStatus(m));
      const meta = document.createElement('div');
      meta.className = 'friend-meta';
      const ownerLabel = m.id === AppState.activeGroup.ownerId ? ' 👑' : '';
      meta.innerHTML = `<div class="friend-name">${escapeHtml(m.displayName)}${m.id === AppState.me.id ? ' (you)' : ''}${ownerLabel}</div>`;
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
    showModal('create-group-modal');
  }

  function closeModals() {
    $('#modal-overlay').classList.add('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
  }

  function showModal(id) {
    $('#modal-overlay').classList.remove('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
    $(`#${id}`).classList.remove('hidden');
  }

  function openAddMemberModal() {
    if (!AppState.activeGroup) return;
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
    showModal('add-member-modal');
  }

  function openCreateChannelModal(type) {
    if (!AppState.activeGroup) return;
    setCreateChannelType(type || 'text');
    $('#create-channel-name').value = '';
    $('#create-channel-error').textContent = '';
    showModal('create-channel-modal');
  }

  function setCreateChannelType(type) {
    createChannelType = type;
    $('#channel-type-text').classList.toggle('active', type === 'text');
    $('#channel-type-voice').classList.toggle('active', type === 'voice');
  }

  function leaveActiveGroup() {
    if (!AppState.activeGroup) return;
    if (!confirm(`Leave "${AppState.activeGroup.name}"?`)) return;
    const groupId = AppState.activeGroup.id;
    Api.groups.leave(groupId)
      .then(() => {
        if (VoiceChat.isConnectedToGroup(groupId)) VoiceChat.leaveCurrent();
        AppState.activeGroup = null;
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
        .then(({ group }) =>
          // Seed every new group with a default text + voice channel, same as Discord.
          Promise.all([
            Api.channels.create(group.id, 'general', 'text'),
            Api.channels.create(group.id, 'General', 'voice')
          ]).then(() => group)
        )
        .then((group) => {
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
      const groupId = AppState.activeGroup.id;
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

    $('#channel-type-text').addEventListener('click', () => setCreateChannelType('text'));
    $('#channel-type-voice').addEventListener('click', () => setCreateChannelType('voice'));
    $('#create-channel-cancel').addEventListener('click', closeModals);
    $('#create-channel-confirm').addEventListener('click', () => {
      const name = $('#create-channel-name').value.trim();
      $('#create-channel-error').textContent = '';
      if (!name) return;
      Api.channels.create(AppState.activeGroup.id, name, createChannelType)
        .then(() => {
          closeModals();
          return loadChannels(AppState.activeGroup.id);
        })
        .catch((err) => { $('#create-channel-error').textContent = err.message; });
    });

    const leaveBtn = $('#group-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', leaveActiveGroup);
  }

  return { refresh, open, initUI, refreshChannelHighlight };
})();