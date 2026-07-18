// Small shared mutable state object. Every other frontend module reads/writes
// through this instead of holding its own copies, so there's one source of truth.
const AppState = {
  token: localStorage.getItem('chatter_token') || null,
  me: null,
  socket: null,

  friendsData: { friends: [], incoming: [], outgoing: [] },
  groupsData: [],

  // Currently open chat: { type: 'dm'|'group', id, name, color? }
  activeChat: null,
  activeMemberIds: []
};
