const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
      unique: false,
      trim: true,
      maxlength: 1000,
    },
    createdBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Users',
      required: true,
    },
    postedBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Channels',
      required: false,
    },
    insertedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Messages', messageSchema);
