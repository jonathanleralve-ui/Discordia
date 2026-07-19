// The message pane: opening a DM or text channel, loading history, sending
// new messages, and reacting to realtime message/typing events from
// SocketClient.
const Chat = (() => {
  const { $, escapeHtml, initials, formatTime } = Utils;

  let typingTimeout = null;
  const typingClearTimers = {};

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
      AppState.socket.emit('channel:send', { channelId: chat.id, content });
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