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

    socket.on('group:message', (msg) => {
      Chat.handleIncomingMessage('group', msg);
    });

    socket.on('typing', ({ scope, from, groupId }) => {
      Chat.handleTypingEvent(scope, from, groupId);
    });

    socket.on('error:message', ({ error }) => {
      alert(error);
    });

    return socket;
  }

  return { connect };
})();
