require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());
app.use(cors());
app.use('/static', express.static(path.join(__dirname, 'public')));

// env
const PORT = process.env.PORT || 5000;
const VIDEO_UPLOAD_PATH = process.env.VIDEO_UPLOAD_PATH || './uploads/videos';
if (!fs.existsSync(VIDEO_UPLOAD_PATH)) fs.mkdirSync(VIDEO_UPLOAD_PATH, { recursive: true });

// DB (mysql2 pool)
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'video_store',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const razor = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const jwtSecret = process.env.JWT_SECRET || 'secret123';
function genToken(user) {
  return jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, jwtSecret, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_UPLOAD_PATH),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fname = `${Date.now()}-${Math.random().toString(36).slice(2,9)}${ext}`;
    cb(null, fname);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 500 } }); // 500MB

// ROUTES

app.get('/api/ping', (req, res) => res.json({ ok: true }));

// Register
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const hash = bcrypt.hashSync(password, 10);
  db.query('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name || '', email, hash], (err, result) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already registered' });
      return res.status(500).json({ error: 'DB error', detail: err });
    }
    const user = { id: result.insertId, name, email, is_admin: 0 };
    const token = genToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!results.length) return res.status(400).json({ error: 'Invalid credentials' });
    const user = results[0];
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: 'Invalid credentials' });
    const token = genToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin } });
  });
});

// Public videos list
app.get('/api/videos', (req, res) => {
  db.query('SELECT id, title, description, price, created_at FROM videos ORDER BY created_at DESC', (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(results);
  });
});

// Create Razorpay order
app.post('/api/create-order', authMiddleware, (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  db.query('SELECT * FROM videos WHERE id = ?', [videoId], async (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!results.length) return res.status(404).json({ error: 'Video not found' });
    const video = results[0];
    const amount = video.price || 0;
    const options = { amount: amount * 100, currency: 'INR', receipt: `rcpt_${Date.now()}`, payment_capture: 1 };
    try {
      const order = await razor.orders.create(options);
      res.json({ order, video: { id: video.id, title: video.title, price: video.price } });
    } catch (e) {
      return res.status(500).json({ error: 'Razorpay error', detail: e.message || e.toString() });
    }
  });
});

// Verify payment and record order
app.post('/api/verify-payment', authMiddleware, (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, videoId } = req.body;
  if (!razorpay_payment_id || !videoId) return res.status(400).json({ error: 'payment id & videoId required' });
  db.query('SELECT * FROM videos WHERE id = ?', [videoId], (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!results.length) return res.status(404).json({ error: 'Video not found' });
    const video = results[0];
    db.query('INSERT INTO orders (user_id, video_id, payment_id, status, amount) VALUES (?, ?, ?, ?, ?)', [req.user.id, videoId, razorpay_payment_id, 'PAID', video.price], (err2, result) => {
      if (err2) return res.status(500).json({ error: 'DB insert error', detail: err2 });
      res.json({ success: true, orderId: result.insertId });
    });
  });
});

// Check access
app.get('/api/check-access/:videoId', authMiddleware, (req, res) => {
  const videoId = req.params.videoId;
  db.query('SELECT * FROM orders WHERE user_id = ? AND video_id = ? AND status = "PAID"', [req.user.id, videoId], (err, results) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ access: results.length > 0 });
  });
});

// Stream video (requires access)
app.get('/video/stream/:id', authMiddleware, (req, res) => {
  const videoId = req.params.id;
  db.query('SELECT v.filename, u.is_admin, (SELECT COUNT(*) FROM orders o WHERE o.user_id = ? AND o.video_id = ? AND o.status = "PAID") as has_order FROM videos v JOIN users u ON u.id = ? WHERE v.id = ?', [req.user.id, videoId, req.user.id, videoId], (err, results) => {
    if (err) return res.status(500).send('DB error');
    if (!results.length) return res.status(404).send('Video not found');
    const row = results[0];
    const hasAccess = row.is_admin === 1 || row.has_order > 0;
    if (!hasAccess) return res.status(403).send('Payment required');
    const filePath = path.join(VIDEO_UPLOAD_PATH, row.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4'
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

// Admin upload (simple admin check skipped for brevity: mark first user as admin via DB)
app.post('/api/admin/upload', authMiddleware, upload.single('video'), (req, res) => {
  // For demo, allow any authenticated user to upload (make admin using DB)
  const { title, description, price } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Video file required' });
  db.query('INSERT INTO videos (title, description, filename, price) VALUES (?, ?, ?, ?)', [title || 'Untitled', description || '', req.file.filename, parseInt(price || 0)], (err, result) => {
    if (err) return res.status(500).json({ error: 'DB error', detail: err });
    res.json({ success: true, videoId: result.insertId });
  });
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
