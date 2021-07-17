var channels = {};
var sockets = {};

module.exports = (io, socket) => {
  socket.channels = {};
  sockets[socket.id] = socket;

  console.log(`SignalingServer: ${socket.id} connection accepted`);

  socket.on('disconnect', async () => {
    console.log(`SignalingServer: ${socket.id} disconnected`);
    for (const channel in socket.channels) {
      partVoiceChannel(channel);
    }
    delete sockets[socket.id];
  });

  socket.on('getVoiceChannelPeers', (data) => {
    const { channel } = data;

    let peers = [];
    if (channel in channels) {
      for (id in channels[channel]) {
        peers.push({ socketId: id, user: channels[channel][id].user });
      }
    }
    socket.emit('getVoiceChannelPeers', { channelId: channel, peers: peers });
  });

  socket.on('createScreenShareChannel', () => {
    console.log(`SignalingServer: ${socket.id} createScreenShareChannel`);

    const screenChannel = socket.id;
    if (screenChannel in socket.channels) {
      console.log(`[${socket.id}] ERROR: already joined `, channel);
      return;
    }

    for (const channel in socket.channels) {
      partVoiceChannel(channel);
    }

    if (!(screenChannel in channels)) {
      channels[screenChannel] = {};
    }

    channels[screenChannel][socket.id] = socket;
    socket.channels[screenChannel] = screenChannel;
    
    io.emit('createScreenShareChannel', {
      user: socket.user,
      channelId: screenChannel,
    });

    io.emit('voiceChannelJoined', {
      channelId: screenChannel,
      user: socket.user,
      socketId: socket.id,
    });
  });

  socket.on('getScreenShareChannels', (data) => {
    let screenShareChannels = [];
    for(socketId in sockets) {
      if(channels[socketId] !== undefined) {
        screenShareChannels.push({
          user: sockets[socketId].user,
          channelId: socketId,
        });
      }
    }

    socket.emit('getScreenShareChannels', { channels: screenShareChannels });
  });

  socket.on('joinVoiceChannel', (data) => {
    console.log(`SignalingServer: ${socket.id} joinVoiceChannel`, data);
    const { channel } = data;

    if (channel in socket.channels) {
      console.log(`[${socket.id}] ERROR: already joined `, channel);
      return;
    }

    for (const channel in socket.channels) {
      partVoiceChannel(channel);
    }

    io.emit('voiceChannelJoined', {
      channelId: channel,
      user: socket.user,
      socketId: socket.id,
    });

    if (!(channel in channels)) {
      channels[channel] = {};
    }

    for (id in channels[channel]) {
      channels[channel][id].emit('addPeer', {
        peerId: socket.id,
        shouldCreateOffer: false,
      });
      socket.emit('addPeer', { peerId: id, shouldCreateOffer: true });
    }

    channels[channel][socket.id] = socket;
    socket.channels[channel] = channel;
  });

  function partVoiceChannel(channel) {
    if (channel === null) {
      for (const channel in socket.channels) {
        partVoiceChannel(channel);
      }
      return;
    }

    console.log(`[${socket.id}] partVoiceChannel `);

    if (!(channel in socket.channels)) {
      console.log(`[${socket.id}] ERROR: not in `, channel);
      return;
    }

    delete socket.channels[channel];
    delete channels[channel][socket.id];

    io.emit('voiceChannelParted', {
      channelId: channel,
      user: socket.user,
      socketId: socket.id,
    });

    for (id in channels[channel]) {
      channels[channel][id].emit('removePeer', { peerId: socket.id });
      socket.emit('removePeer', { peerId: id });
    }
  }

  socket.on('partVoiceChannel', partVoiceChannel);

  socket.on('relayICECandidate', function (config) {
    const { peerId, iceCandidate } = config;
    console.log(
      `[${socket.id}] relaying ICE candidate to [${peerId}] `,
      iceCandidate
    );

    if (peerId in sockets) {
      sockets[peerId].emit('iceCandidate', {
        peerId: socket.id,
        iceCandidate: iceCandidate,
      });
    }
  });

  socket.on('relaySessionDescription', function (config) {
    const { peerId, sessionDescription } = config;
    console.log(
      `[${socket.id}] relaying session description to [${peerId}] `,
      sessionDescription
    );

    if (peerId in sockets) {
      sockets[peerId].emit('sessionDescription', {
        peerId: socket.id,
        sessionDescription: sessionDescription,
      });
    }
  });

  socket.on('relayScreenShareICECandidate', function (config) {
    const { peerId, iceCandidate } = config;
    console.log(
      `[${socket.id}] relaying screen-share ICE candidate to [${peerId}] `,
      iceCandidate
    );

    if (peerId in sockets) {
      sockets[peerId].emit('screenShareIceCandidate', {
        peerId: socket.id,
        iceCandidate: iceCandidate,
      });
    }
  });

  socket.on('relayScreenShareSessionDescription', function (config) {
    const { peerId, sessionDescription } = config;
    console.log(
      `[${socket.id}] relaying screen-share session description to [${peerId}] `,
      sessionDescription
    );

    if (peerId in sockets) {
      sockets[peerId].emit('screenShareSessionDescription', {
        peerId: socket.id,
        sessionDescription: sessionDescription,
      });
    }
  });
};
