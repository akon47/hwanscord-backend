const { getUserIdByToken } = require('./utils/utils.js');
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
    const userid = await getUserIdByToken(socket.handshake.auth.token);
    if (userid != null) {
      const connections = await increaseConnection(userid);
      console.log(`a user connected - ${userid}, connections: ${connections}`);

      signalingServer(socket);

      io.emit('userConnected', { userid, connections });
    } else {
      console.log(`a user connected - unknown user`);
      socket.emit('unauthorized');
    }
    socket.on('disconnect', async () => {
      const userid = await getUserIdByToken(socket.handshake.auth.token);
      if (userid != null) {
        const connections = await decreaseConnection(userid);
        console.log(
          `a user disconnected - ${userid}, connections: ${connections}`
        );

        io.emit('userDisconnected', { userid, connections });
      } else {
        console.log(`a user disconnected - unknown user`);
      }
    });
  });
};
