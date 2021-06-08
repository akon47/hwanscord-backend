const bcrypt = require('bcrypt')
const express = require('express')
const user = require('../models/user.js')
const { generateNewToken } = require('../utils/utils.js')

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
        const newUser = new user({
          username,
          password: hashedPassword,
        });
        newUser.save((error, saved) => {
          if (error) {
            console.log(error);
            res.status(409).send(error);
          } else {
            console.log(saved);
            res.send(saved);
          }
        });
      }
    });
});

router.post('/signin', (req, res) => {
  const { username, password } = req.body;
  user.findOne({
    username,
  }).then(user => {
    if (!user) {
      res.status(401).send('Authentication failed. User not found.');
    }
    bcrypt.compare(password, user.password, (error, result) => {
      if(error) {
        res.status(500).send('Internal Server Error');
      }
      if(result) {
        const token = generateNewToken(user);
        res.status(200).json({
          success: true,
          user: { username: user.username, },
          message: 'Login Success',
          token: token,
        });

      } else {
        res.status(401).json('Authentication failed. Wrong password.');
      }
    });
  }).catch(error => {
    res.status(500).json('Internal Server Error');
    throw error;
  });
});

module.exports = router;