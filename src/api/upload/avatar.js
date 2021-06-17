const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { authenticateUser } = require('../../utils/utils.js');
const avatarmodel = require('../../models/AvatarModel.js');

const baseDir = 'avatar/';
const dir = path.resolve(baseDir);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

var upload = multer({ dest: dir });

const router = express.Router();

router.post(
  '/',
  authenticateUser,
  upload.single('avatar'),
  async (req, res) => {
    const newFilePath = `${req.file.path}${path.extname(
      req.file.originalname
    )}`;
    fs.renameSync(req.file.path, newFilePath);

    const avatars = await avatarmodel
      .find({
        createdBy: req.user._id,
      })
      .lean()
      .exec();

    for (let i = 0; i < avatars.length; i++) {
      if (fs.existsSync(avatars[i].localFilePath)) {
        fs.unlinkSync(avatars[i].localFilePath);
      }
    }

    await avatarmodel.deleteMany({ createdBy: req.user._id }).lean().exec();
    await avatarmodel.create({
      localFilePath: newFilePath,
      createdBy: req.user._id,
    });

    process.emit('userAvatarChanged', {
      userid: req.user._id,
      avatar: {
        filepath: `${baseDir}${path.basename(newFilePath)}`,
        filename: path.basename(newFilePath),
      },
    });

    res.status(200).json({
      filepath: `${baseDir}${path.basename(newFilePath)}`,
      filename: `${path.basename(newFilePath)}`,
    });
  }
);

router.get('/:id', async (req, res) => {
  return res.sendFile(`${dir}/${req.params.id}`);
});

module.exports = router;
