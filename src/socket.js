const { getUserDataByToken } = require('./utils/utils.js');
const { increaseConnection, decreaseConnection } = require('./redis-client.js');
const signalingServer = require('./webrtc/signaling-server.js');

function attachProcessEvent(event, io) {
  process.on(event, (data) => {
    io.emit(event, data);
  });
}

module.exports = (io) => {
  attachProcessEvent('newMessageReceived', io);
  attachProcessEvent('newChannelAdded', io);
  attachProcessEvent('channelDeleted', io);
  attachProcessEvent('channelModified', io);
  attachProcessEvent('newVoiceChannelAdded', io);
  attachProcessEvent('voiceChannelDeleted', io);
  attachProcessEvent('voiceChannelModified', io);
  attachProcessEvent('userAvatarChanged', io);
  attachProcessEvent('newUserSignup', io);
  attachProcessEvent('messageDeleted', io);
  attachProcessEvent('messageModified', io);

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
