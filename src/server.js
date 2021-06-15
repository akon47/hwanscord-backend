const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: "http://kimhwan.kr:8082",
    credentials: true,
    methods: ["GET", "POST"],
    transports: ["websocket", "polling"],
  },
  allowEIO3: true,
});

const cors = require("cors");
const db = require("./db.js");

const socketEvents = require("./socket.js");

const { authenticateUser } = require("./utils/utils.js");

const auth = require("./api/auth.js");
const messages = require("./api/messages.js");
const users = require("./api/users.js");
const docs = require("./utils/api-doc.js");

const avatar = require("./upload/avatar.js");
const attachments = require("./upload/attachments.js");

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// routers
app.use("/", auth);
app.use("/messages", authenticateUser, messages);
app.use("/users", authenticateUser, users);
app.use("/api", docs);

app.use("/avatar", avatar);
app.use("/attachments", attachments);

setTimeout(() => {
  db();

  socketEvents(io);

  const port = 8080;
  server.listen(port, () => {
    console.log(`API server app listening at http://localhost:${port}`);
  });
}, 3000); // wait for db
