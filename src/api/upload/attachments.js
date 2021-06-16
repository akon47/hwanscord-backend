const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { authenticateUser } = require('../../utils/utils.js');
const md5file = require('md5-file');
const attachmentmodel = require('../../models/AttachmentModel.js');

const baseDir = 'attachments/';
const dir = path.resolve(baseDir);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

var upload = multer({ dest: dir });

const router = express.Router();

router.post(
  '/',
  authenticateUser,
  upload.single('attachment'),
  async (req, res) => {
    const newFilePath = `${req.file.path}${path.extname(
      req.file.originalname
    )}`;
    fs.renameSync(req.file.path, newFilePath);
    const hash = md5file.sync(newFilePath);
    await attachmentmodel.create({
      localFilePath: newFilePath,
      originalName: req.file.originalname,
      md5: hash,
      createdBy: req.user._id,
    });

    res.status(200).json({
      filepath: `${baseDir}${path.basename(newFilePath)}`,
      filename: `${path.basename(newFilePath)}`,
      originalname: req.file.originalname,
    });
  }
);

router.get('/:id', async (req, res) => {
  return res.sendFile(`${dir}/${req.params.id}`);
});

// router.delete('/:id', authenticateUser, async (req, res) => {
//   res.status(200);
// });

module.exports = router;
