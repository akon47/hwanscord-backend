const mongoose = require('mongoose')

const messageSchema = new mongoose.Schema(
    {
        message: {
            type: String,
            required: true,
            unique: false,
            trim: true,
            maxlength: 200,
        },
        createdBy: {
            type: mongoose.SchemaTypes.ObjectId,
            ref: 'User',
            required: true,
        },
        insertedDate: { type: Date, default: Date.now },
    },
    { timestamps: true },
)

module.exports = mongoose.model('Messages', messageSchema);