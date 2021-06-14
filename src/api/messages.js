const express = require("express");
const messages = require("../models/MessageModel.js");

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const doc = await messages.create({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ data: doc });

    const messageData = await messages
      .findOne({ _id: doc._id })
      .sort({ insertedDate: 1 })
      .populate("createdBy", "username")
      .lean()
      .exec();
    process.emit("newMessageReceived", messageData);
  } catch (error) {
    console.log(error);
    if (error.code === 11000) {
      return res.status(400).send({ message: "Duplicated Data", error });
    }
    res.status(400).send({ message: "sth wrong", error });
  }
});

router.get("/", async (req, res) => {
  try {
    const docs = await messages
      .find()
      .sort({ insertedDate: 1 })
      .populate("createdBy", "username")
      .lean()
      .exec();

    res.status(200).json({
      messages: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "sth wrong", error });
  }
});

module.exports = router;
