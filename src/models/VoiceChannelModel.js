const mongoose = require('mongoose');

const voiceChannelSchema = new mongoose.Schema(
  {
    channelName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 255,
    },
    createdBy: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Users',
      required: false,
    },
    insertedDate: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VoiceChannels', voiceChannelSchema);
