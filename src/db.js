const avatarmodel = require('./models/AvatarModel.js');
const channelmodel = require('./models/ChannelModel.js');
const fs = require('fs');

const mongoose = require('mongoose');
module.exports = () => {
  const connect = () => {
    mongoose.connect('mongodb://hwans:hwans@mongo/hwanscord', async (err) => {
      if (err) {
        console.error('mongodb connection error', err);
        process.exit(1); // restart server by docker-compose
      } else {
        console.log('mongodb connected');

        let docs = await avatarmodel.find().lean().exec();
        for (let i = 0; i < docs.length; i++) {
          if (!fs.existsSync(docs[i].localFilePath)) {
            await avatarmodel.deleteOne({ _id: docs[i]._id }).lean().exec();
          }
        }

        // docs = await channelmodel.find().lean().exec();
        // if (docs === null || docs.length <= 0) {
        //   await channelmodel.create({
        //     channelName: "Default",
        //   });
        //   await channelmodel.create({
        //     channelName: "Default-2",
        //   });
        // }
      }
    });
    mongoose.Promise = global.Promise;
  };
  connect();
  require('./models/UserModel.js');
  require('./models/ChannelModel.js');
  require('./models/MessageModel.js');
  require('./models/AvatarModel.js');
  require('./models/AttachmentModel.js');
};
