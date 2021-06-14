const express = require("express");
const usermodel = require("../models/UserModel.js");
const { getConnections } = require("../redis-client.js");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const docs = await usermodel
      .find()
      .select("-password")
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    for (let i = 0; i < docs.length; i++) {
      const connections = await getConnections(docs[i]._id.toString());
      docs[i].connections = parseInt(connections);
    }

    res.status(200).json({
      users: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: "sth wrong", error });
  }
});

module.exports = router;
