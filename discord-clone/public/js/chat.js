// The message pane: opening a DM or text channel, loading history, sending
// new messages, and reacting to realtime message/typing events from
// SocketClient.
const Chat = (() => {
  const { $, escapeHtml, initials, formatTime } = Utils;

  let typingTimeout = null;
  const typingClearTimers = {};
  let pendingFile = null;
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
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `message-row ${m.senderId === AppState.me.id ? 'own' : ''}`;

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
    if (m.content) body.querySelector('.message-content').textContent = m.content;
    if (m.attachment) body.appendChild(renderAttachment(m.attachment));
    row.appendChild(body);
    list.appendChild(row);
    scrollToBottom();
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
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.name || 'image attachment';
      img.className = 'attachment-image';
      link.appendChild(img);
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
      preview.innerHTML = '';
      return;
    }
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <span class="attachment-preview-name"></span>
      <span class="attachment-preview-size">${escapeHtml(formatBytes(pendingFile.size))}</span>
      <button type="button" class="attachment-preview-remove" id="attachment-preview-remove">✕</button>
    `;
    preview.querySelector('.attachment-preview-name').textContent = pendingFile.name;
    preview.querySelector('#attachment-preview-remove').addEventListener('click', clearPendingFile);
  }

  function clearPendingFile() {
    pendingFile = null;
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
    initUI
  };
})();