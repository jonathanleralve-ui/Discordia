// Thin wrapper around fetch() for the /api/* backend, plus typed methods per
// resource so callers never hand-build a URL or a fetch options object.
const Api = (() => {
  function request(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (AppState.token) headers['Authorization'] = `Bearer ${AppState.token}`;
    return fetch(`/api${path}`, Object.assign({}, options, { headers })).then(async (res) => {
      let data = {};
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    });
  }

  const auth = {
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    register: (username, password, displayName) =>
      request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) }),
    me: () => request('/auth/me'),
    updateMe: (displayName, avatarColor, avatarUrl) =>
      request('/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName, avatarColor, avatarUrl }) })
  };

  const friends = {
    list: () => request('/friends'),
    search: (q) => request(`/friends/search?q=${encodeURIComponent(q)}`),
    sendRequest: (username) =>
      request('/friends/request', { method: 'POST', body: JSON.stringify({ username }) }),
    accept: (friendshipId) => request(`/friends/${friendshipId}/accept`, { method: 'POST' }),
    remove: (friendshipId) => request(`/friends/${friendshipId}`, { method: 'DELETE' })
  };

  const groups = {
    list: () => request('/groups'),
    create: (name, memberIds) =>
      request('/groups', { method: 'POST', body: JSON.stringify({ name, memberIds }) }),
    search: (q) => request(`/groups/search?q=${encodeURIComponent(q)}`),
    requestJoin: (groupId) => request(`/groups/${groupId}/join-requests`, { method: 'POST' }),
    acceptJoinRequest: (groupId, requestId) =>
      request(`/groups/${groupId}/join-requests/${requestId}/accept`, { method: 'POST' }),
    members: (groupId) => request(`/groups/${groupId}/members`),
    addMember: (groupId, userId) =>
      request(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
    rename: (groupId, name, iconUrl) =>
      request(`/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ name, iconUrl }) }),
    leave: (groupId) => request(`/groups/${groupId}/members/me`, { method: 'DELETE' })
  };

  // Text/voice channels live inside a group, same as Discord.
  const channels = {
    list: (groupId) => request(`/groups/${groupId}/channels`),
    create: (groupId, name, type) =>
      request(`/groups/${groupId}/channels`, { method: 'POST', body: JSON.stringify({ name, type }) }),
    rename: (channelId, name) =>
      request(`/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    remove: (channelId) => request(`/channels/${channelId}`, { method: 'DELETE' })
  };

  const messages = {
    dmHistory: (userId) => request(`/messages/dm/${userId}`),
    channelHistory: (channelId) => request(`/messages/channel/${channelId}`),
    // Multipart upload: don't set Content-Type ourselves, the browser needs
    // to add the multipart boundary.
    upload: (file) => {
      const formData = new FormData();
      formData.append('file', file);
      const headers = {};
      if (AppState.token) headers['Authorization'] = `Bearer ${AppState.token}`;
      return fetch('/api/upload', { method: 'POST', headers, body: formData }).then(async (res) => {
        let data = {};
        try { data = await res.json(); } catch (e) { /* no body */ }
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        return data;
      });
    }
  };

  return { request, auth, friends, groups, channels, messages };
})();