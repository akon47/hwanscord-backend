const jwt = require('jsonwebtoken')
const user = require('../models/user.js')

const SECRET_KEY = 'hwanscord_secret_key';

const utils = {
    generateNewToken(user) {
        const payload = {
            username: user.username,
            _id: user._id,
        };
        return jwt.sign(payload, 'hwanscord_secret_key', {
            expiresIn: '1d',
        });
    },
};

module.exports = utils;
