const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const auth = require('../middleware/auth');
const { UPLOAD_DIR, MAX_UPLOAD_MB } = require('../config');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Random name on disk (never trust the original filename as a path),
    // but keep the extension so browsers/OSes still recognize the file type.
    const ext = path.extname(file.originalname).slice(0, 16);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

const router = express.Router();
router.use(auth);

router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB}MB)` });
    }
    if (err) {
      console.error('upload error', err);
      return res.status(400).json({ error: 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });
  });
});

module.exports = router;
