module.exports = (io) => {
  process.on("newMessageReceived", (data) => {
    console.log("newMessageReceived");
    io.emit("newMessageReceived", data);
  });

  io.on("connection", (socket) => {
    console.log("a user connected");
    socket.on("disconnect", () => {
      console.log("user disconnected");
    });
  });
};
