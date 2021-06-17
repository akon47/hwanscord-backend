const avatarmodel = require('./models/AvatarModel.js');
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

        const docs = await avatarmodel
          .find()
          .lean()
          .exec();
        for (let i = 0; i < docs.length; i++) {
          if (!fs.existsSync(docs[i].localFilePath)) {
            await avatarmodel.deleteOne({ _id: docs[i]._id }).lean().exec();
          }
        }
      }
    });
    mongoose.Promise = global.Promise;
  };
  connect();
  require('./models/UserModel.js');
};
