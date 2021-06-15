const mongoose = require("mongoose");

const avatarSchema = new mongoose.Schema(
  {
    localFilePath: {
      type: String,
      required: true,
      unique: false,
      trim: true,
      maxlength: 255,
    },
    createdBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: "Users",
      required: true,
    },
    insertedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Avatars", avatarSchema);
