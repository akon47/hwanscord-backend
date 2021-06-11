const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 50,
  },
  password: {
    type: String,
    required: true,
  },
  insertedDate: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Users", userSchema);
