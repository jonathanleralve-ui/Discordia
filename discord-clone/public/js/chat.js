// The message pane: opening a DM or text channel, loading history, sending
// new messages, and reacting to realtime message/typing events from
// SocketClient.
const Chat = (() => {
  const { $, escapeHtml, initials, formatTime, avatarEl } = Utils;

  let typingTimeout = null;
  const typingClearTimers = {};
  let pendingFile = null;
  let pendingFileUrl = null;
  const MAX_UPLOAD_MB = 25;

  function openDM(friend) {
    AppState.activeGroup = null;
    AppState.activeChat = { type: 'dm', id: friend.id, name: friend.displayName, color: friend.avatarColor };
    App.setActiveRail($('#rail-home'));
    $('#sidebar-header').textContent = 'Friends';
    VoiceChat.refreshPanelForGroup(null);
    openChatWindow();
  }

  function openChannel(channel) {
    AppState.activeChat = {
      type: 'channel',
      id: channel.id,
      name: channel.name,
      groupId: channel.groupId
    };
    if (AppState.socket) AppState.socket.emit('channel:join', channel.id);
    openChatWindow();
    Groups.refreshChannelHighlight();
  }

  function openChatWindow() {
    const chat = AppState.activeChat;
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#chat-panel').classList.remove('hidden');
    $('#chat-title').textContent = chat.type === 'dm' ? `@${chat.name}` : `# ${chat.name}`;
    $('#chat-messages').innerHTML = '';
    $('#typing-indicator').textContent = '';
    loadHistory();
    $('#chat-input').value = '';
    $('#chat-input').focus();
    clearPendingFile();
  }

  function loadHistory() {
    const chat = AppState.activeChat;
    const request = chat.type === 'dm' ? Api.messages.dmHistory(chat.id) : Api.messages.channelHistory(chat.id);
    request.then((data) => {
      $('#chat-messages').innerHTML = '';
      data.messages.forEach((m) => appendMessage(m));
      scrollToBottom();
    }).catch((err) => {
      $('#chat-messages').innerHTML = `<div class="empty-list-hint">${escapeHtml(err.message)}</div>`;
    });
  }

  function appendMessage(m) {
    if (m.messageType === 'join_request') {
      appendJoinRequestMessage(m);
      return;
    }
    if (m.messageType === 'system') {
      appendSystemMessage(m);
      return;
    }

    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `message-row ${m.senderId === AppState.me.id ? 'own' : ''}`;

    const av = avatarEl({
      displayName: m.senderName,
      avatarColor: m.senderColor,
      avatarUrl: m.senderAvatarUrl
    });
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
    if (m.content) body.querySelector('.message-content').textContent = m.content;
    if (m.attachment) body.appendChild(renderAttachment(m.attachment));
    row.appendChild(body);
    list.appendChild(row);
    scrollToBottom();
  }

  function appendSystemMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row system-message-row';
    row.innerHTML = `
      <div class="system-message-line">
        <span class="system-message-icon">•</span>
        <span class="system-message-text">${escapeHtml(m.content)}</span>
        <span class="message-time">${formatTime(m.createdAt)}</span>
      </div>
    `;
    list.appendChild(row);
    scrollToBottom();
  }

  function appendJoinRequestMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row join-request-row';
    row.dataset.requestId = m.joinRequest.id;

    const av = avatarEl({
      displayName: m.senderName,
      avatarColor: m.senderColor,
      avatarUrl: m.senderAvatarUrl
    });
    row.appendChild(av);

    // The card is only ever shown inside the group being requested, so pull
    // the server name/color and the current channel name from local state
    // rather than the message payload.
    const group = AppState.activeGroup;
    const groupName = group ? group.name : 'this server';
    const groupColor = group ? group.iconColor : 'var(--blurple)';
    const groupIconUrl = group ? group.iconUrl : null;
    const channel = AppState.activeGroupChannels.find((c) => c.id === m.channelId);
    const channelName = channel ? channel.name : (AppState.activeChat ? AppState.activeChat.name : 'general');
    const isMe = m.senderId === AppState.me.id;

    const groupIconInner = groupIconUrl
      ? `<img src="${escapeHtml(groupIconUrl)}" alt="${escapeHtml(groupName)}">`
      : escapeHtml(initials(groupName));

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = `
      <div class="invite-card">
        <div class="invite-card-label">${isMe ? 'You sent an invite to join a server' : `${escapeHtml(m.senderName)} wants to join a server`}</div>
        <div class="invite-card-body">
          <div class="invite-card-icon" style="background: ${groupColor}">${groupIconInner}</div>
          <div class="invite-card-info">
            <div class="invite-card-server-name">${escapeHtml(groupName)}</div>
            <div class="invite-card-channel"># ${escapeHtml(channelName)}</div>
          </div>
          <button type="button" class="btn-invite-accept join-request-accept-btn">Accept</button>
          <button type="button" class="btn-invite-decline join-request-decline-btn">Decline</button>
          <span class="join-request-resolved-label hidden">Accepted ✓</span>
          <span class="join-request-declined-label hidden">Declined ✕</span>
        </div>
      </div>
    `;
    row.appendChild(body);
    list.appendChild(row);

    applyJoinRequestState(row, m.joinRequest);

    body.querySelector('.join-request-accept-btn').addEventListener('click', () => {
      const btn = body.querySelector('.join-request-accept-btn');
      btn.disabled = true;
      btn.textContent = 'Accepting...';
      Api.groups.acceptJoinRequest(m.joinRequest.groupId, m.joinRequest.id)
        .then(() => applyJoinRequestState(row, { status: 'accepted' }))
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = 'Accept';
          alert(err.message);
        });
    });

    body.querySelector('.join-request-decline-btn').addEventListener('click', () => {
      const btn = body.querySelector('.join-request-decline-btn');
      btn.disabled = true;
      btn.textContent = 'Declining...';
      Api.groups.declineJoinRequest(m.joinRequest.groupId, m.joinRequest.id)
        .then(() => applyJoinRequestState(row, { status: 'declined' }))
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = 'Decline';
          alert(err.message);
        });
    });

    scrollToBottom();
  }

  function applyJoinRequestState(row, joinRequest) {
    const acceptBtn = row.querySelector('.join-request-accept-btn');
    const declineBtn = row.querySelector('.join-request-decline-btn');
    const acceptedLabel = row.querySelector('.join-request-resolved-label');
    const declinedLabel = row.querySelector('.join-request-declined-label');
    if (joinRequest.status === 'accepted') {
      acceptBtn.classList.add('hidden');
      declineBtn.classList.add('hidden');
      acceptedLabel.classList.remove('hidden');
      declinedLabel.classList.add('hidden');
    } else if (joinRequest.status === 'declined') {
      acceptBtn.classList.add('hidden');
      declineBtn.classList.add('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.remove('hidden');
    } else {
      acceptBtn.classList.remove('hidden');
      declineBtn.classList.remove('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.add('hidden');
    }
  }

  function isImage(type) { return /^image\//.test(type || ''); }
  function isVideo(type) { return /^video\//.test(type || ''); }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function renderAttachment(att) {
    if (isImage(att.type)) {
      const link = document.createElement('a');
      link.href = att.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'attachment-image-link';
      link.title = 'Click to view full size';
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.name || 'image attachment';
      img.className = 'attachment-image';
      link.appendChild(img);
      // Plain click opens an in-app full-resolution lightbox instead of
      // navigating away (which loses the original pixel data to the
      // browser's own fit-to-window downscaling). Ctrl/Cmd/middle-click
      // still falls through to opening the raw file in a new tab.
      link.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        openLightbox(att.url, att.name);
      });
      return link;
    }
    if (isVideo(att.type)) {
      const video = document.createElement('video');
      video.src = att.url;
      video.controls = true;
      video.className = 'attachment-video';
      return video;
    }
    const chip = document.createElement('a');
    chip.href = att.url;
    chip.download = att.name || '';
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.className = 'attachment-file-chip';
    chip.innerHTML = `
      <span class="attachment-file-icon">📄</span>
      <span class="attachment-file-info">
        <span class="attachment-file-name"></span>
        <span class="attachment-file-size">${escapeHtml(formatBytes(att.size))}</span>
      </span>
    `;
    chip.querySelector('.attachment-file-name').textContent = att.name || 'file';
    return chip;
  }

  function openLightbox(url, name) {
    let overlay = $('#lightbox-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lightbox-overlay';
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = `
        <a class="lightbox-open-original" target="_blank" rel="noopener noreferrer">Open original ↗</a>
        <img class="lightbox-img" />
      `;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeLightbox();
      });
      document.body.appendChild(overlay);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLightbox();
      });
    }
    overlay.querySelector('.lightbox-img').src = url;
    overlay.querySelector('.lightbox-img').alt = name || '';
    overlay.querySelector('.lightbox-open-original').href = url;
    overlay.classList.add('open');
  }

  function closeLightbox() {
    const overlay = $('#lightbox-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function scrollToBottom() {
    const el = $('#chat-messages');
    el.scrollTop = el.scrollHeight;
  }

  function sendMessage() {
    const input = $('#chat-input');
    const content = input.value.trim();
    const chat = AppState.activeChat;
    if ((!content && !pendingFile) || !chat) return;

    const file = pendingFile;
    input.value = '';
    clearPendingFile();

    if (file) {
      setSendDisabled(true);
      Api.messages.upload(file)
        .then((attachment) => emitMessage(chat, content, attachment))
        .catch((err) => {
          $('#typing-indicator').textContent = err.message;
        })
        .finally(() => setSendDisabled(false));
    } else {
      emitMessage(chat, content, null);
    }
  }

  function emitMessage(chat, content, attachment) {
    if (chat.type === 'dm') {
      AppState.socket.emit('dm:send', { recipientId: chat.id, content, attachment });
    } else {
      AppState.socket.emit('channel:send', { channelId: chat.id, content, attachment });
    }
  }

  function setSendDisabled(disabled) {
    $('#chat-send').disabled = disabled;
    $('#chat-attach-btn').disabled = disabled;
  }

  function onFileSelected(file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      $('#typing-indicator').textContent = `File is too large (max ${MAX_UPLOAD_MB}MB)`;
      return;
    }
    pendingFile = file;
    renderPendingFile();
  }

  function renderPendingFile() {
    const preview = $('#attachment-preview');
    if (!pendingFile) {
      preview.classList.add('hidden');
      preview.classList.remove('media');
      preview.innerHTML = '';
      return;
    }
    preview.classList.remove('hidden');

    const showThumb = isImage(pendingFile.type) || isVideo(pendingFile.type);
    pendingFileUrl = showThumb ? URL.createObjectURL(pendingFile) : null;

    if (showThumb) {
      preview.classList.add('media');
      preview.innerHTML = `
        <div class="attachment-preview-card">
          <div class="attachment-preview-toolbar">
            <button type="button" class="attachment-preview-tool" id="attachment-preview-view" title="View">👁</button>
            <button type="button" class="attachment-preview-tool" id="attachment-preview-remove" title="Remove">🗑</button>
          </div>
          <div class="attachment-preview-media"></div>
          <div class="attachment-preview-caption"></div>
        </div>
      `;
      const mediaWrap = preview.querySelector('.attachment-preview-media');
      if (isImage(pendingFile.type)) {
        const img = document.createElement('img');
        img.src = pendingFileUrl;
        mediaWrap.appendChild(img);
      } else {
        const video = document.createElement('video');
        video.src = pendingFileUrl;
        video.muted = true;
        mediaWrap.appendChild(video);
      }
      preview.querySelector('.attachment-preview-caption').textContent = pendingFile.name;
      preview.querySelector('#attachment-preview-view').addEventListener('click', () => openLightbox(pendingFileUrl, pendingFile.name));
      preview.querySelector('#attachment-preview-remove').addEventListener('click', clearPendingFile);
    } else {
      preview.classList.remove('media');
      preview.innerHTML = `
        <span class="attachment-preview-name"></span>
        <span class="attachment-preview-size">${escapeHtml(formatBytes(pendingFile.size))}</span>
        <button type="button" class="attachment-preview-remove" id="attachment-preview-remove">✕</button>
      `;
      preview.querySelector('.attachment-preview-name').textContent = pendingFile.name;
      preview.querySelector('#attachment-preview-remove').addEventListener('click', clearPendingFile);
    }
  }

  function clearPendingFile() {
    pendingFile = null;
    if (pendingFileUrl) {
      URL.revokeObjectURL(pendingFileUrl);
      pendingFileUrl = null;
    }
    $('#chat-file-input').value = '';
    renderPendingFile();
  }

  function emitTyping() {
    const chat = AppState.activeChat;
    if (!chat || !AppState.socket) return;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      AppState.socket.emit('typing', { scope: chat.type, id: chat.id });
    }, 150);
  }

  function showTyping(key) {
    const el = $('#typing-indicator');
    el.textContent = 'Someone is typing...';
    clearTimeout(typingClearTimers[key]);
    typingClearTimers[key] = setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ---- Called by SocketClient for incoming realtime events ----

  function handleIncomingMessage(kind, msg) {
    const chat = AppState.activeChat;
    if (!chat) return;
    if (kind === 'dm' && chat.type === 'dm' && (msg.senderId === chat.id || msg.recipientId === chat.id)) {
      appendMessage(msg);
    } else if (kind === 'channel' && chat.type === 'channel' && msg.channelId === chat.id) {
      appendMessage(msg);
    }
  }

  function handleTypingEvent(scope, from, channelId) {
    const chat = AppState.activeChat;
    if (!chat) return;
    if (scope === 'dm' && chat.type === 'dm' && from === chat.id) {
      showTyping(`dm-${from}`);
    } else if (scope === 'channel' && chat.type === 'channel' && channelId === chat.id) {
      showTyping(`c${channelId}-${from}`);
    }
  }

  function handleJoinRequestResolved(requestId, status) {
    const row = document.querySelector(`.join-request-row[data-request-id="${requestId}"]`);
    if (!row) return;
    applyJoinRequestState(row, { status });
  }

  function initUI() {
    $('#chat-send').addEventListener('click', sendMessage);
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      } else {
        emitTyping();
      }
    });
    $('#chat-attach-btn').addEventListener('click', () => $('#chat-file-input').click());
    $('#chat-file-input').addEventListener('change', (e) => onFileSelected(e.target.files[0]));
  }

  return {
    openDM,
    openChannel,
    openChatWindow,
    handleIncomingMessage,
    handleTypingEvent,
    handleJoinRequestResolved,
    initUI
  };
})();