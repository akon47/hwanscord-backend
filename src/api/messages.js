const express = require('express');
const messagemodel = require('../models/MessageModel.js');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const doc = await messagemodel.create({
      ...req.body,
      createdBy: req.user._id,
    });

    const messageData = await messagemodel
      .findOne({ _id: doc._id })
      .populate('createdBy', 'username')
      .populate('postedBy')
      .lean()
      .exec();
    process.emit('newMessageReceived', messageData);

    res.status(201).json({ data: messageData });
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
    const removed = await messagemodel
      .findOneAndDelete({
        createdBy: req.user._id,
        _id: req.params.id,
      })
      .lean()
      .exec();

    if (!removed) {
      return res.status(400).json({ message: 'cannot remove the data' });
    }

    process.emit('messageDeleted', { messageid: req.params.id });

    return res.status(200).json({ ...removed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'sth wrong', error });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updatedDoc = await messagemodel
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

    const messageData = await messagemodel
      .findOne({ _id: req.params.id })
      .populate('createdBy', 'username')
      .populate('postedBy')
      .lean()
      .exec();

    process.emit('messageModified', messageData);

    res.status(201).json({ data: messageData });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'sth wrong', error });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const docs = await messagemodel
      .find({ postedBy: req.params.id })
      .sort({ insertedDate: 1 })
      .populate('createdBy', 'username')
      .populate('postedBy')
      .lean()
      .exec();

    res.status(200).json({
      messages: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: 'sth wrong', error });
  }
});

module.exports = router;
