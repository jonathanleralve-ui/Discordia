// Voice channel membership + WebRTC signaling relay (mesh topology, one
// RTCPeerConnection per pair — the actual media never touches the server,
// we just relay offers/answers/ICE candidates between peers).

// groupId -> Map of socketId -> { userId, displayName, avatarColor, sharing }
const voiceRooms = new Map();

function voiceRoom(groupId) {
  if (!voiceRooms.has(groupId)) voiceRooms.set(groupId, new Map());
  return voiceRooms.get(groupId);
}

function voicePeerList(groupId) {
  return Array.from(voiceRoom(groupId).entries()).map(([socketId, info]) => ({
    socketId,
    ...info
  }));
}

function leaveVoiceChannel(io, socket, groupId) {
  if (!groupId) return;
  const room = voiceRoom(groupId);
  if (room.has(socket.id)) {
    room.delete(socket.id);
    socket.leave(`voice:${groupId}`);
    io.to(`voice:${groupId}`).emit('voice:peer-left', { socketId: socket.id });
  }
  if (socket.currentVoiceGroup === groupId) socket.currentVoiceGroup = null;
  if (room.size === 0) voiceRooms.delete(groupId);
}

function registerVoiceHandlers(io, socket, db) {
  const uid = socket.userId;

  socket.on('voice:join', async ({ groupId }) => {
    try {
      const gid = Number(groupId);
      const isMember = await db.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [gid, uid]
      );
      if (isMember.rows.length === 0) {
        socket.emit('error:message', { error: 'Not a member of this group' });
        return;
      }

      // A socket can only be in one voice channel at a time — leave any previous one first
      if (socket.currentVoiceGroup) {
        leaveVoiceChannel(io, socket, socket.currentVoiceGroup);
      }

      const userResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const user = userResult.rows[0];

      // Tell the joining client who is already in the channel, so it can initiate connections to each
      socket.emit('voice:existing-peers', { peers: voicePeerList(gid) });

      const info = { userId: uid, displayName: user.display_name, avatarColor: user.avatar_color, sharing: false };
      voiceRoom(gid).set(socket.id, info);
      socket.currentVoiceGroup = gid;
      socket.join(`voice:${gid}`);

      socket.to(`voice:${gid}`).emit('voice:peer-joined', { socketId: socket.id, ...info });
    } catch (err) {
      console.error('voice:join error', err);
      socket.emit('error:message', { error: 'Failed to join voice channel' });
    }
  });

  socket.on('voice:leave', ({ groupId }) => {
    leaveVoiceChannel(io, socket, Number(groupId));
  });

  // Relay WebRTC offers/answers/ICE candidates directly to a specific peer socket
  socket.on('voice:signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  socket.on('voice:screen-share-toggle', ({ groupId, sharing }) => {
    const gid = Number(groupId);
    const room = voiceRoom(gid);
    const info = room.get(socket.id);
    if (!info) return;
    info.sharing = !!sharing;
    io.to(`voice:${gid}`).emit('voice:peer-screen-update', { socketId: socket.id, sharing: info.sharing });
  });
}

module.exports = { registerVoiceHandlers, leaveVoiceChannel };
