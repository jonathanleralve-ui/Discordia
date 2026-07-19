// Small shared mutable state object. Every other frontend module reads/writes
// through this instead of holding its own copies, so there's one source of truth.
const AppState = {
  token: localStorage.getItem('chatter_token') || null,
  me: null,
  socket: null,

  friendsData: { friends: [], incoming: [], outgoing: [] },
  groupsData: [],

  // The group currently open in the sidebar (null when on the Friends home screen)
  activeGroup: null,
  // Channels of the currently open group: [{ id, groupId, name, type, category, position }]
  activeGroupChannels: [],

  // Currently open chat in the main pane: { type: 'dm'|'channel', id, name, color?, groupId? }
  activeChat: null,
  activeMemberIds: []
};