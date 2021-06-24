const express = require('express');
const app = express();
const httpServer = require('http').createServer(app);
const io = require('socket.io')(httpServer, {
  cors: {
    origin: ['https://kimhwan.kr', 'https://www.kimhwan.kr'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  allowEIO3: false,
  serveClient: false,
});

const cors = require('cors');
const db = require('./db.js');

const socketEvents = require('./socket.js');

const { authenticateUser } = require('./utils/utils.js');

const auth = require('./api/auth.js');
const channels = require('./api/channels.js');
const voiceChannels = require('./api/voiceChannels.js');
const messages = require('./api/messages.js');
const users = require('./api/users.js');
const docs = require('./utils/api-doc.js');

const avatar = require('./api/upload/avatar.js');
const attachments = require('./api/upload/attachments.js');

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// routers
app.use('/', auth);
app.use('/channels', authenticateUser, channels);
app.use('/voice-channels', authenticateUser, voiceChannels);
app.use('/messages', authenticateUser, messages);
app.use('/users', authenticateUser, users);
app.use('/api', docs);

app.use('/avatar', avatar);
app.use('/attachments', attachments);

setTimeout(() => {
  db();

  socketEvents(io);

  const port = 8080;
  httpServer.listen(port, () => {
    console.log(`API server app listening at http://localhost:${port}`);
  });
}, 3000); // wait for db
