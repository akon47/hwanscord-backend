const express = require('express');
const usermodel = require('../models/UserModel.js');
const avatarmodel = require('../models/AvatarModel.js');
const { getConnections } = require('../redis-client.js');
const path = require('path');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const docs = await usermodel
      .find()
      .select('-password')
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    for (let i = 0; i < docs.length; i++) {
      const connections = await getConnections(docs[i]._id.toString());
      docs[i].connections = parseInt(connections);
      let avatar = null;

      const doc = await avatarmodel.findOne({ createdBy: docs[i]._id }).exec();
      if (doc !== null) {
        avatar = {
          filepath: `avatar/${path.basename(doc.localFilePath)}`,
          filename: path.basename(doc.localFilePath),
        };
      }
      docs[i].avatar = avatar;
    }

    res.status(200).json({
      users: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: 'sth wrong', error });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (req.user._id === req.params.id) {
      await usermodel
        .remove({ _id: req.params.id })
        .lean()
        .exec();
      res.status(200).end();
    } else {
      res.status(400).json({ message: 'cannot remove the user' });
    }
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: 'sth wrong', error });
  }
});

module.exports = router;
