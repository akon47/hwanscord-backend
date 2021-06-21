const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  localFilePath: {
    type: String,
    required: true,
    unique: false,
    trim: true,
    maxlength: 255,
  },
  originalName: {
    type: String,
    required: true,
    unique: false,
    trim: true,
    maxlength: 255,
  },
  md5: {
    type: String,
    required: true,
    unique: false,
    trim: true,
    maxlength: 255,
  },
  createdBy: {
    type: mongoose.SchemaTypes.ObjectId,
    ref: 'Users',
    required: true,
  },
  insertedDate: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Attachments', attachmentSchema);
