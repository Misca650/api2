const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');
const { put } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URLS = "https://discord.com/api/webhooks/1517910472697843722/eKkS_GdgFDc0FE30WHnuS-t07WGTUi_x-S6AL70o6e5BCWBoIi-3vFOL-b-8-6Nzy0et";

// ---------------------------------------------------------------------------
// Discord logging — hardened version
// ---------------------------------------------------------------------------
// อ่าน webhook URLs จาก .env.local (คั่นด้วยจุลภาค) แทนการ hardcode ในซอร์ส
// ตัวอย่างใน .env.local:
//   DISCORD_WEBHOOK_URLS=https://discord.com/api/webhooks/AAA,https://discord.com/api/webhooks/BBB
//
// สิ่งที่เพิ่มเข้ามาเพื่อให้ "ลื่นขึ้น 100 เท่า":
//   1. คิวแยกต่อ webhook (ไม่ยิงพร้อมกันจนโดน rate limit ของ Discord)
//   2. เคารพ 429 + retry_after ของ Discord โดยอัตโนมัติ พร้อม exponential backoff
//   3. ตัด timeout กัน request ค้าง (AbortController)
//   4. Trim ให้อยู่ในลิมิตของ embed จริง (title 256 / desc 4096 / field name 256 /
//      field value 1024 / 25 fields / รวมทั้ง embed ไม่เกิน 6000 ตัวอักษร)
//      — รวมถึงกรณีไม่มี field เลยแต่ title+description+footer ก็ยังเกิน 6000 ได้
//   5. Retry เรื่อง network error ชั่วคราวไม่กี่ครั้งก่อนจะยอมแพ้แบบเงียบ ๆ
//   6. ไม่มีทางทำให้ request หลัก (convert/convert-and-link) ล่มหรือช้าลง
//      เพราะการยิง log เป็น fire-and-forget เสมอ
//   7. field name/value ที่เป็นสตริงว่าง จะไม่ถูกส่งดิบ ๆ ไปหา Discord API อีกต่อไป
//      (Discord ตอบ 400 ถ้า field name/value เป็น "" ซึ่งก่อนหน้านี้ error จะถูกกลืน
//      ไปเงียบ ๆ ใน catch ของ _sendWithRetry)

const DISCORD_LIMITS = {
  TITLE: 256,
  DESCRIPTION: 4096,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  FIELDS: 25,
  FOOTER: 2048,
  TOTAL_EMBED: 6000,
};

const webhookUrls = (DISCORD_WEBHOOK_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

if (webhookUrls.length === 0) {
  console.warn(
    '[คำเตือน] ไม่พบ DISCORD_WEBHOOK_URLS — จะไม่มีการส่ง log เข้า Discord. ' +
    'เพิ่มตัวแปรนี้ใน .env.local ถ้าต้องการเปิดใช้งาน (เช่น DISCORD_WEBHOOK_URLS=https://discord.com/api/webhooks/xxx)'
  );
}

function nowThai() {
  return new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// รองรับ null/undefined/'' ทั้งหมด — ถ้าว่างเปล่าหลัง trim ให้ fallback เป็น '—'
// กัน field name/value ว่างเปล่าหลุดไปถึง Discord API (Discord ตอบ 400 ถ้าเจอแบบนั้น)
function truncate(str, max) {
  const s = (String(str ?? '').trim()) || '—';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// ห่อ text ด้วย ``` ให้กลายเป็นกรอบสีดำ (code block) ใน Discord
// จำกัดความยาวเนื้อหาก่อนห่อ กันชนลิมิตของ field/description หลังบวก backtick แล้ว
const CODE_FENCE_OVERHEAD = 8; // "```\n" + "\n```"
function codeBlock(text, maxTotal) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw; // ว่างไว้ ไม่ต้องห่อให้รก
  const maxContent = Math.max(0, maxTotal - CODE_FENCE_OVERHEAD);
  const content = truncate(raw, maxContent);
  return `\`\`\`\n${content}\n\`\`\``;
}

// ตัด/จำกัด embed ให้ไม่ชนลิมิตจริงของ Discord ก่อนส่งเสมอ
// พร้อมห่อ description และค่าของทุก field ด้วยกรอบดำ (```) ตามที่ต้องการ
function sanitizeEmbed(rawEmbed) {
  const embed = { ...rawEmbed };

  if (embed.title) embed.title = truncate(embed.title, DISCORD_LIMITS.TITLE);
  if (embed.description) {
    embed.description = codeBlock(embed.description, DISCORD_LIMITS.DESCRIPTION);
  }
  if (embed.footer?.text) {
    embed.footer = { ...embed.footer, text: truncate(embed.footer.text, DISCORD_LIMITS.FOOTER) };
  }

  if (Array.isArray(embed.fields)) {
    embed.fields = embed.fields
      .slice(0, DISCORD_LIMITS.FIELDS)
      .map((f) => ({
        name: truncate(f.name, DISCORD_LIMITS.FIELD_NAME),
        value: codeBlock(f.value, DISCORD_LIMITS.FIELD_VALUE),
        inline: Boolean(f.inline),
      }));
  }

  const totalLen = () =>
    (embed.title || '').length +
    (embed.description || '').length +
    (embed.footer?.text || '').length +
    (embed.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);

  // เผื่อรวมทั้งหมดยังเกิน 6000 ตัวอักษร: ตัด field ท้าย ๆ ทิ้งก่อน
  while (totalLen() > DISCORD_LIMITS.TOTAL_EMBED && embed.fields?.length) {
    embed.fields.pop();
  }

  // ถ้าตัด field จนหมดแล้วยังเกิน (title+description+footer ล้วน ๆ เกิน 6000)
  // ให้ตัด description ต่อจนกว่าจะพอดี กัน Discord ปฏิเสธ payload ทั้งก้อน
  let overflow = totalLen() - DISCORD_LIMITS.TOTAL_EMBED;
  if (overflow > 0 && embed.description) {
    const newLen = Math.max(0, embed.description.length - overflow);
    embed.description = truncate(embed.description, newLen);
  }

  return embed;
}

// -------------------- คิวส่ง log ต่อ webhook --------------------
// กันยิงพร้อมกันหลาย request แล้วโดน Discord rate-limit (429) รัว ๆ
class WebhookQueue {
  constructor(url) {
    this.url = url;
    this.queue = [];
    this.running = false;
  }

  push(payload) {
    this.queue.push(payload);
    this._drain();
  }

  async _drain() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const payload = this.queue.shift();
      await this._sendWithRetry(payload);
    }

    this.running = false;
  }

  async _sendWithRetry(payload, attempt = 0) {
    const MAX_ATTEMPTS = 4;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 429) {
        let retryAfterMs = 1000;
        try {
          const body = await res.json();
          if (body?.retry_after) retryAfterMs = Math.ceil(body.retry_after * 1000);
        } catch {
          // ถ้า parse ไม่ได้ก็ใช้ default ด้านบน
        }
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryAfterMs + 100);
          return this._sendWithRetry(payload, attempt + 1);
        }
        console.error('[Discord log] โดน rate limit ซ้ำจนครบจำนวนครั้ง retry แล้ว ยอมแพ้');
        return;
      }

      if (!res.ok) {
        // แสดง response body ด้วย จะได้เห็นสาเหตุจริง (เช่น field name/value ว่าง,
        // embed เกินลิมิต, webhook ถูกลบ ฯลฯ) แทนที่จะเดาว่าทำไม log ไม่ขึ้น
        let bodyText = '';
        try {
          bodyText = await res.text();
        } catch {
          // เพิกเฉยได้ ไม่ใช่สาระสำคัญ
        }
        console.error(`[Discord log] webhook ตอบกลับ ${res.status}: ${bodyText}`);
        return;
      }
    } catch (e) {
      clearTimeout(timeout);
      // network error / timeout ชั่วคราว → retry แบบ exponential backoff สั้น ๆ
      if (attempt < MAX_ATTEMPTS) {
        await sleep(300 * 2 ** attempt);
        return this._sendWithRetry(payload, attempt + 1);
      }
      console.error('[Discord log] ส่งไม่สำเร็จหลัง retry ครบแล้ว:', e.message);
    }
  }
}

const webhookQueues = webhookUrls.map((url) => new WebhookQueue(url));
let webhookIndex = 0;

// วน round-robin ไปเรื่อย ๆ ทีละ webhook กันโหลดกระจุกตัวที่ตัวเดียว
function nextQueue() {
  if (webhookQueues.length === 0) return null;
  const q = webhookQueues[webhookIndex % webhookQueues.length];
  webhookIndex += 1;
  return q;
}

// ส่ง embed message ไป Discord webhook หนึ่งตัว — fire-and-forget เสมอ
// ไม่มีทาง throw กลับไปหา caller หรือทำให้ request หลักช้าลง/พัง
function logToDiscord({
  title,
  description = '',
  color = 0x5865f2,
  fields = [],
  thumbnail = null,
  image = null,
  username = 'Image Converter',
}) {
  const queue = nextQueue();
  if (!queue) return;

  const embed = sanitizeEmbed({
    title,
    description,
    color,
    fields,
    thumbnail: thumbnail ? { url: thumbnail } : undefined,
    image: image ? { url: image } : undefined,
    timestamp: new Date().toISOString(),
    footer: { text: `Image Converter • ${nowThai()}` },
  });

  queue.push({ username, embeds: [embed] });
}

// รวมหลาย embed เป็น 1 ข้อความ (เช่น รูปหลายไฟล์ในรอบเดียว) โดยแบ่งเป็นหลายข้อความ
// อัตโนมัติถ้าเกินลิมิตของ Discord: สูงสุด 10 embeds/ข้อความ และตัวอักษรรวมทั้งข้อความ
// ไม่เกิน 6000 ตัว ใช้ webhook เดียวกันตลอดทั้งชุด กันรายงานเดียวกันกระจายไปคนละช่อง
function embedCharCount(e) {
  return (
    (e.title || '').length +
    (e.description || '').length +
    (e.footer?.text || '').length +
    (e.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0)
  );
}

function chunkEmbeds(embeds, maxPerMessage = 10, maxCharsPerMessage = DISCORD_LIMITS.TOTAL_EMBED) {
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const embed of embeds) {
    const chars = embedCharCount(embed);
    const wouldOverflow =
      current.length >= maxPerMessage || (current.length > 0 && currentChars + chars > maxCharsPerMessage);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(embed);
    currentChars += chars;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ส่งหลาย embed พร้อมกัน (เช่น การ์ดรูปภาพทีละไฟล์) โดยยังเป็น fire-and-forget เหมือนเดิม
function logEmbedsToDiscord(rawEmbeds, { username = 'Image Converter' } = {}) {
  if (!Array.isArray(rawEmbeds) || rawEmbeds.length === 0) return;

  const queue = nextQueue();
  if (!queue) return;

  const sanitized = rawEmbeds.map((e) =>
    sanitizeEmbed({
      timestamp: new Date().toISOString(),
      footer: { text: `Image Converter • ${nowThai()}` },
      ...e,
    })
  );

  const chunks = chunkEmbeds(sanitized);
  chunks.forEach((chunk) => queue.push({ username, embeds: chunk }));
}

function formatFileList(names, max = 1000) {
  const joined = names.join(', ');
  return truncate(joined, max);
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

function safeBaseName(originalname) {
  return (
    path
      .basename(originalname, path.extname(originalname))
      .replace(/[^a-zA-Z0-9ก-๙_\- ]/g, '_') || 'image'
  );
}

// สุ่ม token กันชื่อไฟล์ชนกัน/เดาลิงก์ยาก
function randomToken() {
  return crypto.randomBytes(6).toString('hex');
}

app.post('/convert', (req, res) => {
  upload.array('images')(req, res, async (err) => {
    if (err) {
      logToDiscord({
        title: '❌ /convert ผิดพลาดตอนรับไฟล์',
        description: err.message,
        color: 0xed4245,
      });
      return res.status(400).json({ error: err.message });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'ไม่มีไฟล์ถูกส่งมา' });
    }

    const startedAt = Date.now();

    try {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="cropped-500x500-png.zip"');

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (archiveErr) => {
        logToDiscord({
          title: '❌ /convert ผิดพลาดตอน zip',
          description: archiveErr.message,
          color: 0xed4245,
        });
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

        const baseName = safeBaseName(file.originalname);

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

      logToDiscord({
        title: '✅ /convert สำเร็จ',
        description: `แปลงรูป ${files.length} ไฟล์เป็น ZIP`,
        color: 0x57f287,
        fields: [
          { name: 'จำนวนไฟล์', value: String(files.length), inline: true },
          {
            name: 'ขนาดรวม (ต้นฉบับ)',
            value: formatBytes(files.reduce((sum, f) => sum + f.size, 0)),
            inline: true,
          },
          { name: 'เวลาใช้', value: `${Date.now() - startedAt} ms`, inline: true },
          { name: 'ไฟล์', value: formatFileList(files.map((f) => f.originalname)) },
        ],
      });
    } catch (processErr) {
      logToDiscord({
        title: '❌ /convert ผิดพลาดตอนประมวลผล',
        description: processErr.message,
        color: 0xed4245,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: processErr.message });
      } else {
        res.end();
      }
    }
  });
});

// ครอบตัดรูปให้เป็น 500x500 PNG แล้วอัปโหลดขึ้น Vercel Blob
// คืนค่าเป็นลิงก์สาธารณะของแต่ละรูป และส่ง log สรุปผลไป Discord
app.post('/convert-and-link', (req, res) => {
  upload.array('images')(req, res, async (err) => {
    if (err) {
      logToDiscord({
        title: '❌ /convert-and-link ผิดพลาดตอนรับไฟล์',
        description: err.message,
        color: 0xed4245,
      });
      return res.status(400).json({ error: err.message });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '[Server]: ไม่มีไฟล์ถูกส่งมา' });
    }

    const usedNames = new Set();
    const results = [];
    const startedAt = Date.now();

    for (const file of files) {
      const baseName = safeBaseName(file.originalname);
      let finalName = `${baseName}-${randomToken()}.png`;
      while (usedNames.has(finalName)) {
        finalName = `${baseName}-${randomToken()}.png`;
      }
      usedNames.add(finalName);

      try {
        const pngBuffer = await sharp(file.buffer)
          .rotate()
          .resize(500, 500, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer();

        // อัปโหลด buffer ขึ้น Vercel Blob โดยตรง ไม่ต้องเขียนลงดิสก์
        const blob = await put(finalName, pngBuffer, {
          access: 'public',
          contentType: 'image/png',
          addRandomSuffix: false, // เราสุ่ม token ในชื่อไฟล์เองแล้ว
        });

        results.push({
          originalName: file.originalname,
          fileName: finalName,
          url: blob.url,
          error: null,
        });
      } catch (fileErr) {
        results.push({
          originalName: file.originalname,
          fileName: finalName,
          url: null,
          error: fileErr.message,
        });
      }
    }

    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    // Embed สรุปผลรวม (ไม่มีรูป แค่สถิติ — ทุกอย่างในนี้จะถูกห่อกรอบดำโดย sanitizeEmbed อัตโนมัติ)
    const summaryEmbed = {
      title: failed.length === 0 ? '✅ /convert-and-link สำเร็จทั้งหมด' : '⚠️ /convert-and-link สำเร็จบางส่วน',
      description: `อัปโหลด ${succeeded.length}/${results.length} ไฟล์ขึ้น Vercel Blob (${Date.now() - startedAt} ms)`,
      color: failed.length === 0 ? 0x57f287 : 0xfee75c,
    };

    // แต่ละไฟล์ที่สำเร็จ → 1 embed ที่มีรูปแสดงตรง ๆ ในตัว (image.url) ไม่ต้องกดลิงก์
    const successEmbeds = succeeded.map((r) => ({
      title: `🖼️ ${truncate(r.originalName, 200)}`,
      description: r.url,
      color: 0x57f287,
      image: { url: r.url },
    }));

    // ไฟล์ที่พลาด → รวมเป็น field ในกรอบดำเหมือนเดิม (ไม่มีรูปให้โชว์)
    const failedEmbed =
      failed.length > 0
        ? [
            {
              title: '❌ ไฟล์ที่อัปโหลดไม่สำเร็จ',
              color: 0xed4245,
              fields: failed.map((r) => ({ name: r.originalName, value: r.error })),
            },
          ]
        : [];

    logEmbedsToDiscord([summaryEmbed, ...successEmbeds, ...failedEmbed]);

    res.json({ results });
  });
});

app.listen(PORT, () => {
  console.log(`เปิดเว็บที่ http://localhost:${PORT}`);
  logToDiscord({
    title: '🚀 เซิร์ฟเวอร์เริ่มทำงาน',
    description: `ฟังที่พอร์ต ${PORT}`,
    color: 0x5865f2,
  });
});
