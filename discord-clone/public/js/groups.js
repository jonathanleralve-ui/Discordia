// Group rail icons, the channel list + member list shown when a group is
// open, and the create-group / add-member / create-channel modals.
const Groups = (() => {
  const { $, $$, escapeHtml, initials, avatarWithStatus } = Utils;

  let createChannelType = 'text';
  let pendingRenameChannel = null;
  let pendingDeleteChannel = null;

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
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
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

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'channel-actions';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'channel-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.title = 'Channel options';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.toggle('open');
    });

    const menu = document.createElement('div');
    menu.className = 'channel-menu';
    menu.addEventListener('click', (e) => e.stopPropagation());

    const renameBtn = document.createElement('button');
    renameBtn.className = 'channel-menu-item';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.remove('open');
      openRenameChannelModal(c);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'channel-menu-item danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.remove('open');
      openDeleteChannelModal(c);
    });

    menu.appendChild(renameBtn);
    menu.appendChild(deleteBtn);
    actionsWrap.appendChild(menuBtn);
    actionsWrap.appendChild(menu);
    row.appendChild(actionsWrap);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.channel-actions') || e.target.closest('.channel-menu')) return;
      const actionsWrap = row.querySelector('.channel-actions');
      if (actionsWrap) actionsWrap.classList.remove('open');
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
    pendingRenameChannel = null;
    pendingDeleteChannel = null;
    $('#modal-overlay').classList.add('hidden');
    $('#select-group-action-modal').classList.add('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#join-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
    $('#rename-channel-modal').classList.add('hidden');
    $('#delete-channel-modal').classList.add('hidden');
  }

  function showModal(id) {
    $('#modal-overlay').classList.remove('hidden');
    $('#select-group-action-modal').classList.add('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#join-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
    $('#rename-channel-modal').classList.add('hidden');
    $('#delete-channel-modal').classList.add('hidden');
    $(`#${id}`).classList.remove('hidden');
  }

  function openRenameChannelModal(channel) {
    if (!channel) return;
    pendingRenameChannel = channel;
    $('#rename-channel-name').value = channel.name;
    $('#rename-channel-error').textContent = '';
    showModal('rename-channel-modal');
    setTimeout(() => $('#rename-channel-name').focus(), 0);
  }

  function openDeleteChannelModal(channel) {
    if (!channel) return;
    pendingDeleteChannel = channel;
    $('#delete-channel-message').textContent = `Delete #${channel.name}? This action cannot be undone.`;
    showModal('delete-channel-modal');
  }

  function confirmRenameChannel() {
    if (!pendingRenameChannel) return;
    const name = $('#rename-channel-name').value.trim();
    $('#rename-channel-error').textContent = '';
    if (!name) return;
    const cleanName = String(name).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50);
    if (!cleanName || cleanName === pendingRenameChannel.name) {
      $('#rename-channel-error').textContent = 'Choose a different channel name.';
      return;
    }
    Api.channels.rename(pendingRenameChannel.id, cleanName)
      .then(() => {
        closeModals();
        return loadChannels(AppState.activeGroup.id);
      })
      .catch((err) => {
        $('#rename-channel-error').textContent = err.message;
      });
  }

  function confirmDeleteChannel() {
    if (!pendingDeleteChannel) return;
    const channel = pendingDeleteChannel;
    const isVoice = channel.type === 'voice';
    closeModals();
    Api.channels.remove(channel.id)
      .then(() => {
        if (isVoice && VoiceChat.isConnectedTo(channel.id)) VoiceChat.leaveCurrent();
        if (!isVoice && AppState.activeChat && AppState.activeChat.id === channel.id) {
          AppState.activeChat = null;
          $('#empty-state').classList.remove('hidden');
          $('#chat-panel').classList.add('hidden');
        }
        return loadChannels(AppState.activeGroup.id);
      })
      .catch((err) => alert(err.message));
  }

  // Shown when the "+" rail button is clicked — lets the user pick between
  // creating a new group or joining an existing one before any group-specific
  // modal opens.
  function openSelectActionModal() {
    showModal('select-group-action-modal');
  }

  let joinSearchDebounce = null;
  let joinSearchToken = 0;

  function openJoinModal() {
    clearTimeout(joinSearchDebounce);
    joinSearchToken++;
    $('#join-group-search').value = '';
    $('#join-group-results').innerHTML = '';
    $('#join-group-error').textContent = '';
    showModal('join-group-modal');
    $('#join-group-search').focus();
  }

  function buildJoinResultRow(g) {
    const row = document.createElement('div');
    row.className = 'friend-row search-result-row';

    const icon = document.createElement('div');
    icon.className = 'avatar';
    icon.style.background = g.iconColor;
    icon.textContent = initials(g.name);
    row.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    const memberLabel = `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`;
    meta.innerHTML = `<div class="friend-name">${escapeHtml(g.name)}</div><div class="friend-sub">${memberLabel}</div>`;
    row.appendChild(meta);

    const action = document.createElement('div');
    action.className = 'search-result-action';
    row.appendChild(action);

    if (g.isMember) {
      action.classList.add('muted');
      action.textContent = 'Already in it';
    } else if (g.pendingRequest) {
      action.classList.add('muted');
      action.textContent = 'Waiting for approval';
    } else {
      action.classList.add('addable');
      action.textContent = '+ Ask to Join';
      row.classList.add('clickable');
      row.addEventListener('click', () => {
        if (!row.classList.contains('clickable')) return;
        joinFromSearch(g, row, action);
      });
    }

    return row;
  }

  function joinFromSearch(g, row, action) {
    row.classList.remove('clickable');
    row.classList.add('sending');
    action.textContent = 'Requesting...';
    $('#join-group-error').textContent = '';
    Api.groups.requestJoin(g.id)
      .then(() => {
        row.classList.remove('sending');
        action.classList.remove('addable');
        action.classList.add('muted');
        action.textContent = 'Waiting for approval';
      })
      .catch((err) => {
        row.classList.remove('sending');
        row.classList.add('clickable');
        action.textContent = '+ Ask to Join';
        $('#join-group-error').textContent = err.message;
      });
  }

  function renderJoinResults(groupsFound) {
    const el = $('#join-group-results');
    el.innerHTML = '';
    if (groupsFound.length === 0) {
      el.innerHTML = '<div class="empty-list-hint">No matching groups.</div>';
      return;
    }
    groupsFound.forEach((g) => el.appendChild(buildJoinResultRow(g)));
  }

  function runJoinSearch(query) {
    const myToken = ++joinSearchToken;
    if (!query) {
      $('#join-group-results').innerHTML = '';
      return;
    }
    Api.groups.search(query)
      .then((data) => {
        if (myToken !== joinSearchToken) return; // a newer search superseded this one
        renderJoinResults(data.groups);
      })
      .catch(() => {
        if (myToken !== joinSearchToken) return;
        $('#join-group-results').innerHTML = '<div class="empty-list-hint">Search failed, try again.</div>';
      });
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

  // Called when a join request we sent gets accepted (via the group:joined
  // socket event) — refresh the rail and hop into the newly-joined group.
  function handleJoined(g) {
    return refresh().then(() => {
      const joined = AppState.groupsData.find((x) => x.id === g.id);
      if (joined) open(joined);
    });
  }

  function initUI() {
    // A channel's "..." menu opens on click; clicking anywhere else in the
    // document (another channel, the chat area, etc.) should close it,
    // instead of requiring the user to click the same button again.
    document.addEventListener('click', (e) => {
      if (e.target.closest('.channel-actions')) return;
      $$('.channel-actions.open').forEach((el) => el.classList.remove('open'));
    });

    $('#rail-add-group').addEventListener('click', openSelectActionModal);

    $('#select-group-action-cancel').addEventListener('click', closeModals);
    $('#select-create-group').addEventListener('click', openCreateModal);
    $('#select-join-group').addEventListener('click', openJoinModal);

    $('#create-group-cancel').addEventListener('click', closeModals);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModals();
    });

    $('#join-group-cancel').addEventListener('click', closeModals);
    $('#join-group-search').addEventListener('input', () => {
      const query = $('#join-group-search').value.trim();
      $('#join-group-error').textContent = '';
      clearTimeout(joinSearchDebounce);
      joinSearchDebounce = setTimeout(() => runJoinSearch(query), 250);
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

    $('#rename-channel-cancel').addEventListener('click', closeModals);
    $('#rename-channel-confirm').addEventListener('click', confirmRenameChannel);
    $('#delete-channel-cancel').addEventListener('click', closeModals);
    $('#delete-channel-confirm').addEventListener('click', confirmDeleteChannel);

    const leaveBtn = $('#group-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', leaveActiveGroup);
  }

  return { refresh, open, initUI, refreshChannelHighlight, handleJoined };
})();