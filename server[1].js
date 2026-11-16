'use strict';
require('dotenv').config({ quiet: true });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

/* ============ Sozlamalar ============ */
const PORT = Number(process.env.PORT) || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bloodmoon';
const IS_PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const PAYMENT_TEST_MODE = process.env.PAYMENT_TEST_MODE !== 'false';
const SEED_SAMPLES = process.env.SEED_SAMPLES !== 'false';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('Eslatma: JWT_SECRET yoʻq. Server qayta ishga tushganda hamma tizimdan chiqib ketadi. .env faylida JWT_SECRET yozing.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});
pool.on('error', e => console.error('Baza xatosi:', e.message));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ============ Baza ============ */
async function ensureDatabase() {
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    if (e.code !== '3D000') throw e; // baza yoʻq
    const u = new URL(DATABASE_URL);
    const dbName = decodeURIComponent(u.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw e;
    u.pathname = '/postgres';
    const admin = new Pool({
      connectionString: u.toString(),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });
    try { await admin.query(`CREATE DATABASE "${dbName}"`); } finally { await admin.end(); }
    console.log('Baza yaratildi:', dbName);
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT,
     google BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS products (
     id SERIAL PRIMARY KEY,
     owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('app','game','book')),
     platform TEXT NOT NULL CHECK (platform IN ('android','pc','all')),
     price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
     emoji TEXT NOT NULL DEFAULT '📦',
     grad SMALLINT,
     file_name TEXT,
     file_key TEXT,
     sample BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
     amount INTEGER NOT NULL,
     provider TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS orders_user_product_idx ON orders (user_id, product_id)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
];

const SAMPLES = [
  ['Moon Runner',         'game', 'android', 0,     '🌙', 0],
  ['Qizil Poyga',         'game', 'pc',      45000, '🏎️', 1],
  ['Shaxmat Ustasi',      'game', 'all',     0,     '♟️', 2],
  ['Eslatmalar',          'app',  'android', 0,     '📝', 3],
  ['Fayl Boshqaruvchi',   'app',  'pc',      30000, '📁', 4],
  ['Hisob-kitob',         'app',  'android', 12000, '🧮', 5],
  ['Dasturlashga kirish', 'book', 'all',     35000, '📘', 6],
  ['Oʻzbek ertaklari',    'book', 'all',     0,     '📚', 7]
];

async function initDb() {
  await ensureDatabase();
  for (const sql of SCHEMA) await pool.query(sql);

  if (!SEED_SAMPLES) {
    await pool.query('DELETE FROM products WHERE sample = TRUE');
    await pool.query(`DELETE FROM meta WHERE key = 'samples_seeded'`);
    return;
  }
  const seeded = await pool.query(`SELECT 1 FROM meta WHERE key = 'samples_seeded'`);
  if (seeded.rowCount) return;
  for (const [name, type, platform, price, emoji, grad] of SAMPLES) {
    await pool.query(
      `INSERT INTO products (owner_id, name, type, platform, price, emoji, grad, sample)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, TRUE)`,
      [name, type, platform, price, emoji, grad]
    );
  }
  await pool.query(`INSERT INTO meta (key, value) VALUES ('samples_seeded', '1')`);
}

/* ============ Yordamchilar ============ */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(s) {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(404, 'Mahsulot topilmadi.');
  return n;
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f]/g, '').trim();
}

function cleanProduct(b) {
  const TYPES = ['app', 'game', 'book'];
  const PLATFORMS = ['android', 'pc', 'all'];
  const name = cleanName(b.name).slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'Mahsulot nomini kiriting.');
  if (!TYPES.includes(b.type)) throw new HttpError(400, 'Mahsulot turi notoʻgʻri.');
  if (!PLATFORMS.includes(b.platform)) throw new HttpError(400, 'Qurilma notoʻgʻri.');
  const price = Math.round(Number(b.price) || 0);
  if (price < 0 || price > 100000000) throw new HttpError(400, 'Narx notoʻgʻri.');
  const defaults = { app: '📱', game: '🎮', book: '📖' };
  const emoji = [...cleanName(b.emoji)].slice(0, 4).join('') || defaults[b.type];
  return { name, type: b.type, platform: b.platform, price, emoji };
}

function fileNameOf(file) {
  // multer fayl nomini latin1 deb oʻqiydi, shuning uchun utf8 ga qaytaramiz
  let n = Buffer.from(file.originalname, 'latin1').toString('utf8');
  n = n.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 150);
  return n || 'fayl';
}

async function rmFile(key) {
  if (!key || !/^[a-f0-9]{32}$/.test(key)) return;
  try { await fs.promises.unlink(path.join(UPLOAD_DIR, key)); } catch (e) { /* fayl yoʻq boʻlsa muammo emas */ }
}

function publicProduct(row, user) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    platform: row.platform,
    price: row.price,
    emoji: row.emoji,
    grad: row.grad,
    sample: row.sample,
    hasFile: !!row.file_key,
    fileName: row.file_name || '',
    own: !!(user && row.owner_id && row.owner_id === user.id),
    paid: !!row.paid
  };
}

async function getProduct(id) {
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  return rows[0] || null;
}

/* ============ Kirish (cookie + JWT) ============ */
function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('bm_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 3600 * 1000
  });
}

async function loadUser(req, res, next) {
  req.user = null;
  const t = req.cookies && req.cookies.bm_token;
  if (t) {
    try {
      const { uid } = jwt.verify(t, JWT_SECRET);
      const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [uid]);
      req.user = rows[0] || null;
    } catch (e) { req.user = null; }
  }
  next();
}

const requireAuth = (req, res, next) =>
  req.user ? next() : next(new HttpError(401, 'Avval tizimga kiring.'));

async function verifyGoogleAccessToken(accessToken) {
  if (!GOOGLE_CLIENT_ID) throw new HttpError(503, 'Google orqali kirish serverda sozlanmagan.');
  if (typeof accessToken !== 'string' || accessToken.length < 10) throw new HttpError(400, 'Google tokeni notoʻgʻri.');
  const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken));
  if (!ti.ok) throw new HttpError(401, 'Google tokeni yaroqsiz.');
  const info = await ti.json();
  if (info.aud !== GOOGLE_CLIENT_ID) throw new HttpError(401, 'Google tokeni bu doʻkon uchun emas.');
  const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!ui.ok) throw new HttpError(401, 'Google maʼlumotini olib boʻlmadi.');
  const u = await ui.json();
  const verified = u.email_verified === true || u.email_verified === 'true';
  if (!u.email || !verified) throw new HttpError(401, 'Google elektron pochtasi tasdiqlanmagan.');
  return { email: String(u.email).toLowerCase(), name: cleanName(u.name || u.email.split('@')[0]).slice(0, 60) || 'Foydalanuvchi' };
}

/* ============ Fayl yuklash ============ */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex'))
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 12 }
});

function uploadFile(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `Fayl juda katta (eng koʻpi ${MAX_UPLOAD_MB} MB).`));
    next(new HttpError(400, 'Faylni yuklab boʻlmadi.'));
  });
}

/* ============ Ilova ============ */
const app = express();
app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1);
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.use('/api', h(loadUser));
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Juda koʻp urinish. 15 daqiqadan keyin qayta urinib koʻring.' }
}));

app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID, paymentTestMode: PAYMENT_TEST_MODE, maxUploadMb: MAX_UPLOAD_MB });
});

app.get('/api/me', (req, res) => res.json({ user: req.user }));

/* --- Hisob --- */
app.post('/api/auth/register', h(async (req, res) => {
  const name = cleanName(req.body.name).slice(0, 60);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) throw new HttpError(400, 'Ismingizni kiriting.');
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) throw new HttpError(400, 'Elektron pochta notoʻgʻri.');
  if (password.length < 6) throw new HttpError(400, 'Parol kamida 6 ta belgidan iborat boʻlsin.');
  if (password.length > 72) throw new HttpError(400, 'Parol juda uzun (eng koʻpi 72 belgi).');
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name, email, hash]
    );
    setSession(res, rows[0]);
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Bu elektron pochta band. Kirish tugmasini bosing.');
    throw e;
  }
}));

app.post('/api/auth/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const u = rows[0];
  if (u && u.google && !u.password_hash) {
    throw new HttpError(400, 'Bu hisob Google orqali ochilgan. Google orqali kirish tugmasini bosing.');
  }
  const ok = u && await bcrypt.compare(password, u.password_hash);
  if (!ok) throw new HttpError(401, 'Elektron pochta yoki parol notoʻgʻri.');
  setSession(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
}));

app.post('/api/auth/google', h(async (req, res) => {
  const g = await verifyGoogleAccessToken(req.body.accessToken);
  let { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [g.email]);
  let u = rows[0];
  if (!u) {
    ({ rows } = await pool.query(
      'INSERT INTO users (name, email, google) VALUES ($1, $2, TRUE) RETURNING *', [g.name, g.email]
    ));
    u = rows[0];
  }
  setSession(res, u);
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('bm_token', { httpOnly: true, sameSite: 'lax', secure: IS_PROD });
  res.json({ ok: true });
});

/* --- Mahsulotlar --- */
app.get('/api/products', h(async (req, res) => {
  const TYPES = ['app', 'game', 'book'];
  const PLATFORMS = ['android', 'pc'];
  const params = [req.user ? req.user.id : null];
  const where = [];
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) { params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); where.push(`p.name ILIKE $${params.length}`); }
  if (TYPES.includes(req.query.type)) { params.push(req.query.type); where.push(`p.type = $${params.length}`); }
  if (PLATFORMS.includes(req.query.platform)) {
    params.push(req.query.platform);
    where.push(`(p.platform = $${params.length} OR p.platform = 'all')`);
  }
  const { rows } = await pool.query(
    `SELECT p.*,
            EXISTS (SELECT 1 FROM orders o
                    WHERE o.product_id = p.id AND o.user_id = $1::int AND o.status = 'paid') AS paid
       FROM products p
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.sample DESC, p.id ASC`,
    params
  );
  res.json({ products: rows.map(r => publicProduct(r, req.user)) });
}));

app.post('/api/products', requireAuth, uploadFile, h(async (req, res) => {
  try {
    const d = cleanProduct(req.body);
    const f = req.file;
    const { rows } = await pool.query(
      `INSERT INTO products (owner_id, name, type, platform, price, emoji, file_name, file_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.user.id, d.name, d.type, d.platform, d.price, d.emoji, f ? fileNameOf(f) : null, f ? f.filename : null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    if (req.file) await rmFile(req.file.filename);
    throw e;
  }
}));

app.put('/api/products/:id', requireAuth, uploadFile, h(async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const p = await getProduct(id);
    if (!p) throw new HttpError(404, 'Mahsulot topilmadi.');
    if (p.owner_id !== req.user.id) throw new HttpError(403, 'Bu mahsulotni oʻzgartirib boʻlmaydi.');
    const d = cleanProduct(req.body);
    const f = req.file;
    await pool.query(
      `UPDATE products
          SET name = $1, type = $2, platform = $3, price = $4, emoji = $5,
              file_name = COALESCE($6, file_name), file_key = COALESCE($7, file_key)
        WHERE id = $8`,
      [d.name, d.type, d.platform, d.price, d.emoji, f ? fileNameOf(f) : null, f ? f.filename : null, id]
    );
    if (f) await rmFile(p.file_key);
    res.json({ ok: true });
  } catch (e) {
    if (req.file) await rmFile(req.file.filename);
    throw e;
  }
}));

app.delete('/api/products/:id', requireAuth, h(async (req, res) => {
  const id = parseId(req.params.id);
  const p = await getProduct(id);
  if (!p) throw new HttpError(404, 'Mahsulot topilmadi.');
  if (p.owner_id !== req.user.id) throw new HttpError(403, 'Bu mahsulotni oʻchirib boʻlmaydi.');
  await pool.query('DELETE FROM products WHERE id = $1', [id]);
  await rmFile(p.file_key);
  res.json({ ok: true });
}));

async function checkAccess(user, p) {
  if (!p) throw new HttpError(404, 'Mahsulot topilmadi.');
  if (p.price > 0) {
    if (!user) throw new HttpError(401, 'Avval tizimga kiring.');
    if (p.owner_id !== user.id) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM orders WHERE user_id = $1 AND product_id = $2 AND status = 'paid' LIMIT 1`,
        [user.id, p.id]
      );
      if (!rowCount) throw new HttpError(402, 'Avval sotib oling.');
    }
  }
  if (!p.file_key) {
    throw new HttpError(404, p.sample ? 'Bu namunaviy mahsulot, fayli yoʻq' : 'Bu mahsulotga fayl yuklanmagan.');
  }
}

app.get('/api/products/:id/access', h(async (req, res) => {
  const p = await getProduct(parseId(req.params.id));
  await checkAccess(req.user, p);
  res.json({ ok: true });
}));

app.get('/api/products/:id/download', h(async (req, res, next) => {
  const p = await getProduct(parseId(req.params.id));
  await checkAccess(req.user, p);
  res.download(path.join(UPLOAD_DIR, p.file_key), p.file_name || p.name, err => {
    if (err && !res.headersSent) next(new HttpError(404, 'Fayl serverda topilmadi.'));
  });
}));

/* --- Toʻlov --- */
app.post('/api/orders', requireAuth, h(async (req, res) => {
  const productId = Number(req.body.productId);
  const provider = req.body.provider;
  if (!['payme', 'uzum'].includes(provider)) throw new HttpError(400, 'Nomaʼlum toʻlov tizimi.');
  const p = Number.isInteger(productId) ? await getProduct(productId) : null;
  if (!p || p.price <= 0) throw new HttpError(400, 'Bu mahsulot uchun toʻlov kerak emas.');
  if (p.owner_id === req.user.id) return res.json({ status: 'paid' });

  const paid = await pool.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND product_id = $2 AND status = 'paid' LIMIT 1`,
    [req.user.id, p.id]
  );
  if (paid.rowCount) return res.json({ status: 'paid' });

  if (!PAYMENT_TEST_MODE) {
    // Haqiqiy Payme / Uzum Bank toʻlovini tasdiqlash hali yozilmagan.
    throw new HttpError(501, 'Haqiqiy toʻlov hali ulanmagan.');
  }
  await pool.query(
    `INSERT INTO orders (user_id, product_id, amount, provider, status) VALUES ($1, $2, $3, $4, 'paid')`,
    [req.user.id, p.id, p.price, provider]
  );
  res.json({ status: 'paid' });
}));

/* --- Qolganlari --- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi.' }));
const SITE_FILES = ['index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
SITE_FILES.forEach(f => app.get('/' + f, (req, res) => res.sendFile(path.join(__dirname, f))));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Soʻrov notoʻgʻri.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server xatosi. Keyinroq urinib koʻring.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bloodmoon Store ishga tushdi: http://localhost:${PORT}`);
      if (PAYMENT_TEST_MODE) console.log('Toʻlov: test rejimi (pul yechilmaydi).');
    });
  })
  .catch(e => {
    console.error('Serverni ishga tushirib boʻlmadi:', e.message);
    console.error('PostgreSQL ishlayotganini va DATABASE_URL toʻgʻriligini tekshiring.');
    process.exit(1);
  });
