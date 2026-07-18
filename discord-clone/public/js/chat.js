// The message pane: opening a DM or group, loading history, sending new
// messages, and reacting to realtime message/typing events from SocketClient.
const Chat = (() => {
  const { $, escapeHtml, initials, formatTime } = Utils;

  let typingTimeout = null;
  const typingClearTimers = {};

  function openDM(friend) {
    AppState.activeChat = { type: 'dm', id: friend.id, name: friend.displayName, color: friend.avatarColor };
    App.setActiveRail($('#rail-home'));
    $('#sidebar-header').textContent = 'Friends';
    VoiceChat.hidePanel();
    openChatWindow();
  }

  function openChatWindow() {
    const chat = AppState.activeChat;
    $('#empty-state').classList.add('hidden');
    $('#chat-panel').classList.remove('hidden');
    $('#chat-title').textContent = chat.type === 'dm' ? `@${chat.name}` : `# ${chat.name}`;
    $('#chat-messages').innerHTML = '';
    $('#typing-indicator').textContent = '';
    loadHistory();
    $('#chat-input').value = '';
    $('#chat-input').focus();
  }

  function loadHistory() {
    const chat = AppState.activeChat;
    const request = chat.type === 'dm' ? Api.messages.dmHistory(chat.id) : Api.messages.groupHistory(chat.id);
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
    body.querySelector('.message-content').textContent = m.content;
    row.appendChild(body);
    list.appendChild(row);
    scrollToBottom();
  }

  function scrollToBottom() {
    const el = $('#chat-messages');
    el.scrollTop = el.scrollHeight;
  }

  function sendMessage() {
    const input = $('#chat-input');
    const content = input.value.trim();
    const chat = AppState.activeChat;
    if (!content || !chat) return;
    input.value = '';

    if (chat.type === 'dm') {
      AppState.socket.emit('dm:send', { recipientId: chat.id, content });
    } else {
      AppState.socket.emit('group:send', { groupId: chat.id, content });
    }
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
    } else if (kind === 'group' && chat.type === 'group' && msg.groupId === chat.id) {
      appendMessage(msg);
    }
  }

  function handleTypingEvent(scope, from, groupId) {
    const chat = AppState.activeChat;
    if (!chat) return;
    if (scope === 'dm' && chat.type === 'dm' && from === chat.id) {
      showTyping(chat.id);
    } else if (scope === 'group' && chat.type === 'group' && groupId === chat.id) {
      showTyping(`g${groupId}-${from}`);
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
  }

  return {
    openDM,
    openChatWindow,
    handleIncomingMessage,
    handleTypingEvent,
    initUI
  };
})();
