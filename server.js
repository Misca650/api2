const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------------
// GitHub config (ใช้ GitHub Contents API แทน Discord Webhook)
// ------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_PATH_PREFIX = (process.env.GITHUB_PATH_PREFIX || 'uploads').replace(/^\/+|\/+$/g, '');
const GITHUB_API_BASE = 'https://api.github.com';

function assertGithubConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error(
      '[Server]: ยังไม่ได้ตั้งค่า GITHUB_TOKEN (environment variables)'
    );
  }
  if (!GITHUB_OWNER) {
    throw new Error(
      '[Server]: ยังไม่ได้ตั้งค่า GITHUB_OWNER (environment variables)'
    );
  }
  if (!GITHUB_REPO) {
    throw new Error(
      '[Server]: ยังไม่ได้ตั้งค่า GITHUB_REPO (environment variables)'
    );
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: Infinity,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error(`ไฟล์ "${file.originalname}" ไม่ใช่รูปภาพ`));
    }
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// /convert : ครอบตัด 500x500 แล้วส่งกลับเป็น zip (เหมือนเดิม ไม่เกี่ยวกับ GitHub)
// ------------------------------------------------------------------
app.post('/convert', (req, res) => {
  upload.array('images')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'ไม่มีไฟล์ถูกส่งมา' });
    }

    try {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="cropped-500x500-png.zip"');

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (archiveErr) => {
        if (!res.headersSent) {
          res.status(500).json({ error: archiveErr.message });
        } else {
          res.end();
        }
      });
      archive.pipe(res);

      const usedNames = new Set();

      for (const file of files) {
        const pngBuffer = await sharp(file.buffer)
          .rotate()
          .resize(500, 500, {
            fit: 'cover',
            position: 'centre',
          })
          .png()
          .toBuffer();

        const baseName = path
          .basename(file.originalname, path.extname(file.originalname))
          .replace(/[^a-zA-Z0-9ก-๙_\- ]/g, '_') || 'image';

        let finalName = `${baseName}.png`;
        let counter = 1;
        while (usedNames.has(finalName)) {
          finalName = `${baseName}-${counter}.png`;
          counter += 1;
        }
        usedNames.add(finalName);

        archive.append(pngBuffer, { name: finalName });
      }

      await archive.finalize();
    } catch (processErr) {
      if (!res.headersSent) {
        res.status(500).json({ error: processErr.message });
      } else {
        res.end();
      }
    }
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------
// /convert-and-upload : ครอบตัดรูปเป็น 500x500 PNG แล้วอัปโหลดขึ้น GitHub repo
// ทีละไฟล์ คืนค่าลิงก์ raw/blob ของแต่ละไฟล์กลับมา
// ------------------------------------------------------------------
app.post('/convert-and-upload', (req, res) => {
  upload.array('images')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: '[Server]: ไม่มีไฟล์ถูกส่งมา' });
    }

    try {
      assertGithubConfigured();
    } catch (cfgErr) {
      return res.status(400).json({ error: cfgErr.message });
    }

    const usedNames = new Set();
    const results = [];

    for (const file of files) {
      const baseName = path
        .basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9ก-๙_\- ]/g, '_') || 'image';

      let finalName = `${baseName}.png`;
      let counter = 1;
      while (usedNames.has(finalName)) {
        finalName = `${baseName}-${counter}.png`;
        counter += 1;
      }
      usedNames.add(finalName);

      try {
        const pngBuffer = await sharp(file.buffer)
          .rotate()
          .resize(500, 500, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer();

        const repoPath = `${GITHUB_PATH_PREFIX}/${Date.now()}-${finalName}`;
        const { downloadUrl, htmlUrl } = await uploadToGithubWithRetry(pngBuffer, repoPath);

        results.push({
          originalName: file.originalname,
          fileName: finalName,
          path: repoPath,
          url: downloadUrl,
          htmlUrl,
          error: null,
        });
      } catch (fileErr) {
        results.push({
          originalName: file.originalname,
          fileName: finalName,
          url: null,
          htmlUrl: null,
          error: fileErr.message,
        });
      }

      // เว้นจังหวะเล็กน้อยกันชนกับ GitHub API rate limit
      await sleep(350);
    }

    res.json({ results });
  });
});

// ------------------------------------------------------------------
// สถานะ config GitHub (ไม่โชว์ token เต็ม ๆ)
// ------------------------------------------------------------------
app.get('/github-status', (req, res) => {
  res.json({
    configured: Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO),
    owner: GITHUB_OWNER || null,
    repo: GITHUB_REPO || null,
    branch: GITHUB_BRANCH,
    pathPrefix: GITHUB_PATH_PREFIX,
    tokenSet: Boolean(GITHUB_TOKEN),
  });
});

// ------------------------------------------------------------------
// อัปโหลดไฟล์ขึ้น GitHub ผ่าน Contents API พร้อม retry เมื่อโดน rate limit
// ------------------------------------------------------------------
async function uploadToGithubWithRetry(buffer, repoPath) {
  const maxRetries = 5;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await uploadToGithubOnce(buffer, repoPath);
    } catch (err) {
      lastError = err;
      if (err.retryAfterMs) {
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('อัปโหลดขึ้น GitHub ไม่สำเร็จ');
}

async function uploadToGithubOnce(buffer, repoPath) {
  const apiUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(
    repoPath
  )}`;

  const response = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      message: `upload: ${repoPath}`,
      content: buffer.toString('base64'),
      branch: GITHUB_BRANCH,
    }),
  });

  if (response.status === 403 || response.status === 429) {
    let retryAfterMs = 2000;
    const retryAfterHeader = response.headers.get('retry-after');
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (retryAfterHeader) {
      retryAfterMs = Math.ceil(parseFloat(retryAfterHeader) * 1000) + 200;
    } else if (remaining === '0') {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) {
        const resetMs = parseInt(resetHeader, 10) * 1000 - Date.now();
        retryAfterMs = Math.max(resetMs, 1000) + 200;
      }
    }
    const err = new Error('GitHub API โดน rate limit');
    err.retryAfterMs = retryAfterMs;
    throw err;
  }

  if (!response.ok) {
    let detail = `GitHub API ตอบกลับ ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson.message) detail = errJson.message;
    } catch (_) {}
    throw new Error(detail);
  }

  const data = await response.json();
  const downloadUrl = data.content && data.content.download_url;
  const htmlUrl = data.content && data.content.html_url;
  if (!downloadUrl) {
    throw new Error('อัปโหลดสำเร็จแต่ไม่พบลิงก์ไฟล์ในคำตอบของ GitHub');
  }
  return { downloadUrl, htmlUrl };
}

app.listen(PORT, () => {
  console.log(`เปิดเว็บที่ http://localhost:${PORT}`);
  console.log(
    `GitHub: ${GITHUB_OWNER || '(ยังไม่ตั้งค่า)'}/${GITHUB_REPO || '(ยังไม่ตั้งค่า)'} @ ${GITHUB_BRANCH} -> /${GITHUB_PATH_PREFIX}`
  );
});
