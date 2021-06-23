const { getUserDataByToken } = require('./utils/utils.js');
const { increaseConnection, decreaseConnection } = require('./redis-client.js');
const signalingServer = require('./webrtc/signaling-server.js');

module.exports = (io) => {
  process.on('newMessageReceived', (data) => {
    io.emit('newMessageReceived', data);
  });

  process.on('newChannelAdded', (data) => {
    io.emit('newChannelAdded', data);
  });

  process.on('channelDeleted', (data) => {
    io.emit('channelDeleted', data);
  });

  process.on('channelModified', (data) => {
    io.emit('channelModified', data);
  });

  process.on('newVoiceChannelAdded', (data) => {
    io.emit('newVoiceChannelAdded', data);
  });

  process.on('voiceChannelDeleted', (data) => {
    io.emit('voiceChannelDeleted', data);
  });

  process.on('voiceChannelModified', (data) => {
    io.emit('voiceChannelModified', data);
  });

  process.on('userAvatarChanged', (data) => {
    io.emit('userAvatarChanged', data);
  });

  process.on('newUserSignup', (data) => {
    io.emit('newUserSignup', data);
  });

  process.on('messageDeleted', (data) => {
    io.emit('messageDeleted', data);
  });

  process.on('messageModified', (data) => {
    io.emit('messageModified', data);
  });

  io.on('connection', async (socket) => {
    const user = await getUserDataByToken(socket.handshake.auth.token);
    if (user != null) {
      const connections = await increaseConnection(user._id.toString());
      console.log(`a user connected - ${user.username} (${user._id}), connections: ${connections}`);

      socket.user = user;
      signalingServer(io, socket);

      io.emit('userConnected', { userId: user._id, connections });
    } else {
      console.log(`a user connected - unknown user`);
      socket.emit('unauthorized');
    }
    socket.on('disconnect', async () => {
      const user = await getUserDataByToken(socket.handshake.auth.token);
      if (user != null) {
        const connections = await decreaseConnection(user._id.toString());
        console.log(
          `a user disconnected - ${user.username} (${user._id}), connections: ${connections}`
        );

        io.emit('userDisconnected', { userId: user._id, connections });
      } else {
        console.log(`a user disconnected - unknown user`);
      }
    });
  });
};
