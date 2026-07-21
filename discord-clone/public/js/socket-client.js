// Owns the single socket.io connection and routes incoming realtime events
// to whichever module cares about them. Chat.js / Friends.js expose small
// handler functions for this to call instead of reaching into their internals.
const SocketClient = (() => {
  function connect() {
    AppState.socket = io({ auth: { token: AppState.token } });
    const socket = AppState.socket;

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });

    socket.on('presence:update', ({ userId, status }) => {
      Friends.handlePresenceUpdate(userId, status);
    });

    socket.on('dm:message', (msg) => {
      Chat.handleIncomingMessage('dm', msg);
    });

    socket.on('channel:message', (msg) => {
      Chat.handleIncomingMessage('channel', msg);
    });

    socket.on('message:deleted', ({ id }) => {
      Chat.handleMessageDeleted(id);
    });

    socket.on('group:join-request-resolved', ({ requestId, status }) => {
      Chat.handleJoinRequestResolved(requestId, status);
    });

    socket.on('group:joined', ({ group }) => {
      Groups.handleJoined(group);
    });

    socket.on('typing', ({ scope, from, channelId }) => {
      Chat.handleTypingEvent(scope, from, channelId);
    });

    socket.on('error:message', ({ error }) => {
      alert(error);
    });

    return socket;
  }

  return { connect };
})();