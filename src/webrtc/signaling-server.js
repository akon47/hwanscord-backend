var channels = {};
var sockets = {};

module.exports = (socket) => {
  socket.channels = {};
  sockets[socket.id] = socket;

  console.log(`SignalingServer: ${socket.id} connection accepted`);
  socket.on('disconnect', async () => {
    console.log(`SignalingServer: ${socket.id} disconnected`);
    delete sockets[socket.id];
  });
};
