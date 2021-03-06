const bcrypt = require('bcrypt');
const express = require('express');
const usermodel = require('../models/UserModel.js');
const { generateNewToken } = require('../utils/utils.js');

const router = express.Router();

router.post('/signup', (req, res) => {
  const { username, password } = req.body;

  bcrypt.hash(password, 10, (error, hashedPassword) => {
    if (error) {
      console.log(error);
      return res.status(500).json({
        error,
      });
    } else {
      const newUser = new usermodel({
        username,
        password: hashedPassword,
      });
      newUser.save((error, saved) => {
        if (error) {
          console.log(error);
          res.status(409).send(error);
        } else {
          let userData = { ...saved._doc, avatar: null };
          delete userData.password;
          process.emit('newUserSignup', userData);

          const token = generateNewToken(saved);
          res.send({ token, ...saved._doc, avatar: null });
        }
      });
    }
  });
});

router.post('/signin', (req, res) => {
  const { username, password } = req.body;
  usermodel
    .findOne({
      username,
    })
    .then((user) => {
      if (!user) {
        res.status(401).send('Authentication failed. User not found.');
      }
      bcrypt.compare(password, user.password, (error, result) => {
        if (error) {
          res.status(500).send('Internal Server Error');
        }
        if (result) {
          const token = generateNewToken(user);
          res.status(200).json({
            success: true,
            user: { username: user.username },
            message: 'Login Success',
            token: token,
          });
        } else {
          res.status(401).json('Authentication failed. Wrong password.');
        }
      });
    })
    .catch((error) => {
      res.status(500).json('Internal Server Error');
      throw error;
    });
});

module.exports = router;
