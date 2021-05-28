const bcrypt = require('bcrypt')
const express = require('express')
const user = require('../models/user.js')

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

module.exports = router;