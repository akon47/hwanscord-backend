const express = require('express');
const channelmodel = require('../models/ChannelModel.js');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const doc = await channelmodel.create({
      ...req.body,
      createdBy: req.user._id,
    });

    const channelData = await channelmodel
      .findOne({ _id: doc._id })
      .populate('createdBy', 'username')
      .lean()
      .exec();
    process.emit('newChannelAdded', channelData);

    res.status(201).json({ data: channelData });
  } catch (error) {
    console.log(error);
    if (error.code === 11000) {
      return res.status(400).send({ message: 'Duplicated Data', error });
    }
    res.status(400).send({ message: 'sth wrong', error });
  }
});

router.delete('/:id', async (req, res) => {
    try {
      const removed = await channelmodel
        .findOneAndDelete({
          createdBy: req.user._id,
          _id: req.params.id,
        })
        .lean()
        .exec();
  
      if (!removed) {
        return res.status(400).json({ message: 'cannot remove the data' });
      }
  
      process.emit('channelDeleted', { ...removed });
  
      return res.status(200).json({ ...removed });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'sth wrong', error });
    }
  });

router.get('/', async (req, res) => {
  try {
    const docs = await channelmodel
      .find()
      .sort({ insertedDate: 1 })
      .populate('createdBy', 'username')
      .lean()
      .exec();

    res.status(200).json({
      channels: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: 'sth wrong', error });
  }
});

module.exports = router;
