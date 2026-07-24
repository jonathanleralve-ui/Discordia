const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const auth = require('../middleware/auth');
const { MODEL_UPLOAD_DIR, MAX_MODEL_ZIP_MB } = require('../config');

fs.mkdirSync(MODEL_UPLOAD_DIR, { recursive: true });

// The zip is small enough (<=MAX_MODEL_ZIP_MB) to buffer in memory — we need
// the whole thing anyway to read it as a zip archive.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MODEL_ZIP_MB * 1024 * 1024 }
});

const router = express.Router();
router.use(auth);

// Files we actually need to keep from the package: the model itself plus
// whatever textures/toon shading maps it references. Everything else in the
// zip (READMEs, .psd source files, etc.) is skipped to keep things small.
const ALLOWED_EXTENSIONS = new Set(['.pmx', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.spa', '.sph', '.dds']);

// adm-zip always decodes zip entry names as UTF-8, regardless of whether the
// zip's UTF-8 (EFS) flag is actually set. MMD model packages are frequently
// built on Japanese Windows systems with filenames in Shift-JIS (Cp932) and
// no EFS flag, so that forced UTF-8 decode mangles them into replacement
// characters (U+FFFD). The .pmx binary itself still references the correct
// original (Shift-JIS-safe) texture filenames internally, so if we don't
// recover the real on-disk filenames here, every texture lookup 404s and the
// model renders flat grey. We re-decode the raw entry bytes as Shift-JIS
// whenever the UTF-8 decode looks broken.
function resolveEntryName(entry) {
  const forced = entry.entryName;
  if (!forced.includes('\uFFFD')) return forced; // decoded fine, trust it
  try {
    const reDecoded = iconv.decode(entry.rawEntryName, 'shift_jis');
    if (reDecoded && !reDecoded.includes('\uFFFD')) return reDecoded;
  } catch (e) {
    // fall through to best-effort forced name below
  }
  return forced;
}

router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Model package is too large (max ${MAX_MODEL_ZIP_MB}MB)` });
    }
    if (err) {
      console.error('avatar-model upload error', err);
      return res.status(400).json({ error: 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: 'That does not look like a valid .zip file' });
    }

    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const pmxEntries = entries.filter((e) => e.entryName.toLowerCase().endsWith('.pmx'));
    if (pmxEntries.length === 0) {
      return res.status(400).json({ error: 'Zip must contain a .pmx model file' });
    }
    // MMD packages frequently bundle several .pmx files in one archive -
    // the main body plus swappable weapons/accessories (sword, guns,
    // bullets, etc). Picking "the first one found" is arbitrary and depends
    // entirely on zip entry order, which is why the same package can load
    // as the character one time and as a prop the next. The main body model
    // is reliably the largest .pmx by a wide margin (accessory/weapon .pmx
    // files are typically a few KB to ~100KB; a full character body is
    // usually 1MB+), so use size as the selection heuristic instead.
    const pmxEntry = pmxEntries.reduce((largest, e) =>
      e.header.size > largest.header.size ? e : largest
    );

    // Everything is flattened into one folder per upload — MMD models
    // reference their textures by filename relative to the .pmx, and PMX
    // packages are almost always already flat, so this keeps resolution
    // simple and also sidesteps zip-slip (no nested ../ path components
    // ever reach the filesystem since we only ever use basenames).
    const folderName = `${req.user.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const destDir = path.join(MODEL_UPLOAD_DIR, folderName);
    fs.mkdirSync(destDir, { recursive: true });

    const usedNames = new Set();
    let pmxFilename = null;

    for (const entry of entries) {
      const resolvedName = resolveEntryName(entry);
      const ext = path.extname(resolvedName).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      let baseName = path.basename(resolvedName);
      // Guard against two different folders in the zip containing
      // same-named files (e.g. tex/skin.png and tex2/skin.png) clobbering
      // each other once flattened.
      if (usedNames.has(baseName)) {
        baseName = `${crypto.randomBytes(4).toString('hex')}-${baseName}`;
      }
      usedNames.add(baseName);

      fs.writeFileSync(path.join(destDir, baseName), entry.getData());
      if (entry === pmxEntry) pmxFilename = baseName;
    }

    if (!pmxFilename) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Could not extract the .pmx model file' });
    }

    res.json({
      modelUrl: `/uploads/models/${folderName}/${pmxFilename}`,
      fileCount: usedNames.size
    });
  });
});

module.exports = router;