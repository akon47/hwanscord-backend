const jwt = require('jsonwebtoken');
const usermodel = require('../models/UserModel.js');

const SECRET_KEY = 'hwanscord_secret_key';

const verifyToken = async (token) => {
  return jwt.verify(token, SECRET_KEY);
};

const utils = {
  generateNewToken: (user) => {
    const payload = {
      username: user.username,
      _id: user._id,
    };
    return jwt.sign(payload, SECRET_KEY, {
      expiresIn: '1d',
    });
  },
  verifyToken: (token) => verifyToken(token),
  getUserIdByToken: async (token) => {
    let payload;
    try {
      payload = await verifyToken(token);
    } catch (e) {
      return null;
    }
    return payload._id;
  },
  getUserDataByToken: async (token) => {
    let payload;
    try {
      payload = await verifyToken(token);
    } catch (e) {
      return null;
    }
    
    const user = await usermodel
      .findById(payload._id)
      .populate('createdBy', 'username')
      .select('-password')
      .lean()
      .exec();

    return user;
  },
  authenticateUser: async (req, res, next) => {
    if (!req.headers.authorization) {
      return res.status(401).json({ message: 'token must be included' });
    }

    const token = req.headers.authorization;
    let payload;
    try {
      payload = await verifyToken(token);
    } catch (e) {
      return res.status(401).json({ message: 'token is invalid', error: e });
    }

    const user = await usermodel
      .findById(payload._id)
      .select('-password')
      .lean()
      .exec();

    if (!user) {
      return res.status(401).json({ message: 'user is not found' });
    }

    req.user = user;
    next();
  },
};

module.exports = utils;
