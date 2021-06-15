const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const baseDir = "attachments/";
const dir = path.resolve(baseDir);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

var upload = multer({ dest: dir });

const router = express.Router();

router.post("/", upload.single("attachments"), async (req, res, next) => {
  console.log(req.file);
  const newFilePath = `${req.file.path}${path.extname(req.file.originalname)}`;
  fs.renameSync(req.file.path, newFilePath);
  res.status(200).json({
    filepath: `${baseDir}${path.basename(newFilePath)}`,
    filename: `${path.basename(newFilePath)}`,
  });
});

router.get("/:id", async (req, res) => {
  console.log(`attachments[get]: ${dir}/${req.params.id}`);
  return res.sendFile(`${dir}/${req.params.id}`);
});

module.exports = router;
