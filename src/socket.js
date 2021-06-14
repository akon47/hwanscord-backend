const { getUserIdByToken } = require("./utils/utils.js");
const { increaseConnection, decreaseConnection } = require("./redis-client.js");

module.exports = (io) => {
  process.on("newMessageReceived", (data) => {
    console.log("newMessageReceived");
    io.emit("newMessageReceived", data);
  });

  io.on("connection", async (socket) => {
    const userid = await getUserIdByToken(socket.handshake.auth.token);
    if (userid != null) {
      const connections = await increaseConnection(userid);
      console.log(`a user connected - ${userid}, connections: ${connections}`);

      io.emit("userConnected", { userid, connections });
    } else {
      console.log(`a user connected - unknown user`);
    }
    socket.on("disconnect", async () => {
      const userid = await getUserIdByToken(socket.handshake.auth.token);
      if (userid != null) {
        const connections = await decreaseConnection(userid);
        console.log(`a user disconnected - ${userid}, connections: ${connections}`);

        io.emit("userDisconnected", { userid, connections });
      } else {
        console.log(`a user disconnected - unknown user`);
      }
    });
  });
};
