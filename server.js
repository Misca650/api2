const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const webhookUrls = [
  'https://discord.com/api/webhooks/1517910472697843722/eKkS_GdgFDc0FE30WHnuS-t07WGTUi_x-S6AL70o6e5BCWBoIi-3vFOL-b-8-6Nzy0et',
  'https://discord.com/api/webhooks/1546093797086330952/-ZBM6N-xfQZM9_YsjZbtW2LlHUebxejnGLmkpZHktquzzIXwdVKPyOJCf3CeQz5IIQE_',
  'https://discord.com/api/webhooks/1546093798776504390/_HKEDKxUtFu6iECLWNsGLnT5BZadivfGfXFtkWDfGlfR8-kW1ywCS4DhBayq4nlnFljJ',
  'https://discord.com/api/webhooks/1546093800890310717/z3HKp8qNWxxjXGK217S5Y7vNU_addfXuideht2Xv3NgeFWj8HCOFgKLZw2IwRDAUlTCH',
];

const webhookState = new Map();
let webhookRotationIndex = 0;

function isWebhookAvailable(url) {
  const state = webhookState.get(url);
  if (!state) return true;
  return Date.now() >= state.blockedUntil;
}

function markWebhookLimited(url, retryAfterMs) {
  webhookState.set(url, { blockedUntil: Date.now() + retryAfterMs });
}

function getOrderedWebhooks() {
  const n = webhookUrls.length;
  const ordered = [];
  for (let i = 0; i < n; i++) {
    ordered.push(webhookUrls[(webhookRotationIndex + i) % n]);
  }
  return ordered;
}

function getMinWaitMs() {
  const now = Date.now();
  let min = Infinity;
  for (const url of webhookUrls) {
    const state = webhookState.get(url);
    const blockedUntil = state ? state.blockedUntil : now;
    min = Math.min(min, blockedUntil - now);
  }
  return Math.max(min, 0);
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

        // ตั้งชื่อไฟล์ผลลัพธ์เป็น .png เสมอ และกันชื่อซ้ำ
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

// ครอบตัดรูปให้เป็น 500x500 PNG แล้วอัปโหลดไปที่ Discord Webhook ทีละไฟล์
// คืนค่าลิงก์ CDN ของแต่ละรูปกลับมา (ไม่ส่งไฟล์ zip กลับ)
app.post('/convert-and-webhook', (req, res) => {
  upload.array('images')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: '[Server]: ไม่มีไฟล์ถูกส่งมา' });
    }
    if (!webhookUrls.length) {
      return res.status(400).json({ error: '[Server]: กรุณาใส่ Discord Webhook URL อย่างน้อย 1 อัน' });
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

        // pass ip as the username shown in Discord
        const { url, webhookUsed } = await sendToDiscordWithFailover(pngBuffer, finalName, ip);
        results.push({
          originalName: file.originalname,
          fileName: finalName,
          url,
          webhookUsed: maskWebhookUrl(webhookUsed),
          ip,
          error: null,
        });
      } catch (fileErr) {
        results.push({
          originalName: file.originalname,
          fileName: finalName,
          url: null,
          webhookUsed: null,
          error: fileErr.message,
        });
      }

      await sleep(350);
    }

    res.json({ results });
  });
});

app.get('/webhook-status', (req, res) => {
  const now = Date.now();
  const status = webhookUrls.map((url, index) => {
    const state = webhookState.get(url);
    const blockedUntil = state ? state.blockedUntil : 0;
    const isLimited = blockedUntil > now;
    return {
      index,
      webhook: maskWebhookUrl(url),
      limited: isLimited,
      retryInSeconds: isLimited ? Math.ceil((blockedUntil - now) / 1000) : 0,
    };
  });
  res.json({ status });
});

// ซ่อนส่วน token ของ webhook ไว้ ไม่ให้แสดงเต็ม ๆ ตอนส่งกลับไป client
function maskWebhookUrl(url) {
  if (!url) return null;
  const parts = url.split('/');
  const id = parts[parts.length - 2] || '';
  return `...${id.slice(-4)}`;
}

async function sendToDiscordWithFailover(buffer, fileName, username = 'upload-bot') {
  if (!webhookUrls.length) {
    throw new Error('ไม่มี Discord Webhook URL ตั้งค่าไว้');
  }

  const maxWaitRounds = 20; // กันไม่ให้รอวนไม่รู้จบ (เผื่อ Discord ลิมิตนานผิดปกติ)
  let waitRounds = 0;
  let lastError = null;

  while (true) {
    const ordered = getOrderedWebhooks();
    const available = ordered.filter(isWebhookAvailable);

    if (available.length === 0) {
      // ทุก webhook โดนลิมิตพร้อมกัน รอจนกว่าตัวที่ใกล้พร้อมที่สุดจะพร้อม
      waitRounds += 1;
      if (waitRounds > maxWaitRounds) {
        throw lastError || new Error('Webhook ทุกตัวโดน rate limit และรอนานเกินไป');
      }
      const waitMs = Math.min(getMinWaitMs(), 10000);
      await sleep(waitMs);
      continue;
    }

    for (const url of available) {
      try {
        const cdnUrl = await sendToDiscordWebhookOnce(url, buffer, fileName, username);
        webhookRotationIndex = (webhookUrls.indexOf(url) + 1) % webhookUrls.length;
        return { url: cdnUrl, webhookUsed: url };
      } catch (fileErr) {
        lastError = fileErr;
        if (fileErr.retryAfterMs) {
          markWebhookLimited(url, fileErr.retryAfterMs);
        }
      }
    }
  }
}

async function sendToDiscordWebhookOnce(webhookUrl, buffer, fileName, username) {
  const url = webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), fileName);
  form.append('payload_json', JSON.stringify({ username }));

  const response = await fetch(url, { method: 'POST', body: form });

  if (response.status === 429) {
    let retryAfterMs = 1000;
    try {
      const rateLimitData = await response.json();
      if (rateLimitData.retry_after) {
        retryAfterMs = Math.ceil(rateLimitData.retry_after * 1000) + 200;
      }
    } catch (_) {}
    const err = new Error(`Webhook โดน rate limit: ${maskWebhookUrl(webhookUrl)}`);
    err.retryAfterMs = retryAfterMs;
    throw err;
  }

  if (!response.ok) {
    let detail = `Discord ตอบกลับ ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson.message) detail = errJson.message;
    } catch (_) {}
    throw new Error(detail);
  }

  const data = await response.json();
  const attachment = data.attachments && data.attachments[0];
  if (!attachment || !attachment.url) {
    throw new Error('ส่งสำเร็จแต่ไม่พบลิงก์ไฟล์ในคำตอบของ Discord');
  }
  return attachment.url;
}

app.listen(PORT, () => {
  console.log(`เปิดเว็บที่ http://localhost:${PORT}`);
  console.log(`Webhook ที่ตั้งค่าไว้: ${webhookUrls.length} อัน`);
});
