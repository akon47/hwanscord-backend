const express = require('express');
const voicechannelmodel = require('../models/VoiceChannelModel.js');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const doc = await voicechannelmodel.create({
      ...req.body,
      createdBy: req.user._id,
    });

    const channelData = await voicechannelmodel
      .findOne({ _id: doc._id })
      .populate('createdBy', 'username')
      .lean()
      .exec();
    process.emit('newVoiceChannelAdded', channelData);

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
    const removed = await voicechannelmodel
      .findOneAndDelete({
        createdBy: req.user._id,
        _id: req.params.id,
      })
      .lean()
      .exec();

    if (!removed) {
      return res.status(400).json({ message: 'cannot remove the data' });
    }

    process.emit('voiceChannelDeleted', { ...removed });

    return res.status(200).json({ ...removed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'sth wrong', error });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updatedDoc = await voicechannelmodel
      .findOneAndUpdate(
        {
          createdBy: req.user._id,
          _id: req.params.id,
        },
        req.body,
        { new: true }
      )
      .lean()
      .exec();

    if (!updatedDoc) {
      return res.status(400).json({ message: 'cannot update the data' });
    }

    const channelData = await voicechannelmodel
      .findOne({ _id: req.params.id })
      .populate('createdBy', 'username')
      .lean()
      .exec();

    process.emit('voiceChannelModified', channelData);

    res.status(201).json({ data: channelData });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'sth wrong', error });
  }
});

router.get('/', async (req, res) => {
  try {
    const docs = await voicechannelmodel
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
