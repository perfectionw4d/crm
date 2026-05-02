require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

// ─── Security: Helmet (HTTP headers) ─────────────────────────────────────────
let helmet = null;
try { helmet = require('helmet'); } catch(e) { console.warn('[Security] helmet לא מותקן — דלג'); }

// ─── Security: Rate Limiter (in-memory) ──────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, firstAt, blockedUntil }
const RATE_LIMIT_MAX    = 5;           // ניסיונות מקסימליים
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // חלון זמן — 15 דקות
const RATE_LIMIT_BLOCK  = 15 * 60 * 1000; // זמן חסימה — 15 דקות
const ALERT_THRESHOLD   = 10;          // התראת WA אחרי X כישלונות

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    const minsLeft = Math.ceil((entry.blockedUntil - now) / 60000);
    return { blocked: true, minsLeft };
  }
  if (now - entry.firstAt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 0, firstAt: now, blockedUntil: 0 });
    return { blocked: false };
  }
  return { blocked: false };
}

function recordFailedLogin(ip, identifier) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > RATE_LIMIT_WINDOW) {
    entry.count = 0; entry.firstAt = now; entry.blockedUntil = 0;
  }
  entry.count++;
  if (entry.count >= RATE_LIMIT_MAX) {
    entry.blockedUntil = now + RATE_LIMIT_BLOCK;
    console.warn(`[Security] 🚫 IP חסום: ${ip} (${entry.count} ניסיונות כושלים)`);
  }
  loginAttempts.set(ip, entry);
  if (entry.count === ALERT_THRESHOLD) {
    sendSecurityAlert(ip, identifier, entry.count).catch(()=>{});
  }
  return entry;
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

async function sendSecurityAlert(ip, identifier, count) {
  const msg = `🚨 *התראת אבטחה — CRM שקוף בחזית*\n\n${count} ניסיונות כניסה כושלים\nIP: ${ip}\nמשתמש: ${identifier || 'לא ידוע'}\nזמן: ${new Date().toLocaleString('he-IL')}\n\nה-IP נחסם אוטומטית ל-15 דקות.`;
  const phone = process.env.NOTIFY_PHONE;
  if (!phone || !process.env.WA_ACCESS_TOKEN) return;
  try {
    await fetch(`https://graph.facebook.com/v18.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product:'whatsapp', to: phone, type:'text', text:{ body: msg } })
    });
    console.log('[Security] התראת WA נשלחה');
  } catch(e) { console.error('[Security] שגיאה בשליחת התראה:', e.message); }
}

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const PUB  = path.join(__dirname, 'public');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(PUB))  fs.mkdirSync(PUB,  { recursive: true });

// ─── Server Config (setup wizard values, auto-generated secrets) ──────────────
const SERVER_CONFIG_FILE = path.join(DATA, 'server-config.json');
function loadServerConfig() {
  try { return JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveServerConfig(cfg) {
  fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
let serverConfig = loadServerConfig();

// Auto-generate SESSION_SECRET on first run
if (!process.env.SESSION_SECRET && !serverConfig.sessionSecret) {
  serverConfig.sessionSecret = crypto.randomBytes(32).toString('hex');
  saveServerConfig(serverConfig);
  console.log('[Setup] SESSION_SECRET נוצר אוטומטית');
}

// Apply wizard-configured values to process.env (env vars always take priority)
const SETUP_ENV_MAP = {
  waPhoneNumberId:     'WA_PHONE_NUMBER_ID',
  waBusinessAccountId: 'WA_BUSINESS_ACCOUNT_ID',
  waAccessToken:       'WA_ACCESS_TOKEN',
  notifyPhone:         'NOTIFY_PHONE',
  wpUrl:               'WP_URL',
  wpApiKey:            'WP_API_KEY',
  resendApiKey:        'RESEND_API_KEY',
  resendFrom:          'RESEND_FROM',
};
for (const [cfgKey, envKey] of Object.entries(SETUP_ENV_MAP)) {
  if (!process.env[envKey] && serverConfig[cfgKey]) {
    process.env[envKey] = serverConfig[cfgKey];
  }
}

// ─── OAuth2 ────────────────────────────────────────────────────────────────────
const BASE_URL = process.env.RAILWAY_STATIC_URL
  ? `https://${process.env.RAILWAY_STATIC_URL}`
  : process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// ─── Middleware ───────────────────────────────────────────────────────────────
if (helmet) app.use(helmet({ contentSecurityPolicy: false })); // כותרות אבטחה
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, ttl: 7 * 24 * 3600, retries: 1, logFn: ()=>{} }),
  secret: process.env.SESSION_SECRET || serverConfig.sessionSecret || 'crm-default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'changeme';
const RECOVERY_CODE    = process.env.RECOVERY_CODE    || 'shakuf-restore-2024';

// ─── Multi-User Storage ───────────────────────────────────────────────────────
function loadUsers()       { return rj('users.json', []); }
function saveUsers(users)  { wj('users.json', users); }
function isSetupComplete() { return loadUsers().length > 0; }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const testHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return testHash === hash;
}

// ─── Email sending — Resend API (primary) / Gmail SMTP (fallback) ─────────────
async function sendEmail({ to, subject, html }) {
  // נסה Resend ראשון (עובד בכל סביבת ענן)
  if (process.env.RESEND_API_KEY) {
    const fromName = 'שקוף בחזית CRM';
    const fromAddr = process.env.RESEND_FROM || 'onboarding@resend.dev';
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: `${fromName} <${fromAddr}>`, to: [to], subject, html }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || data.error || `Resend error ${resp.status}`);
    return data;
  }
  // Fallback: Gmail SMTP (לסביבה מקומית)
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"שקוף בחזית CRM" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to, subject, html,
  });
}

function requirePassword(req, res, next) {
  // Setup wizard — always accessible before first user is created
  if (req.path === '/setup' || req.path.startsWith('/api/setup/')) return next();

  // If no users yet, redirect everything to setup
  if (!isSetupComplete()) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'setup_required', redirect: '/setup' });
    return res.redirect('/setup');
  }

  if (req.session && (req.session.authenticated || req.session.userId)) return next();
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path.startsWith('/auth/reset-password')) return next();
  // Elementor webhook must be accessible without auth (external POST from website)
  if (req.path === '/api/webhook/elementor') return next();
  // Data migration endpoint — uses its own secret
  if (req.path === '/api/admin/import-data') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
}

app.get('/login', (req, res) => {
  if (req.session && (req.session.authenticated || req.session.userId)) return res.redirect('/');
  res.sendFile(path.join(PUB, 'login.html'));
});

app.post('/login', (req, res) => {
  const ip = getClientIP(req);
  const { password, email } = req.body;

  // בדיקת Rate Limit
  const limit = checkRateLimit(ip);
  if (limit.blocked) {
    console.warn(`[Security] ⛔ ניסיון כניסה מ-IP חסום: ${ip}`);
    return res.status(429).json({ error: `יותר מדי ניסיונות. נסה שוב בעוד ${limit.minsLeft} דקות.` });
  }

  // Admin / recovery login (no email)
  if (!email && (password === ADMIN_PASSWORD || password === RECOVERY_CODE)) {
    clearLoginAttempts(ip);
    req.session.authenticated = true;
    return res.json({ ok: true, role: 'admin' });
  }
  // Email + password login
  if (email) {
    const users = loadUsers();
    const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase() && u.active !== false);
    if (user && user.passwordHash && verifyPassword(password, user.passwordHash)) {
      clearLoginAttempts(ip);
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.userName = user.name;
      return res.json({ ok: true, role: 'user', name: user.name });
    }
    recordFailedLogin(ip, email);
    return res.status(401).json({ error: 'כתובת אימייל או סיסמה שגויים' });
  }
  // Legacy: password-only, no email
  if (password === ADMIN_PASSWORD || password === RECOVERY_CODE) {
    clearLoginAttempts(ip);
    req.session.authenticated = true;
    return res.json({ ok: true, role: 'admin' });
  }
  recordFailedLogin(ip, 'admin');
  res.status(401).json({ error: 'סיסמה שגויה' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ─── Current User Info ───────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const userinfo = rj('userinfo.json', {});
  const users = loadUsers();
  const sessionUser = req.session.userId ? users.find(u => u.id === req.session.userId) : null;
  res.json({
    name:         sessionUser?.name || userinfo.ownerName || '',
    businessName: userinfo.businessName || '',
    businessDesc: userinfo.businessDesc || '',
    email:        sessionUser?.email || userinfo.email || '',
    logoUrl:      userinfo.logoUrl || null,
  });
});

// ─── Setup Reset (זמני — למחוק אחרי שימוש) ───────────────────────────────────
app.get('/api/setup/reset', (req, res) => {
  if (req.query.secret !== 'anastasia-reset-2026') return res.status(403).json({ error: 'Forbidden' });
  ['users.json','userinfo.json','server-config.json','logo-custom.png','signatures.json'].forEach(f => {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  res.json({ ok: true, message: 'Setup reset — רענן את הדף' });
});

// ─── Setup Wizard Routes ──────────────────────────────────────────────────────
app.get('/setup', (req, res) => {
  if (isSetupComplete()) return res.redirect('/');
  res.sendFile(path.join(PUB, 'setup.html'));
});

app.get('/api/setup/status', (req, res) => {
  res.json({ needsSetup: !isSetupComplete() });
});

app.post('/api/setup/logo', (req, res) => {
  if (isSetupComplete()) return res.status(400).json({ error: 'Setup already complete' });
  const { logo } = req.body;
  if (!logo || !logo.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid logo' });
  try {
    const base64 = logo.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    // שמור ב-data/ (Volume — שורד restart) וגם ב-public/
    fs.writeFileSync(path.join(DATA, 'logo-custom.png'), buf);
    fs.writeFileSync(path.join(PUB, 'logo-custom.png'), buf);
    res.json({ ok: true, url: '/logo-custom.png' });
  } catch(e) {
    res.status(500).json({ error: 'שגיאה בשמירת הלוגו' });
  }
});

// הגש לוגו מותאם אם קיים — Volume גובר על קובץ ה-repo
app.get('/logo.png', (req, res) => {
  const custom = path.join(DATA, 'logo-custom.png');
  if (fs.existsSync(custom)) return res.sendFile(custom);
  res.sendFile(path.join(PUB, 'logo.png'));
});

app.post('/api/setup/init', async (req, res) => {
  if (isSetupComplete()) return res.status(400).json({ error: 'Setup already complete' });

  const { ownerName, businessName, businessDesc, email, password, wa, resend } = req.body;
  if (!ownerName || !businessName || !email || !password) {
    return res.status(400).json({ error: 'שדות חובה חסרים' });
  }

  // Create first admin user
  const users = loadUsers();
  const newUser = {
    id: uid(), name: ownerName,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    active: true,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  saveUsers(users);

  // Save business info to userinfo.json
  wj('userinfo.json', {
    ownerName, businessName,
    businessDesc: businessDesc || '',
    email,
    phone: wa?.notifyPhone || '',
    logoUrl: fs.existsSync(path.join(PUB, 'logo-custom.png')) ? '/logo-custom.png' : null,
    updatedAt: new Date().toISOString(),
  });

  // Save integration credentials to server-config.json
  const cfg = loadServerConfig();
  if (wa?.accessToken) {
    cfg.waPhoneNumberId     = wa.phoneNumberId;
    cfg.waBusinessAccountId = wa.businessAccountId;
    cfg.waAccessToken       = wa.accessToken;
    if (wa.notifyPhone) cfg.notifyPhone = wa.notifyPhone;
  }
  if (resend?.apiKey) {
    cfg.resendApiKey = resend.apiKey;
    if (resend.fromEmail) cfg.resendFrom = resend.fromEmail;
  }
  saveServerConfig(cfg);

  // Apply new values to process.env for current runtime
  for (const [cfgKey, envKey] of Object.entries(SETUP_ENV_MAP)) {
    if (!process.env[envKey] && cfg[cfgKey]) process.env[envKey] = cfg[cfgKey];
  }

  // Auto-login the new user
  req.session.userId    = newUser.id;
  req.session.userEmail = newUser.email;
  req.session.userName  = newUser.name;

  console.log(`[Setup] הגדרה הושלמה עבור: ${businessName} (${email})`);
  res.json({ ok: true });
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'נדרשת כתובת אימייל' });
  const users = loadUsers();
  const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  // Always respond OK to avoid email enumeration
  if (!user) return res.json({ ok: true });
  const token = crypto.randomBytes(32).toString('hex');
  user.resetToken  = token;
  user.resetExpiry = Date.now() + 3600000; // 1 hour
  saveUsers(users);
  const link = `${BASE_URL}/auth/reset-password/${token}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'איפוס סיסמה — שקוף בחזית CRM',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif; max-width:480px; margin:auto; padding:32px; border:1px solid #e2e8f0; border-radius:12px;">
          <h2 style="color:#1e293b; margin-bottom:8px;">🎭 שקוף בחזית CRM</h2>
          <p style="color:#475569; margin-bottom:24px;">שלום ${user.name || user.email},</p>
          <p style="color:#334155;">קיבלנו בקשה לאיפוס הסיסמה שלך. לחץ על הכפתור הבא לאיפוס:</p>
          <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 28px;background:#6366f1;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">איפוס סיסמה</a>
          <p style="color:#94a3b8;font-size:12px;">הקישור תקף לשעה אחת. אם לא ביקשת איפוס, תוכל להתעלם מהודעה זו.</p>
        </div>
      `,
    });
  } catch(e) { console.error('[Reset Password] שגיאת שליחת מייל:', e.message); }
  res.json({ ok: true });
});

app.get('/auth/reset-password/:token', (req, res) => {
  res.sendFile(path.join(PUB, 'reset-password.html'));
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'חסרים פרטים' });
  if (password.length < 8) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
  const users = loadUsers();
  const user = users.find(u => u.resetToken === token && u.resetExpiry > Date.now());
  if (!user) return res.status(400).json({ error: 'הקישור לא תקין או פג תוקפו' });
  user.passwordHash = hashPassword(password);
  user.resetToken   = null;
  user.resetExpiry  = null;
  saveUsers(users);
  res.json({ ok: true });
});

// ─── User Management API ──────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = loadUsers().map(u => ({ ...u, passwordHash: undefined, resetToken: undefined, resetExpiry: undefined }));
  res.json(users);
});

app.post('/api/users', async (req, res) => {
  const { name, email, password, contactId } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'אימייל וסיסמה הם שדות חובה' });
  if (password.length < 8) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
  const users = loadUsers();
  if (users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
  }
  const user = {
    id: uid(),
    name: name || email,
    email,
    passwordHash: hashPassword(password),
    contactId: contactId || null,
    active: true,
    createdAt: today(),
    resetToken: null,
    resetExpiry: null,
  };
  users.push(user);
  saveUsers(users);
  // Send welcome email
  try {
    await sendEmail({
      to: email,
      subject: 'ברוכים הבאים למערכת שקוף בחזית CRM',
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif; max-width:480px; margin:auto; padding:32px; border:1px solid #e2e8f0; border-radius:12px;">
          <h2 style="color:#1e293b; margin-bottom:8px;">🎭 שקוף בחזית CRM</h2>
          <p style="color:#475569; margin-bottom:8px;">שלום ${user.name},</p>
          <p style="color:#334155; margin-bottom:16px;">הוגדרת כמנהל/ת במערכת ניהול קשרי הלקוחות של <strong>שקוף בחזית</strong>.</p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="margin:0 0 8px;color:#475569;font-size:14px;"><strong>פרטי כניסה:</strong></p>
            <p style="margin:0 0 4px;color:#334155;font-size:14px;">🌐 כתובת: <a href="${BASE_URL}">${BASE_URL}</a></p>
            <p style="margin:0 0 4px;color:#334155;font-size:14px;">📧 שם משתמש: <strong>${email}</strong></p>
            <p style="margin:0;color:#334155;font-size:14px;">🔑 סיסמה: <strong>${password}</strong></p>
          </div>
          <p style="color:#94a3b8;font-size:12px;">מומלץ לשנות את הסיסמה לאחר הכניסה הראשונה.</p>
        </div>
      `,
    });
    console.log('[Users] מייל ברוכים הבאים נשלח אל:', email);
  } catch(e) {
    console.error('[Users] שגיאת שליחת מייל:', e.message, e.code || '');
    return res.json({ ok: true, emailError: e.message, user: { ...user, passwordHash: undefined } });
  }
  res.json({ ok: true, emailSent: true, user: { ...user, passwordHash: undefined } });
});

app.put('/api/users/:id', async (req, res) => {
  const users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'משתמש לא נמצא' });
  const { name, email, password, active, contactId } = req.body;
  if (name  !== undefined) users[idx].name      = name;
  if (email !== undefined) users[idx].email     = email;
  if (active !== undefined) users[idx].active   = active;
  if (contactId !== undefined) users[idx].contactId = contactId;
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
    users[idx].passwordHash = hashPassword(password);
  }
  saveUsers(users);
  res.json({ ok: true, user: { ...users[idx], passwordHash: undefined } });
});

app.delete('/api/users/:id', (req, res) => {
  let users = loadUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'משתמש לא נמצא' });
  users.splice(idx, 1);
  saveUsers(users);
  res.json({ ok: true });
});

app.use(requirePassword);
app.use(express.static(PUB));

// ─── JSON Storage ─────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split('T')[0];
const uid   = () => uuidv4().slice(0, 8);

function rj(file, def = []) {
  const fp = path.join(DATA, file);
  if (!fs.existsSync(fp)) return def;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return def; }
}
function wj(file, data) {
  const fp  = path.join(DATA, file);
  const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');

  // Auto-backup important files before overwrite (keep last 3 copies)
  if (file === 'contacts.json' || file === 'orgs.json') {
    try {
      const BDIR = path.join(DATA, 'backups');
      if (!fs.existsSync(BDIR)) fs.mkdirSync(BDIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const bkp = path.join(BDIR, `${file}.${stamp}.bak`);
      if (fs.existsSync(fp)) fs.copyFileSync(fp, bkp);
      // Keep only last 5 backups per file
      const files = fs.readdirSync(BDIR).filter(f=>f.startsWith(file)).sort();
      while (files.length > 5) { try { fs.unlinkSync(path.join(BDIR, files.shift())); } catch {} }
    } catch {}
  }

  // Atomic write: write directly (OneDrive EPERM on rename workaround)
  const tmp = fp + '.tmp';
  const fd  = fs.openSync(tmp, 'w');
  try {
    const CHUNK = 65536;
    let pos = 0;
    while (pos < buf.length) {
      const end = Math.min(pos + CHUNK, buf.length);
      fs.writeSync(fd, buf, pos, end - pos, pos);
      pos = end;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    // OneDrive EPERM fallback: write directly
    fs.writeFileSync(fp, buf);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ─── WA Messages Storage ─────────────────────────────────────────────────────
function loadWaMsgs()      { return rj('wa-messages.json', []); }
function saveWaMsgs(list)  { wj('wa-messages.json', list); }

function normPhoneCrm(raw) {
  // raw = whatsapp JID like "972521234567@s.whatsapp.net" or plain digits
  let d = (raw||'').replace(/[^\d]/g, '');
  if (d.startsWith('972') && d.length >= 11) d = '0' + d.slice(3);
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 9)  return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
  return d;
}

function findContactByPhone(phone) {
  const norm = normPhoneCrm(phone);
  const contacts = rj('contacts.json', []);
  return contacts.find(c => normPhoneCrm(c.phone||'') === norm) || null;
}

function logWaMsg({ direction, rawPhone, name, contactId, showId, message, source }) {
  const msgs = loadWaMsgs();
  const entry = {
    id: uid(),
    direction,           // 'sent' | 'received'
    phone: normPhoneCrm(rawPhone),
    rawPhone,
    name:  name || '',
    contactId: contactId || null,
    showId:    showId    || null,
    message,
    timestamp: Date.now(),
    source,              // 'broadcast' | 'single' | 'incoming'
  };
  msgs.push(entry);
  // שמור רק 2000 הודעות אחרונות
  if (msgs.length > 2000) msgs.splice(0, msgs.length - 2000);
  saveWaMsgs(msgs);
  return entry;
}

// ─── Token Persistence ────────────────────────────────────────────────────────
function loadStoredTokens() {
  const fp = path.join(DATA, 'tokens.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function storeTokens(tokens) { wj('tokens.json', tokens); }

// ── Multi-account support (חשבונות Gmail נוספים) ───────────────────────────
function loadExtraAccounts() {
  const fp = path.join(DATA, 'extra-tokens.json');
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}
function saveExtraAccounts(accounts) { wj('extra-tokens.json', accounts); }

function makeGmailClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(tokens);
  return client;
}

// Background auth client (no request session needed)
function bgAuth() {
  const tokens = loadStoredTokens();
  if (!tokens) return null;
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(tokens);
  client.on('tokens', refreshed => { storeTokens({ ...tokens, ...refreshed }); });
  return client;
}

// ─── Sample data ──────────────────────────────────────────────────────────────
function init() {
  if (rj('orgs.json').length === 0) {
    wj('orgs.json', [
      { id:'org1', name:'מרכז תרבות רמת גן', industry:'תרבות ובידור', phone:'03-1234567', email:'culture@rg.muni.il', city:'רמת גן', status:'warm', source:'המלצה', notes:'מעוניינים במופע לחנוכה', tags:['תרבות'], conversations:[], showHistory:[], nextFollowUp:'2026-04-20', googleContactId:null, createdAt:'2026-03-01' },
      { id:'org2', name:'עיריית נתניה — מחלקת תרבות', industry:'מגזר ציבורי', phone:'09-8765432', email:'culture@netanya.muni.il', city:'נתניה', status:'booked', source:'יוזמה עצמית', notes:'אישרו הרצאה. ממתין לחוזה.', tags:['עירייה'], conversations:[], showHistory:[{id:'sh1',date:'2026-03-13',venue:'אולם תרבות נתניה',showType:'הרצאה',status:'scheduled',fee:'2500',notes:''}], nextFollowUp:'', googleContactId:null, createdAt:'2026-02-15' }
    ]);
  }
  if (rj('contacts.json').length === 0) {
    wj('contacts.json', [
      { id:'c1', name:'דנה לוי', organizationId:'org1', role:'מנהלת תרבות', phone:'052-1234567', email:'dana@rg.muni.il', city:'רמת גן', status:'warm', source:'', notes:'איש קשר ראשי', tags:[], conversations:[{id:'cv1',date:'2026-03-20',type:'call',content:'שיחה ראשונית — מעוניינת במופע לחנוכה'}], showHistory:[], nextFollowUp:'2026-04-20', googleContactId:null, createdAt:'2026-03-20' },
      { id:'c2', name:'אבי כהן', organizationId:null, role:'', phone:'054-9876543', email:'avi@gmail.com', city:'תל אביב', status:'vip', source:'מופע', notes:'חובב נלהב! היה בשלושה מופעים.', tags:['VIP'], conversations:[{id:'cv2',date:'2026-02-14',type:'whatsapp',content:'שלח הודעה אחרי המופע — מאוד נהנה!'}], showHistory:[{id:'sh2',date:'2026-02-14',venue:'תיאטרון הבימה',showType:'מופע רגיל',status:'completed',fee:'',notes:''}], nextFollowUp:'', googleContactId:null, createdAt:'2025-10-01' },
      { id:'c3', name:'יוסי מזרחי', organizationId:'org2', role:'מנהל תרבות', phone:'050-8765432', email:'yossi@netanya.muni.il', city:'נתניה', status:'booked', source:'', notes:'', tags:[], conversations:[], showHistory:[], nextFollowUp:'', googleContactId:null, createdAt:'2026-02-15' }
    ]);
  }
  if (rj('tasks.json').length === 0) {
    wj('tasks.json', [
      { id:'t1', title:'לשלוח הצעת מחיר לדנה לוי', type:'task', contactId:'c1', organizationId:'org1', conversationId:'cv1', dueDate:'2026-04-20', startDateTime:null, endDateTime:null, location:null, completed:false, googleEventId:null, googleTaskId:null, notes:'לכלול מופע לחנוכה עם אופציה לסדנה', priority:'high', createdAt:'2026-04-01' },
      { id:'t2', title:'מופע נתניה — פורים', type:'event', contactId:'c3', organizationId:'org2', conversationId:null, dueDate:'2026-04-13', startDateTime:'2026-04-13T19:00:00', endDateTime:'2026-04-13T21:00:00', location:'אולם תרבות נתניה', completed:false, googleEventId:null, googleTaskId:null, notes:'לוודא ציוד סאונד מראש', priority:'high', createdAt:'2026-02-20' }
    ]);
  }
  // ── חתימות ──
  if (rj('signatures.json').length === 0) {
    const ui = rj('userinfo.json', {});
    const ownerName = ui.ownerName || '';
    const phone     = ui.phone     || '';
    wj('signatures.json', [
      { id:'sig1', name:'חתימה ראשית', text:`${ownerName}\nבברכה ❤️`, isDefault:true,  channel:'both', createdAt:today() },
      { id:'sig2', name:'חתימה רשמית', text:`${ownerName}${phone ? '\nטלפון: '+phone : ''}`, isDefault:false, channel:'both', createdAt:today() },
      { id:'sig3', name:'חתימה קצרה',   text:'ירון אנטניר\n052-5105100',                                                                     isDefault:false, channel:'both', createdAt:today() },
    ]);
  }
}
init();

// ─── Auth ─────────────────────────────────────────────────────────────────────
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
];

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/?auth=no-config');
  const url = oauth2Client.generateAuthUrl({ access_type:'offline', scope:SCOPES, prompt:'consent' });
  res.redirect(url);
});

app.get('/auth/google/add', requirePassword, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/?auth=no-config');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    prompt: 'consent',
    state: 'add-account',
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const isAddAccount = req.query.state === 'add-account';
    const { tokens } = await oauth2Client.getToken(req.query.code);

    if (isAddAccount) {
      // Save as extra Gmail account
      const tmpClient = makeGmailClient(tokens);
      const oauth2Api = google.oauth2({ version: 'v2', auth: tmpClient });
      const { data: uinfo } = await oauth2Api.userinfo.get();
      const extra = loadExtraAccounts();
      extra[uinfo.email] = { email: uinfo.email, name: uinfo.name || uinfo.email, tokens };
      saveExtraAccounts(extra);
      gmailCache.clear();
      return res.redirect('/?auth=account-added&email=' + encodeURIComponent(uinfo.email));
    }

    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    storeTokens(tokens);  // persist for background sync
    const oauth2 = google.oauth2({ version:'v2', auth:oauth2Client });
    const { data } = await oauth2.userinfo.get();
    req.session.userInfo = data;
    wj('userinfo.json', data);
    res.redirect('/?auth=success');
  } catch (e) {
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.message));
  }
});

app.get('/auth/status', (req, res) => {
  const ss = rj('sync-status.json', {});
  res.json({
    authenticated: !!req.session.tokens || !!loadStoredTokens(),
    user: req.session.userInfo || rj('userinfo.json', null),
    googleConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    lastSync: ss,
    autoSyncActive: !!(loadStoredTokens()),
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  // Remove persisted tokens
  const fp = path.join(DATA, 'tokens.json');
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const uf = path.join(DATA, 'userinfo.json');
  if (fs.existsSync(uf)) fs.unlinkSync(uf);
  res.json({ ok:true });
});

function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error:'לא מחובר לגוגל' });
  oauth2Client.setCredentials(req.session.tokens);
  next();
}

// ─── Background Sync Helpers ──────────────────────────────────────────────────

function buildPersonBody(item, isOrg, orgMap = {}) {
  return {
    names:          [{ givenName: item.name }],
    phoneNumbers:   item.phone ? [{ value: item.phone }] : [],
    emailAddresses: item.email ? [{ value: item.email }] : [],
    addresses:      item.city  ? [{ city: item.city, country:'Israel' }] : [],
    organizations:  isOrg
      ? [{ name: item.name, type:'work' }]
      : (item.organizationId && orgMap[item.organizationId]
          ? [{ name: orgMap[item.organizationId].name, title: item.role||'' }]
          : []),
    biographies: [{ value: `[CRM-ID: ${item.id}]\n${item.notes||''}`.trim() }],
  };
}

async function pushContactOrOrgToGoogle(item, isOrg) {
  const auth = bgAuth(); if (!auth) return;
  const ppl = google.people({ version:'v1', auth });
  const file = isOrg ? 'orgs.json' : 'contacts.json';
  const list = rj(file);
  const idx  = list.findIndex(i => i.id === item.id);
  if (idx === -1) return;
  const orgMap = Object.fromEntries(rj('orgs.json').map(o=>[o.id,o]));
  const body = buildPersonBody(item, isOrg, orgMap);

  try {
    if (item.googleContactId) {
      const { data:cur } = await ppl.people.get({ resourceName:item.googleContactId, personFields:'metadata' });
      await ppl.people.updateContact({
        resourceName: item.googleContactId,
        updatePersonFields: 'names,phoneNumbers,emailAddresses,addresses,organizations,biographies',
        requestBody: { ...body, etag: cur.etag },
      });
      console.log(`[Auto-sync] Updated Google Contact: ${item.name}`);
    } else {
      const { data } = await ppl.people.createContact({ requestBody: body });
      list[idx].googleContactId = data.resourceName;
      wj(file, list);
      console.log(`[Auto-sync] Created Google Contact: ${item.name}`);
    }
  } catch (e) {
    // Contact deleted in Google – recreate
    try {
      const { data } = await ppl.people.createContact({ requestBody: body });
      list[idx].googleContactId = data.resourceName;
      wj(file, list);
    } catch (e2) { console.error('[Auto-sync] Contact push error:', e2.message); }
  }
}

async function deleteContactFromGoogle(googleContactId) {
  const auth = bgAuth(); if (!auth || !googleContactId) return;
  try {
    const ppl = google.people({ version:'v1', auth });
    await ppl.people.deleteContact({ resourceName: googleContactId });
    console.log(`[Auto-sync] Deleted Google Contact: ${googleContactId}`);
  } catch (e) { console.error('[Auto-sync] Delete contact error:', e.message); }
}

async function pushTaskToGoogle(item) {
  const auth = bgAuth(); if (!auth) return;
  const tasks = rj('tasks.json');
  const idx   = tasks.findIndex(t => t.id === item.id);
  if (idx === -1) return;

  if (item.type === 'event') {
    const cal  = google.calendar({ version:'v3', auth });
    const body = {
      summary:     item.title,
      description: [item.notes||'', `[CRM-ID: ${item.id}]`].filter(Boolean).join('\n'),
      location:    item.location || '',
      start: item.startDateTime
        ? { dateTime: new Date(item.startDateTime).toISOString(), timeZone:'Asia/Jerusalem' }
        : { date: item.dueDate },
      end: item.endDateTime
        ? { dateTime: new Date(item.endDateTime).toISOString(), timeZone:'Asia/Jerusalem' }
        : { date: item.dueDate },
    };
    try {
      if (item.googleEventId) {
        await cal.events.update({ calendarId:'primary', eventId:item.googleEventId, requestBody:body });
        console.log(`[Auto-sync] Updated Calendar event: ${item.title}`);
      } else {
        const { data } = await cal.events.insert({ calendarId:'primary', requestBody:body });
        tasks[idx].googleEventId = data.id;
        wj('tasks.json', tasks);
        console.log(`[Auto-sync] Created Calendar event: ${item.title}`);
      }
    } catch (e) { console.error('[Auto-sync] Event push error:', e.message); }

  } else {
    const gtasks = google.tasks({ version:'v1', auth });
    const body = {
      title:  item.title,
      notes:  [item.notes||'', `[CRM-ID: ${item.id}]`].filter(Boolean).join('\n'),
      due:    item.dueDate ? new Date(item.dueDate + 'T00:00:00+02:00').toISOString() : undefined,
      status: item.completed ? 'completed' : 'needsAction',
    };
    try {
      if (item.googleTaskId) {
        await gtasks.tasks.update({ tasklist:'@default', task:item.googleTaskId, requestBody:body });
        console.log(`[Auto-sync] Updated Google Task: ${item.title}`);
      } else {
        const { data } = await gtasks.tasks.insert({ tasklist:'@default', requestBody:body });
        tasks[idx].googleTaskId = data.id;
        wj('tasks.json', tasks);
        console.log(`[Auto-sync] Created Google Task: ${item.title}`);
      }
    } catch (e) { console.error('[Auto-sync] Task push error:', e.message); }
  }
}

async function deleteEventFromGoogle(googleEventId) {
  const auth = bgAuth(); if (!auth || !googleEventId) return;
  try {
    const cal = google.calendar({ version:'v3', auth });
    await cal.events.delete({ calendarId:'primary', eventId:googleEventId });
    console.log(`[Auto-sync] Deleted Calendar event: ${googleEventId}`);
  } catch (e) { console.error('[Auto-sync] Delete event error:', e.message); }
}

async function deleteTaskFromGoogle(googleTaskId) {
  const auth = bgAuth(); if (!auth || !googleTaskId) return;
  try {
    const gtasks = google.tasks({ version:'v1', auth });
    await gtasks.tasks.delete({ tasklist:'@default', task:googleTaskId });
    console.log(`[Auto-sync] Deleted Google Task: ${googleTaskId}`);
  } catch (e) { console.error('[Auto-sync] Delete task error:', e.message); }
}

// ─── Background Pull (Google → CRM) ──────────────────────────────────────────
let lastPollTime = null;

async function pullFromGoogle() {
  const auth = bgAuth(); if (!auth) return { pulled:0 };
  let pulled = 0;
  const since = lastPollTime ? new Date(lastPollTime).toISOString() : null;

  try {
    // Pull Calendar events
    const cal     = google.calendar({ version:'v3', auth });
    let   items   = rj('tasks.json');
    const existGE = new Set(items.filter(i=>i.googleEventId).map(i=>i.googleEventId));
    const tMin    = since || new Date(Date.now() - 30*24*60*60*1000).toISOString();
    const { data:evData } = await cal.events.list({
      calendarId:'primary', timeMin:tMin, singleEvents:true, orderBy:'startTime', maxResults:200
    });
    for (const ev of evData.items || []) {
      if (existGE.has(ev.id)) continue;
      if ((ev.description||'').includes('[CRM-ID:')) continue;
      items.unshift({
        id:uid(), title:ev.summary||'אירוע', type:'event',
        contactId:null, organizationId:null, conversationId:null,
        dueDate:  ev.start?.date || ev.start?.dateTime?.split('T')[0] || today(),
        startDateTime: ev.start?.dateTime||null, endDateTime:ev.end?.dateTime||null,
        location: ev.location||null, completed: ev.status==='cancelled',
        googleEventId: ev.id, googleTaskId:null,
        notes: ev.description||'', priority:'normal',
        createdAt:today(), fromGoogle:true,
      });
      pulled++;
    }

    // Pull Google Tasks
    const gtasks  = google.tasks({ version:'v1', auth });
    const existGT = new Set(items.filter(i=>i.googleTaskId).map(i=>i.googleTaskId));
    const gtQuery = since ? { tasklist:'@default', maxResults:100, updatedMin:since } : { tasklist:'@default', maxResults:100 };
    const { data:gtData } = await gtasks.tasks.list(gtQuery);
    for (const gt of gtData.items || []) {
      if (existGT.has(gt.id)) continue;
      if ((gt.notes||'').includes('[CRM-ID:')) continue;
      items.unshift({
        id:uid(), title:gt.title||'משימה', type:'task',
        contactId:null, organizationId:null, conversationId:null,
        dueDate: gt.due ? gt.due.split('T')[0] : '',
        startDateTime:null, endDateTime:null, location:null,
        completed: gt.status==='completed',
        googleEventId:null, googleTaskId:gt.id,
        notes:gt.notes||'', priority:'normal',
        createdAt:today(), fromGoogle:true,
      });
      pulled++;
    }

    if (pulled > 0) { wj('tasks.json', items); console.log(`[Auto-sync] Pulled ${pulled} items from Google`); }
  } catch(e) { console.error('[Auto-sync] Pull error:', e.message); }

  // Pull new Google Contacts
  try {
    const ppl       = google.people({ version:'v1', auth });
    const conts     = rj('contacts.json');
    const existC    = new Set(conts.filter(c=>c.googleContactId).map(c=>c.googleContactId));
    const blocklist = new Set(rj('google-contacts-blocklist.json', []));
    let pageToken, newConts = 0;
    do {
      const { data } = await ppl.people.connections.list({
        resourceName:'people/me', pageSize:200, pageToken,
        personFields:'names,phoneNumbers,emailAddresses,addresses,organizations,biographies',
        ...(since ? { requestSyncToken:false } : {}),
      });
      for (const gp of data.connections||[]) {
        if (existC.has(gp.resourceName)) continue;
        if (blocklist.has(gp.resourceName)) continue; // נמחק מה-CRM — לא לייבא מחדש
        const bio = gp.biographies?.[0]?.value||'';
        if (bio.includes('[CRM-ID:')) continue;
        const gPhone = gp.phoneNumbers?.[0]?.value||'';
        const gEmail = gp.emailAddresses?.[0]?.value||'';
        // Skip contacts where phone field contains Hebrew letters (corrupted data from bad import)
        const phoneHasHebrew = /[\u0590-\u05ff]/.test(gPhone);
        if (phoneHasHebrew) { console.warn(`[Auto-sync] Skipped corrupted contact: ${gp.names?.[0]?.displayName} (phone="${gPhone}")`); continue; }
        conts.unshift({
          id:uid(), name:gp.names?.[0]?.displayName||'ללא שם',
          organizationId:null, role:gp.organizations?.[0]?.title||'',
          phone:gPhone, email:gEmail,
          city:gp.addresses?.[0]?.city||'', status:'lead', source:'Google Contacts',
          notes:bio, tags:[], conversations:[], showHistory:[], nextFollowUp:'',
          googleContactId:gp.resourceName, createdAt:today(), fromGoogle:true,
        });
        newConts++; pulled++;
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    if (newConts > 0) { wj('contacts.json', conts); console.log(`[Auto-sync] Pulled ${newConts} contacts from Google`); }
  } catch(e) { console.error('[Auto-sync] Pull contacts error:', e.message); }

  lastPollTime = new Date().toISOString();
  const ss = rj('sync-status.json', {});
  ss.lastAutoPull = lastPollTime;
  ss.autoSyncEnabled = true;
  if (pulled > 0) ss.lastPullCount = pulled;
  wj('sync-status.json', ss);

  return { pulled };
}

// ─── CRUD with auto-sync hooks ────────────────────────────────────────────────
function rjSafe(file) {
  // Like rj() but throws if file exists and is corrupt — NEVER returns [] for a non-empty file
  const fp = path.join(DATA, file);
  if (!fs.existsSync(fp)) return [];
  const raw = fs.readFileSync(fp, 'utf8');
  if (!raw.trim()) return [];
  return JSON.parse(raw); // let it throw on corruption — prevents data wipe
}

function crud(file, hooks = {}) {
  return {
    list: (req,res) => res.json(rj(file)),

    create: (req,res) => {
      try {
        const items = rjSafe(file);
        const item  = { id:uid(), createdAt:today(), ...req.body };
        items.unshift(item);
        wj(file, items);
        res.json(item);
        if (hooks.onSave) hooks.onSave(item).catch(e=>console.error('[Auto-sync]',e.message));
      } catch(e) {
        console.error(`[crud.create] ERROR reading ${file}:`, e.message);
        res.status(500).json({ error: `שגיאה בקריאת הקובץ: ${e.message}` });
      }
    },

    update: (req,res) => {
      try {
        const items = rjSafe(file);
        const idx   = items.findIndex(i => i.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error:'לא נמצא' });
        items[idx] = { ...items[idx], ...req.body, updatedAt:today() };
        wj(file, items);
        res.json(items[idx]);
        if (hooks.onSave) hooks.onSave(items[idx]).catch(e=>console.error('[Auto-sync]',e.message));
      } catch(e) {
        console.error(`[crud.update] ERROR reading ${file}:`, e.message);
        res.status(500).json({ error: `שגיאה בקריאת הקובץ: ${e.message}` });
      }
    },

    remove: (req,res) => {
      try {
        const items = rjSafe(file);
        const item  = items.find(i => i.id === req.params.id);
        wj(file, items.filter(i => i.id !== req.params.id));
        res.json({ ok:true });
        if (hooks.onDelete && item) hooks.onDelete(item).catch(e=>console.error('[Auto-sync]',e.message));
      } catch(e) {
        console.error(`[crud.remove] ERROR reading ${file}:`, e.message);
        res.status(500).json({ error: `שגיאה בקריאת הקובץ: ${e.message}` });
      }
    },
  };
}

const O = crud('orgs.json', {
  onSave:   item => pushContactOrOrgToGoogle(item, true),
  onDelete: item => item.googleContactId ? deleteContactFromGoogle(item.googleContactId) : Promise.resolve(),
});
function addToGoogleBlocklist(googleContactId) {
  if (!googleContactId) return;
  const list = rj('google-contacts-blocklist.json', []);
  if (!list.includes(googleContactId)) {
    list.push(googleContactId);
    wj('google-contacts-blocklist.json', list);
  }
}

const C = crud('contacts.json', {
  onSave:   item => pushContactOrOrgToGoogle(item, false),
  onDelete: item => { addToGoogleBlocklist(item.googleContactId); return Promise.resolve(); },
});
const T = crud('tasks.json', {
  onSave:   item => pushTaskToGoogle(item),
  onDelete: item => Promise.all([
    item.googleEventId ? deleteEventFromGoogle(item.googleEventId) : Promise.resolve(),
    item.googleTaskId  ? deleteTaskFromGoogle(item.googleTaskId)   : Promise.resolve(),
  ]),
});

app.get('/api/orgs',        O.list);
app.post('/api/orgs',       O.create);
app.put('/api/orgs/:id',    O.update);
app.delete('/api/orgs/:id', O.remove);

app.get('/api/contacts',        C.list);
app.post('/api/contacts',       C.create);
app.put('/api/contacts/:id',    C.update);
app.delete('/api/contacts/:id', C.remove);

// ── Bulk operations ──────────────────────────────────────────────────────────
app.post('/api/contacts/bulk-status', express.json(), requirePassword, (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !status) return res.status(400).json({ error: 'חסרים שדות' });
  const contacts = rj('contacts.json', []);
  let count = 0;
  contacts.forEach(c => { if (ids.includes(c.id)) { c.status = status; count++; } });
  wj('contacts.json', contacts);
  res.json({ ok: true, updated: count });
});

app.post('/api/contacts/bulk-delete', express.json(), requirePassword, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'חסרים שדות' });
  const contacts = rj('contacts.json', []);
  const remaining = contacts.filter(c => !ids.includes(c.id));
  wj('contacts.json', remaining);
  res.json({ ok: true, deleted: contacts.length - remaining.length });
});

// ── Gmail: מיילים עם איש קשר (כל החשבונות) ──────────────────────────────────
const gmailCache = new Map(); // cache: contactEmail → { ts, data }

// ── Gmail: מיילים אחרונים (לכל החשבונות, ללא סינון לפי איש קשר) ─────────────
app.get('/api/emails/recent', requirePassword, async (req, res) => {
  try {
    const primaryTokens = loadStoredTokens();
    if (!primaryTokens) return res.json({ emails: [], noAuth: true });

    const accountList = [];
    const primaryInfo = rj('userinfo.json', null);
    accountList.push({ email: primaryInfo?.email || '', client: makeGmailClient(primaryTokens) });
    const extra = loadExtraAccounts();
    for (const [email, info] of Object.entries(extra)) {
      accountList.push({ email, client: makeGmailClient(info.tokens) });
    }

    const allEmails = [];
    await Promise.all(accountList.map(async ({ email: acct, client }) => {
      try {
        const gmail = google.gmail({ version: 'v1', auth: client });
        const listRes = await gmail.users.messages.list({ userId: 'me', maxResults: 15 });
        const msgs = listRes.data.messages || [];
        const fetched = await Promise.all(msgs.map(async m => {
          try {
            const msg = await gmail.users.messages.get({
              userId: 'me', id: m.id, format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            const hdrs = msg.data.payload.headers || [];
            const h = n => hdrs.find(x => x.name === n)?.value || '';
            const from = h('From');
            const isOut = acct && from.toLowerCase().includes(acct.toLowerCase());
            return {
              id: m.id,
              subject: h('Subject') || '(ללא נושא)',
              from, to: h('To'),
              date: h('Date'),
              snippet: msg.data.snippet || '',
              direction: isOut ? 'out' : 'in',
              account: acct,
            };
          } catch { return null; }
        }));
        allEmails.push(...fetched.filter(Boolean));
      } catch (e) { console.error(`[Gmail recent] ${acct}:`, e.message); }
    }));

    const seen = new Set();
    const unique = allEmails
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 20);

    res.json({ emails: unique });
  } catch (e) {
    console.error('[Gmail recent]', e.message);
    res.json({ emails: [], error: e.message });
  }
});

app.get('/api/auth/accounts', requirePassword, (req, res) => {
  const primary = rj('userinfo.json', null);
  const extra   = loadExtraAccounts();
  const accounts = [];
  if (primary?.email) accounts.push({ email: primary.email, name: primary.name || primary.email, isPrimary: true });
  Object.entries(extra).forEach(([email, info]) => accounts.push({ email, name: info.name || email, isPrimary: false }));
  res.json({ accounts });
});

app.delete('/api/auth/accounts/:email', requirePassword, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const extra = loadExtraAccounts();
  if (!extra[email]) return res.status(404).json({ error: 'חשבון לא נמצא' });
  delete extra[email];
  saveExtraAccounts(extra);
  gmailCache.clear();
  res.json({ ok: true });
});

app.get('/api/contacts/:id/emails', requirePassword, async (req, res) => {
  try {
    const contacts = rj('contacts.json', []);
    const contact  = contacts.find(c => c.id === req.params.id);
    if (!contact?.email) return res.json({ emails: [] });

    const cacheKey = contact.email.toLowerCase();
    const cached   = gmailCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 3 * 60 * 1000) return res.json(cached.data);

    const primaryTokens = loadStoredTokens();
    if (!primaryTokens) return res.json({ emails: [], noAuth: true });

    const q = `from:${contact.email} OR to:${contact.email}`;

    // Build list of accounts to search
    const accountList = [];
    const primaryInfo = rj('userinfo.json', null);
    accountList.push({ email: primaryInfo?.email || '', client: makeGmailClient(primaryTokens) });
    const extra = loadExtraAccounts();
    for (const [email, info] of Object.entries(extra)) {
      accountList.push({ email, client: makeGmailClient(info.tokens) });
    }

    // Fetch from all accounts in parallel
    const allEmails = [];
    await Promise.all(accountList.map(async ({ email: acct, client }) => {
      try {
        const gmail = google.gmail({ version: 'v1', auth: client });
        const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
        const msgs = listRes.data.messages || [];
        const fetched = await Promise.all(msgs.map(async m => {
          try {
            const msg = await gmail.users.messages.get({
              userId: 'me', id: m.id, format: 'metadata',
              metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
            });
            const hdrs = msg.data.payload.headers || [];
            const h    = n => hdrs.find(x => x.name === n)?.value || '';
            const from = h('From');
            const isOut = acct && from.toLowerCase().includes(acct.toLowerCase());
            return {
              id: m.id,
              subject:   h('Subject') || '(ללא נושא)',
              from,
              to:        h('To'),
              date:      h('Date'),
              snippet:   msg.data.snippet || '',
              direction: isOut ? 'out' : 'in',
              account:   acct,
            };
          } catch { return null; }
        }));
        allEmails.push(...fetched.filter(Boolean));
      } catch (e) {
        console.error(`[Gmail] ${acct}:`, e.message);
      }
    }));

    // Deduplicate by message id, sort newest first
    const seen = new Set();
    const unique = allEmails
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const result = { emails: unique };
    gmailCache.set(cacheKey, { ts: Date.now(), data: result });
    res.json(result);
  } catch(e) {
    console.error('[Gmail]', e.message);
    res.json({ emails: [], error: e.message });
  }
});

app.get('/api/tasks',        T.list);
app.post('/api/tasks',       T.create);
app.put('/api/tasks/:id',    T.update);
app.delete('/api/tasks/:id', T.remove);

// ─── Standalone Shows (not linked to contact/org) ─────────────────────────────
const S = crud('standalone-shows.json', {});
app.get('/api/shows',        S.list);
app.post('/api/shows',       S.create);
app.put('/api/shows/:id',    S.update);
app.delete('/api/shows/:id', S.remove);

// ─── Signatures ───────────────────────────────────────────────────────────────
const SIG = crud('signatures.json', {});
app.get('/api/signatures',        SIG.list);
app.post('/api/signatures',       SIG.create);
app.put('/api/signatures/:id',    SIG.update);
app.delete('/api/signatures/:id', SIG.remove);

// Set as default signature
app.put('/api/signatures/:id/set-default', requirePassword, (req, res) => {
  const sigs = rj('signatures.json', []);
  sigs.forEach(s => { s.isDefault = (s.id === req.params.id); });
  wj('signatures.json', sigs);
  res.json({ ok: true });
});

// ─── Quotes ───────────────────────────────────────────────────────────────────
const QUOTES_DIR = path.join(DATA, 'quotes-html');
if (!fs.existsSync(QUOTES_DIR)) fs.mkdirSync(QUOTES_DIR, { recursive: true });

function buildQuoteHtml(data) {
  const logoPath = path.join(__dirname, 'logo.png');
  let logoSrc = '';
  try { logoSrc = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64'); } catch {}

  const fmt = v => { try { return Number(v).toLocaleString('he-IL') + ' ש"ח'; } catch { return String(v); } };
  const shows  = data.shows || [];
  const travel = parseFloat(data.travelCost || 0);
  const showsTotal = shows.reduce((s, sh) => s + (parseFloat(sh.price) || 0), 0);
  // נסיעות תמיד ללא מע"מ — המע"מ חל רק על שכר המופעים
  const vat        = data.includeVat ? Math.round(showsTotal * 0.18) : 0;
  const grandTotal = showsTotal + travel + vat;

  const showRows = shows.map(s => {
    const loc = s.locationKnown === true
      ? [s.locationName, s.locationAddress].filter(Boolean).join(', ')
      : (s.locationKnown === false ? 'מיקום עדיין לא נסגר' : '');
    const locStyle = loc === 'מיקום עדיין לא נסגר' ? 'color:#94a3b8;font-style:italic' : '';
    const dateStr = s.eventDate || '';
    const timeStr = (s.eventTime && dateStr && !dateStr.includes('לא נסגר')) ? ' ' + s.eventTime : '';
    const dateStyle = dateStr.includes('לא נסגר') ? 'color:#94a3b8;font-style:italic' : '';
    const descRow = s.description ? `<tr><td colspan="5" style="padding:2px 10px 7px;font-size:11px;color:#64748b;font-style:italic;border-bottom:1px solid #e2e8f0">${s.description}</td></tr>` : '';
    return `<tr>
      <td style="font-weight:600;color:#2d4a7a">${s.showName||''}</td>
      <td style="${dateStyle}">${dateStr}${timeStr}</td>
      <td style="${locStyle}">${loc}</td>
      <td style="text-align:center">${s.participants||'—'}</td>
      <td style="text-align:right;font-weight:600">${fmt(s.price||0)}</td>
    </tr>${descRow}`;
  }).join('');

  const vatRow    = data.includeVat ? `<tr><td>מע"מ (18%) על שכר הופעות</td><td class="amt">${fmt(vat)}</td></tr>` : '';
  const travelRow = travel > 0    ? `<tr><td>עלויות נסיעה <span style="font-size:10px;color:#64748b;font-weight:400">(ללא מע"מ)</span></td><td class="amt">${fmt(travel)}</td></tr>` : '';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><title>הצעת מחיר ${data.quoteNumber||''}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#1e293b;font-size:13px;line-height:1.5;background:white}
.page{max-width:210mm;margin:0 auto;padding:0;display:flex;flex-direction:column;min-height:297mm}
.hdr{background:linear-gradient(135deg,#2d4a7a,#1e3a6e);color:white;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.hdr .title{font-size:26px;font-weight:800}.hdr .sub{font-size:11px;opacity:.8;margin-top:3px}
.hdr-logo{max-height:65px;max-width:170px;background:white;border-radius:6px;padding:4px 7px}
.body{padding:18px 24px;flex:1}
.igrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:15px}
.ibox{background:#f8fafc;border-radius:8px;padding:11px 13px;border:1px solid #e2e8f0}
.ibox .lbl2{font-size:9.5px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.ibox .nm{font-size:14px;font-weight:700;color:#2d4a7a;margin-bottom:2px}
.ibox .sb{font-size:11.5px;color:#475569;line-height:1.7}
.stitle{font-size:13px;font-weight:700;color:#2d4a7a;border-right:4px solid #2d4a7a;padding-right:7px;margin:13px 0 8px}
.purpose-box{background:#f0f4fa;border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:12.5px;color:#334155;border-right:3px solid #2d4a7a}
.shows-tbl{width:100%;border-collapse:collapse;margin:7px 0;font-size:12px}
.shows-tbl thead tr{background:#2d4a7a;color:white}
.shows-tbl thead td{padding:8px 10px;font-weight:600;font-size:11.5px}
.shows-tbl tbody tr:nth-child(even){background:#f8fafc}
.shows-tbl tbody td{padding:7px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}
.ptbl{width:100%;border-collapse:collapse;margin:7px 0;font-size:13px}
.ptbl thead tr{background:#2d4a7a;color:white}
.ptbl thead td{padding:8px 12px;font-weight:600}
.ptbl tbody tr:nth-child(even){background:#f0f4fa}
.ptbl tbody td{padding:7px 12px;border-bottom:1px solid #e2e8f0}
.ptbl tfoot tr{background:#2d4a7a;color:white}
.ptbl tfoot td{padding:10px 12px;font-weight:700;font-size:14px}
.amt{text-align:right;font-weight:500;white-space:nowrap}
.pay-box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:7px;padding:9px 13px;margin:10px 0;font-size:12px;color:#1e40af}
.pay-box strong{display:block;margin-bottom:2px;font-size:12.5px}
.valid{font-size:12px;color:#92400e;background:#fef3c7;border-radius:5px;padding:5px 9px;margin:8px 0;display:inline-block}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0}
.sigb{text-align:center}.sigline{border-bottom:1.5px solid #94a3b8;margin-bottom:6px;height:34px}
.siglbl{font-size:10px;color:#64748b}.signm{font-size:12px;font-weight:700;color:#2d4a7a;margin-top:1px}
.ftr{background:#2d4a7a;color:rgba(255,255,255,.85);text-align:center;padding:8px;font-size:11px;margin-top:auto}
.print-btn{position:fixed;top:12px;left:12px;background:#4f46e5;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;z-index:999;font-family:inherit}
@media print{.print-btn{display:none}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head>
<body>
<button class="print-btn" onclick="window.print()">🖨️ הדפס / שמור PDF</button>
<div class="page">
<div class="hdr">
  <div><div class="title">הצעת מחיר</div><div class="sub">מס׳ ${data.quoteNumber||'001'} &nbsp;|&nbsp; ${data.quoteDate||''}</div></div>
  ${logoSrc ? `<img class="hdr-logo" src="${logoSrc}">` : ''}
</div>
<div class="body">
  <div class="igrid">
    <div class="ibox">
      <div class="lbl2">לכבוד</div>
      <div class="nm">${data.contactName||''}</div>
      <div class="sb">${data.organization||''}${data.contactPhone?'<br>'+data.contactPhone:''}${data.contactEmail?'<br>'+data.contactEmail:''}</div>
    </div>
    <div class="ibox">
      <div class="lbl2">מאת</div>
      <div class="nm">ירון אנטניר</div>
      <div class="sb">שקוף בחזית | סיפורים מהבמה ומהלב<br>050-8581935 | yaron@shakufbahazit.co.il<br>www.shakufbahazit.co.il</div>
    </div>
  </div>
  <div class="stitle">פירוט מופעים</div>
  <table class="shows-tbl">
    <thead><tr><td>מופע</td><td>תאריך ושעה</td><td>מיקום</td><td style="text-align:center">משתתפים</td><td style="text-align:right">מחיר</td></tr></thead>
    <tbody>${showRows}</tbody>
  </table>
  <div class="stitle">תמחור</div>
  <table class="ptbl">
    <thead><tr><td>פירוט</td><td class="amt">סכום</td></tr></thead>
    <tbody>
      <tr><td>סה"כ שכר הופעות</td><td class="amt">${fmt(showsTotal)}</td></tr>
      ${travelRow}${vatRow}
    </tbody>
    <tfoot><tr><td>סה"כ לתשלום</td><td class="amt">${fmt(grandTotal)}</td></tr></tfoot>
  </table>
  ${data.paymentTerms ? `<div class="pay-box"><strong>תנאי תשלום</strong>${data.paymentTerms}</div>` : ''}
  ${data.notes ? `<div class="stitle">הערות</div><p style="font-size:12px;color:#475569;margin-bottom:8px">${data.notes.replace(/\n/g,'<br>')}</p>` : ''}
  ${data.validUntil ? `<div class="valid">הצעה זו בתוקף עד: <strong>${data.validUntil}</strong></div>` : ''}
</div>
<div class="ftr">שקוף בחזית &nbsp;|&nbsp; ירון אנטניר &nbsp;|&nbsp; 050-8581935 &nbsp;|&nbsp; www.shakufbahazit.co.il</div>
</div>
</body></html>`;
}

app.get('/api/quotes', (req, res) => res.json(rj('quotes.json', [])));

app.post('/api/quotes/generate', requirePassword, (req, res) => {
  try {
    const quotes = rj('quotes.json', []);
    const now = new Date();
    // Format: ddmmyy-N  (e.g. 210426-3)
    const dd = String(now.getDate()).padStart(2,'0');
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const seqNum = quotes.length + 1;
    const quoteNumber = `${dd}${mm}${yy}${seqNum}`;
    const heDate = now.toLocaleDateString('he-IL', { year:'numeric', month:'long', day:'numeric' });
    const data = { ...req.body, quoteNumber, quoteDate: heDate };

    const id = uid();
    const fileName = `quote_${id}.html`;
    const filePath = path.join(QUOTES_DIR, fileName);
    const html = buildQuoteHtml(data);
    fs.writeFileSync(filePath, html, 'utf8');

    const shows    = data.shows || [];
    const travel   = parseFloat(data.travelCost || 0);
    const showsTotal = shows.reduce((s, sh) => s + (parseFloat(sh.price) || 0), 0);
    const vat        = data.includeVat ? Math.round(showsTotal * 0.18) : 0;
    const grandTotal = showsTotal + travel + vat;

    const quote = {
      id, quoteNumber, quoteDate: heDate, fileName,
      contactId: data.contactId || null,
      contactName: data.contactName || '',
      showName: (shows[0] && shows[0].showName) || '',
      price: showsTotal,
      total: grandTotal,
      status: 'draft',
      createdAt: now.toISOString(),
      rawForm: req.body._rawForm || null,
    };
    quotes.push(quote);
    wj('quotes.json', quotes);
    res.json({ ok: true, id, quoteNumber });
  } catch(e) {
    console.error('[Quote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quotes/:id/view', (req, res) => {
  const quotes = rj('quotes.json', []);
  const q = quotes.find(x => x.id === req.params.id);
  if (!q) return res.status(404).send('לא נמצא');
  const filePath = path.join(QUOTES_DIR, q.fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('קובץ לא נמצא');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(filePath).pipe(res);
});

// Update existing quote (regenerate HTML)
app.put('/api/quotes/:id', requirePassword, (req, res) => {
  try {
    const quotes = rj('quotes.json', []);
    const idx = quotes.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
    const existing = quotes[idx];
    const data = { ...req.body, quoteNumber: existing.quoteNumber, quoteDate: existing.quoteDate };

    // Regenerate HTML
    const html = buildQuoteHtml(data);
    const filePath = path.join(QUOTES_DIR, existing.fileName);
    fs.writeFileSync(filePath, html, 'utf8');

    const shows = data.shows || [];
    const travel = parseFloat(data.travelCost || 0);
    const showsTotal = shows.reduce((s, sh) => s + (parseFloat(sh.price) || 0), 0);
    const vat = data.includeVat ? Math.round(showsTotal * 0.18) : 0;
    const grandTotal = showsTotal + travel + vat;

    quotes[idx] = {
      ...existing,
      contactId:   data.contactId   || existing.contactId,
      contactName: data.contactName || existing.contactName,
      showName:    (shows[0] && shows[0].showName) || existing.showName,
      price:       showsTotal,
      total:       grandTotal,
      updatedAt:   new Date().toISOString(),
      rawForm:     req.body._rawForm || existing.rawForm || null,
    };
    wj('quotes.json', quotes);
    res.json({ ok: true });
  } catch(e) {
    console.error('[Quote Update]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/quotes/:id/status', requirePassword, (req, res) => {
  const quotes = rj('quotes.json', []);
  const q = quotes.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'לא נמצא' });
  q.status = req.body.status;
  wj('quotes.json', quotes);
  res.json({ ok: true });
});

app.delete('/api/quotes/:id', requirePassword, (req, res) => {
  let quotes = rj('quotes.json', []);
  const q = quotes.find(x => x.id === req.params.id);
  if (q) {
    const fp = path.join(QUOTES_DIR, q.fileName);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
  }
  quotes = quotes.filter(x => x.id !== req.params.id);
  wj('quotes.json', quotes);
  res.json({ ok: true });
});

// ─── WordPress Integration ────────────────────────────────────────────────────
const WP_URL     = (process.env.WP_URL || '').replace(/\/$/, '');
const WP_API_KEY = process.env.WP_API_KEY || '';
const ORDERS_DIR = path.join(__dirname, 'orders-html');
if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR, { recursive: true });

// Israeli public holidays (includes first/last days of חג)
const IL_HOLIDAYS = new Set([
  // 2025
  '2025-03-13','2025-03-14','2025-04-12','2025-04-13','2025-04-18','2025-04-19',
  '2025-04-30','2025-05-01','2025-06-01','2025-06-02',
  '2025-09-22','2025-09-23','2025-10-01','2025-10-02',
  '2025-10-06','2025-10-07','2025-10-13','2025-10-14',
  // 2026
  '2026-03-03','2026-03-04','2026-04-01','2026-04-02','2026-04-07','2026-04-08',
  '2026-04-22','2026-04-23','2026-05-21','2026-05-22',
  '2026-09-11','2026-09-12','2026-09-20','2026-09-21',
  '2026-09-25','2026-09-26','2026-10-02','2026-10-03',
  // 2027
  '2027-03-23','2027-03-24','2027-04-21','2027-04-22','2027-04-27','2027-04-28',
  '2027-05-11','2027-05-12','2027-06-10','2027-06-11',
  '2027-10-01','2027-10-02','2027-10-10','2027-10-11',
  '2027-10-15','2027-10-16','2027-10-22','2027-10-23',
]);

// Next business day (Sun–Thu) skipping Fri/Sat/Holidays
function nextBusinessDay(fromDate, hoursAhead = 24) {
  const d = new Date(fromDate.getTime() + hoursAhead * 60 * 60 * 1000);
  const toIso = dt => dt.toISOString().split('T')[0];
  // Advance until it's not Fri(5), Sat(6), or holiday
  while (true) {
    const day = d.getDay(); // 0=Sun ... 6=Sat
    if (day !== 5 && day !== 6 && !IL_HOLIDAYS.has(toIso(d))) break;
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0); // morning of the advanced day
  }
  return d;
}

function wpFetch(endpoint, method = 'GET', body = null) {
  if (!WP_URL) return Promise.reject(new Error('WP_URL לא מוגדר ב-.env'));
  return new Promise((resolve, reject) => {
    const fullUrl = `${WP_URL}/wp-json/shb-crm/v1${endpoint}`;
    const parsed  = new URL(fullUrl);
    const lib     = parsed.protocol === 'https:' ? require('https') : require('http');
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type':  'application/json',
        'X-CRM-Key':     WP_API_KEY,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`WP ${res.statusCode}: ${data.slice(0,200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('WP timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Publish quote to WordPress
app.post('/api/quotes/:id/publish', requirePassword, async (req, res) => {
  try {
    const quotes = rj('quotes.json', []);
    const q = quotes.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'לא נמצא' });
    const filePath = path.join(QUOTES_DIR, q.fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'קובץ HTML לא נמצא' });
    const html = fs.readFileSync(filePath, 'utf8');
    const result = await wpFetch('/offers', 'POST', {
      id: q.quoteNumber,
      html,
      contact_id:   q.contactId   || '',
      contact_name: q.contactName || '',
    });
    q.wpUrl = result.url;
    q.wpPublished = true;
    wj('quotes.json', quotes);
    res.json({ ok: true, url: result.url });
  } catch(e) {
    console.error('[WP Publish Quote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Test WordPress connection
app.get('/api/wp/ping', requirePassword, async (req, res) => {
  try {
    const r = await wpFetch('/ping');
    res.json({ ok: true, wp: r });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual poll trigger + diagnostics
app.post('/api/wp/poll-now', requirePassword, async (req, res) => {
  try {
    const { events } = await wpFetch('/events');
    if (!events || events.length === 0) {
      return res.json({ ok: true, message: 'אין אירועים ממתינים ב-WordPress', events: [] });
    }
    // Run poll
    await pollWpEvents();
    res.json({ ok: true, message: `נמצאו ועובדו ${events.length} אירועים`, events });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Send test WhatsApp to self
app.post('/api/wp/test-wa', requirePassword, async (req, res) => {
  try {
    const phone = process.env.NOTIFY_PHONE || '972525105100';
    await sendWaMessage(phone, '✅ הודעת בדיקה מה-CRM — WhatsApp עובד!');
    res.json({ ok: true, message: `הודעת בדיקה נשלחה ל-${phone}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Projects ────────────────────────────────────────────────────────────────
app.get('/api/projects', requirePassword, (req, res) => res.json(rj('projects.json', [])));

app.post('/api/projects', requirePassword, (req, res) => {
  const projects = rj('projects.json', []);
  const project = {
    id: uid(), createdAt: new Date().toISOString(),
    name: req.body.name || 'פרויקט חדש',
    description: req.body.description || '',
    type: req.body.type || 'other',
    status: req.body.status || 'active',
    parentProjectId: req.body.parentProjectId || null,
    contactId: req.body.contactId || null,
    orgId: req.body.orgId || null,
    startDate: req.body.startDate || '',
    dueDate: req.body.dueDate || '',
    budget: req.body.budget || 0,
    notes: req.body.notes || '',
    products: [],
  };
  projects.unshift(project);
  wj('projects.json', projects);
  res.json(project);
});

app.put('/api/projects/:id', requirePassword, (req, res) => {
  const projects = rj('projects.json', []);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  projects[idx] = { ...projects[idx], ...req.body, id: projects[idx].id, createdAt: projects[idx].createdAt };
  wj('projects.json', projects);
  res.json(projects[idx]);
});

app.delete('/api/projects/:id', requirePassword, (req, res) => {
  const projects = rj('projects.json', []);
  // Also delete sub-projects
  const toDelete = new Set([req.params.id]);
  projects.filter(p => p.parentProjectId === req.params.id).forEach(p => toDelete.add(p.id));
  wj('projects.json', projects.filter(p => !toDelete.has(p.id)));
  // Remove projectId from tasks
  const tasks = rj('tasks.json', []);
  let changed = false;
  tasks.forEach(t => { if (toDelete.has(t.projectId)) { t.projectId = null; changed = true; } });
  if (changed) wj('tasks.json', tasks);
  res.json({ ok: true });
});

// ─── Pipeline ────────────────────────────────────────────────────────────────
const PIPELINE_STAGES = ['lead','call','quote','followup','negotiation','interested','closed'];

app.get('/api/pipeline', requirePassword, (req, res) => {
  res.json(rj('pipeline.json', []));
});

app.post('/api/pipeline', requirePassword, (req, res) => {
  const cards = rj('pipeline.json', []);
  const card = {
    id:          uid(),
    stage:       req.body.stage || 'lead',
    contactId:   req.body.contactId || null,
    orgId:       req.body.orgId    || null,
    quoteId:     req.body.quoteId  || null,
    showName:    req.body.showName || '',
    value:       req.body.value    || 0,
    notes:       req.body.notes    || '',
    createdAt:   new Date().toISOString(),
    closedAt:    null,
    closedReason: null,
  };
  cards.unshift(card);
  wj('pipeline.json', cards);
  res.json(card);
});

app.put('/api/pipeline/:id', requirePassword, (req, res) => {
  const cards = rj('pipeline.json', []);
  const idx = cards.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const updated = { ...cards[idx], ...req.body, id: cards[idx].id };
  // auto-set closedAt when moving to closed
  if (req.body.stage === 'closed' && !cards[idx].closedAt) {
    updated.closedAt = new Date().toISOString();
  }
  cards[idx] = updated;
  wj('pipeline.json', cards);
  res.json(updated);
});

app.delete('/api/pipeline/:id', requirePassword, (req, res) => {
  const cards = rj('pipeline.json', []);
  wj('pipeline.json', cards.filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// Convert pipeline card to show — returns new show id
app.post('/api/pipeline/:id/convert', requirePassword, async (req, res) => {
  try {
    const cards = rj('pipeline.json', []);
    const card  = cards.find(c => c.id === req.params.id);
    if (!card) return res.status(404).json({ error: 'not found' });

    // Mark card as won + closed
    card.stage       = 'closed';
    card.closedReason = 'won';
    card.closedAt    = new Date().toISOString();
    wj('pipeline.json', cards);

    // Create the show from provided data
    const showData = { id: uid(), createdAt: new Date().toISOString(), ...req.body };
    // Attach to contact's showHistory if contactId present
    if (card.contactId) {
      const contacts = rj('contacts.json', []);
      const ci = contacts.findIndex(c => c.id === card.contactId);
      if (ci !== -1) {
        contacts[ci].showHistory = contacts[ci].showHistory || [];
        contacts[ci].showHistory.unshift(showData);
        wj('contacts.json', contacts);
      }
    }
    res.json({ ok: true, showId: showData.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Orders ──────────────────────────────────────────────────────────────────
function buildOrderHtml(data) {
  const logoPath = path.join(__dirname, 'logo.png');
  let logoSrc = '';
  try { logoSrc = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64'); } catch {}

  const fmt = v => { try { return Number(v).toLocaleString('he-IL') + ' ש"ח'; } catch { return String(v); } };
  const shows  = data.shows || [];
  const travel = parseFloat(data.travelCost || 0);
  const showsTotal = shows.reduce((s, sh) => s + (parseFloat(sh.price) || 0), 0);
  const vat        = data.includeVat ? Math.round(showsTotal * 0.18) : 0;
  const grandTotal = showsTotal + travel + vat;

  const showRows = shows.map(s => {
    const loc = s.locationKnown === true
      ? [s.locationName, s.locationAddress].filter(Boolean).join(', ')
      : (s.locationKnown === false ? 'מיקום עדיין לא נסגר' : '');
    const locStyle = loc === 'מיקום עדיין לא נסגר' ? 'color:#94a3b8;font-style:italic' : '';
    const dateStr  = s.eventDate || '';
    const timeStr  = (s.eventTime && dateStr && !dateStr.includes('לא נסגר')) ? ' ' + s.eventTime : '';
    const dateStyle = dateStr.includes('לא נסגר') ? 'color:#94a3b8;font-style:italic' : '';
    const descRow  = s.description ? `<tr><td colspan="5" style="padding:2px 10px 7px;font-size:11px;color:#64748b;font-style:italic">${s.description}</td></tr>` : '';
    return `<tr>
      <td style="font-weight:600;color:#1a5c3a">${s.showName||''}</td>
      <td style="${dateStyle}">${dateStr}${timeStr}</td>
      <td style="${locStyle}">${loc}</td>
      <td style="text-align:center">${s.participants||'—'}</td>
      <td style="text-align:right;font-weight:600">${fmt(s.price||0)}</td>
    </tr>${descRow}`;
  }).join('');

  const vatRow    = data.includeVat ? `<tr><td>מע"מ (18%) על שכר הופעות</td><td class="amt">${fmt(vat)}</td></tr>` : '';
  const travelRow = travel > 0 ? `<tr><td>עלויות נסיעה <span style="font-size:10px;color:#64748b">(ללא מע"מ)</span></td><td class="amt">${fmt(travel)}</td></tr>` : '';

  // Signature placeholder — WordPress plugin injects the canvas here
  const sigSection = data.signedAt
    ? `<div style="margin-top:18px;padding:12px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534">
        ✅ <strong>הזמנה נחתמה דיגיטלית ב: ${data.signedAt}</strong>
       </div>`
    : `<div id="shb-sig-target"></div>`;

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><title>הזמנה ${data.orderNumber||''}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#1e293b;font-size:13px;line-height:1.5;background:white}
.page{max-width:210mm;margin:0 auto;padding:0;display:flex;flex-direction:column;min-height:297mm}
.hdr{background:linear-gradient(135deg,#1a5c3a,#14532d);color:white;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.hdr .title{font-size:26px;font-weight:800}.hdr .sub{font-size:11px;opacity:.8;margin-top:3px}
.hdr-logo{max-height:65px;max-width:170px;background:white;border-radius:6px;padding:4px 7px}
.body{padding:18px 24px;flex:1}
.igrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:15px}
.ibox{background:#f8fafc;border-radius:8px;padding:11px 13px;border:1px solid #e2e8f0}
.ibox .lbl2{font-size:9.5px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.ibox .nm{font-size:14px;font-weight:700;color:#1a5c3a;margin-bottom:2px}
.ibox .sb{font-size:11.5px;color:#475569;line-height:1.7}
.ref-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:7px;padding:8px 13px;margin-bottom:12px;font-size:12px;color:#166534}
.stitle{font-size:13px;font-weight:700;color:#1a5c3a;border-right:4px solid #1a5c3a;padding-right:7px;margin:13px 0 8px}
.shows-tbl{width:100%;border-collapse:collapse;margin:7px 0;font-size:12px}
.shows-tbl thead tr{background:#1a5c3a;color:white}
.shows-tbl thead td{padding:8px 10px;font-weight:600;font-size:11.5px}
.shows-tbl tbody tr:nth-child(even){background:#f0fdf4}
.shows-tbl tbody td{padding:7px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}
.ptbl{width:100%;border-collapse:collapse;margin:7px 0;font-size:13px}
.ptbl thead tr{background:#1a5c3a;color:white}
.ptbl thead td{padding:8px 12px;font-weight:600}
.ptbl tbody tr:nth-child(even){background:#f0fdf4}
.ptbl tbody td{padding:7px 12px;border-bottom:1px solid #e2e8f0}
.ptbl tfoot tr{background:#1a5c3a;color:white}
.ptbl tfoot td{padding:10px 12px;font-weight:700;font-size:14px}
.amt{text-align:right;font-weight:500;white-space:nowrap}
.pay-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:7px;padding:9px 13px;margin:10px 0;font-size:12px;color:#166534}
.pay-box strong{display:block;margin-bottom:2px}
#shb-sig-target{padding:0 24px 16px}
.ftr{background:#1a5c3a;color:rgba(255,255,255,.85);text-align:center;padding:8px;font-size:11px;margin-top:auto}
.print-btn{position:fixed;top:12px;left:12px;background:#166534;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;z-index:999;font-family:inherit}
@media print{.print-btn{display:none}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head>
<body>
<button class="print-btn" onclick="window.print()">🖨️ הדפס</button>
<div class="page">
<div class="hdr">
  <div>
    <div class="title">הזמנה</div>
    <div class="sub">מס׳ ${data.orderNumber||''} &nbsp;|&nbsp; ${data.orderDate||''}</div>
  </div>
  ${logoSrc ? `<img class="hdr-logo" src="${logoSrc}">` : ''}
</div>
<div class="body">
  ${data.quoteNumber ? `<div class="ref-box">📄 מבוסס על הצעת מחיר מס׳ <strong>${data.quoteNumber}</strong></div>` : ''}
  <div class="igrid">
    <div class="ibox">
      <div class="lbl2">לכבוד</div>
      <div class="nm">${data.contactName||''}</div>
      <div class="sb">${data.organization||''}${data.contactPhone?'<br>'+data.contactPhone:''}${data.contactEmail?'<br>'+data.contactEmail:''}</div>
    </div>
    <div class="ibox">
      <div class="lbl2">מאת</div>
      <div class="nm">ירון אנטניר</div>
      <div class="sb">שקוף בחזית | סיפורים מהבמה ומהלב<br>050-8581935 | yaron@shakufbahazit.co.il<br>www.shakufbahazit.co.il</div>
    </div>
  </div>
  <div class="stitle">פירוט מופעים</div>
  <table class="shows-tbl">
    <thead><tr><td>מופע</td><td>תאריך ושעה</td><td>מיקום</td><td style="text-align:center">משתתפים</td><td style="text-align:right">מחיר</td></tr></thead>
    <tbody>${showRows}</tbody>
  </table>
  <div class="stitle">תמחור</div>
  <table class="ptbl">
    <thead><tr><td>פירוט</td><td class="amt">סכום</td></tr></thead>
    <tbody>
      <tr><td>סה"כ שכר הופעות</td><td class="amt">${fmt(showsTotal)}</td></tr>
      ${travelRow}${vatRow}
    </tbody>
    <tfoot><tr><td>סה"כ לתשלום</td><td class="amt">${fmt(grandTotal)}</td></tr></tfoot>
  </table>
  ${data.paymentTerms ? `<div class="pay-box"><strong>תנאי תשלום</strong>${data.paymentTerms}</div>` : ''}
  ${data.notes ? `<div class="stitle">הערות</div><p style="font-size:12px;color:#475569;margin-bottom:12px">${data.notes.replace(/\n/g,'<br>')}</p>` : ''}
</div>
${sigSection}
<div class="ftr">שקוף בחזית &nbsp;|&nbsp; ירון אנטניר &nbsp;|&nbsp; 050-8581935 &nbsp;|&nbsp; www.shakufbahazit.co.il</div>
</div>
</body></html>`;
}

app.get('/api/orders', (req, res) => res.json(rj('orders.json', [])));

app.post('/api/orders/generate', requirePassword, async (req, res) => {
  try {
    const orders = rj('orders.json', []);
    const quotes = rj('quotes.json', []);
    const now    = new Date();
    const dd = String(now.getDate()).padStart(2,'0');
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const orderNumber = `${dd}${mm}${yy}${orders.length + 1}`;
    const heDate = now.toLocaleDateString('he-IL', { year:'numeric', month:'long', day:'numeric' });
    const data   = { ...req.body, orderNumber, orderDate: heDate };

    const id       = uid();
    const fileName = `order_${id}.html`;
    const filePath = path.join(ORDERS_DIR, fileName);
    const html     = buildOrderHtml(data);
    fs.writeFileSync(filePath, html, 'utf8');

    const shows    = data.shows || [];
    const travel   = parseFloat(data.travelCost || 0);
    const showsTotal = shows.reduce((s, sh) => s + (parseFloat(sh.price) || 0), 0);
    const vat        = data.includeVat ? Math.round(showsTotal * 0.18) : 0;
    const grandTotal = showsTotal + travel + vat;

    const order = {
      id, orderNumber, orderDate: heDate, fileName,
      quoteNumber: data.quoteNumber || '',
      quoteId:     data.quoteId     || '',
      contactId:   data.contactId   || null,
      contactName: data.contactName || '',
      showName:    (shows[0] && shows[0].showName) || '',
      total:       grandTotal,
      status:      'sent',
      createdAt:   now.toISOString(),
      wpUrl:       '',
    };

    // Publish to WordPress if configured
    if (WP_URL) {
      try {
        const wpRes = await wpFetch('/orders', 'POST', {
          id:           orderNumber,
          html,
          contact_id:   order.contactId   || '',
          contact_name: order.contactName || '',
          quote_id:     order.quoteId     || '',
        });
        order.wpUrl = wpRes.url;
      } catch(e) {
        console.error('[WP Order]', e.message);
      }
    }

    // Mark quote as converted if quoteId given
    if (data.quoteId) {
      const q = quotes.find(x => x.id === data.quoteId);
      if (q) { q.status = 'approved'; q.orderId = id; wj('quotes.json', quotes); }
    }

    orders.push(order);
    wj('orders.json', orders);
    res.json({ ok: true, id, orderNumber, wpUrl: order.wpUrl });
  } catch(e) {
    console.error('[Order]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id/view', (req, res) => {
  const orders = rj('orders.json', []);
  const o = orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).send('לא נמצא');
  const fp = path.join(ORDERS_DIR, o.fileName);
  if (!fs.existsSync(fp)) return res.status(404).send('קובץ לא נמצא');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(fp).pipe(res);
});

app.put('/api/orders/:id/status', requirePassword, (req, res) => {
  const orders = rj('orders.json', []);
  const o = orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'לא נמצא' });
  Object.assign(o, req.body);
  wj('orders.json', orders);
  res.json({ ok: true });
});

// ─── WordPress Events Polling ─────────────────────────────────────────────────
async function pollWpEvents() {
  if (!WP_URL || !WP_API_KEY) return;
  try {
    const { events } = await wpFetch('/events');
    if (!events || events.length === 0) return;

    const tasks    = rj('tasks.json', []);
    const contacts = rj('contacts.json', []);
    const orders   = rj('orders.json', []);
    const ackIds   = [];
    let tasksChanged   = false;
    let ordersChanged  = false;

    for (const ev of events) {
      ackIds.push(ev.id);
      const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;

      if (ev.event_type === 'offer_viewed') {
        // Create follow-up task 24h from now, skipping Fri/Sat/holidays
        const followUp = nextBusinessDay(new Date(), 24);
        const contact  = contacts.find(c => c.id === d.contact_id);
        const task = {
          id:             uid(),
          type:           'task',
          title:          `מעקב אחרי הצעת מחיר — ${contact?.name || d.contact_id}`,
          notes:          `הלקוח צפה בהצעת מחיר. נא לעקוב!`,
          contactId:      d.contact_id || null,
          dueDate:        followUp.toISOString().split('T')[0],
          dueTime:        `${String(followUp.getHours()).padStart(2,'0')}:${String(followUp.getMinutes()).padStart(2,'0')}`,
          priority:       'high',
          completed:      false,
          createdAt:      new Date().toISOString(),
          source:         'wp_offer_viewed',
        };
        tasks.push(task);
        tasksChanged = true;
        console.log('[WP Poll] offer_viewed → follow-up task created for', d.contact_id);
      }

      if (ev.event_type === 'wa_incoming') {
        // Incoming WhatsApp message via Meta Cloud API webhook
        const phone = d.from || '';
        const contact = findContactByPhone(phone);
        logWaMsg({
          direction: 'received',
          rawPhone:  phone,
          name:      contact?.name || d.name || phone,
          contactId: contact?.id   || null,
          showId:    null,
          message:   d.text || '[הודעה]',
          source:    'incoming',
        });
        console.log(`[WP Poll] wa_incoming from ${d.name||phone}: ${(d.text||'').slice(0,60)}`);
        // Don't push to ackIds yet — already pushed above
      }

      if (ev.event_type === 'wa_status') {
        // Delivery/read receipts — just acknowledge, nothing to do
      }

      if (ev.event_type === 'order_signed') {
        // Update order record
        const order = orders.find(x => x.orderNumber === d.order_id || x.id === d.order_id);
        if (order) {
          order.status    = 'signed';
          order.signedAt  = d.signed_at;
          order.signature = d.signature;
          ordersChanged = true;
        }
        // Add entry to contact's orders list
        const contact = contacts.find(c => c.id === d.contact_id);
        if (contact) {
          if (!Array.isArray(contact.ordersSigned)) contact.ordersSigned = [];
          contact.ordersSigned.unshift({
            orderId:   d.order_id,
            signedAt:  d.signed_at,
            signature: d.signature,
          });
        }
        console.log('[WP Poll] order_signed for', d.order_id, 'by', d.contact_id);
        tasksChanged = true; // contacts changed

        // Send WhatsApp notification from CRM (more reliable than from WordPress)
        if (WA_CLOUD) {
          const contactName = contact?.name || d.contact_id || '';
          const signedAt = d.signed_at ? new Date(d.signed_at).toLocaleString('he-IL', { timeZone:'Asia/Jerusalem', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          const waMsg = `✍️ *הזמנה חתומה!*\n\nלקוח: *${contactName}*\nהזמנה מס׳: ${d.order_id}\nזמן חתימה: ${signedAt}`;
          const notifyPhone = process.env.NOTIFY_PHONE || '972525105100';
          sendWaMessage(notifyPhone, waMsg).then(() => {
            console.log('[WP Poll] WhatsApp notification sent for order', d.order_id);
          }).catch(e => {
            console.error('[WP Poll] WhatsApp send failed:', e.message);
          });
        }
      }
    }

    if (tasksChanged)  wj('tasks.json', tasks);
    if (ordersChanged) wj('orders.json', orders);
    wj('contacts.json', contacts);

    // Acknowledge processed events
    await wpFetch('/events/ack', 'POST', { ids: ackIds.map(Number) });
  } catch(e) {
    console.error('[WP Poll]', e.message);
  }
}

// Poll every 3 minutes
setInterval(pollWpEvents, 3 * 60 * 1000);

// ─── Manual Full Sync (kept for Settings page) ────────────────────────────────
app.post('/api/sync/calendar', requireAuth, async (req, res) => {
  try {
    const cal    = google.calendar({ version:'v3', auth:oauth2Client });
    const gtasks = google.tasks({ version:'v1', auth:oauth2Client });
    const items  = rj('tasks.json');
    const conts  = rj('contacts.json');
    const orgs   = rj('orgs.json');
    const result = { pushed:0, updated:0, pulled:0, errors:[] };

    const buildDesc = (t) => {
      const cont = conts.find(c => c.id === t.contactId);
      const org  = orgs.find(o => o.id === t.organizationId);
      return [t.notes||'', cont?`איש קשר: ${cont.name}`:'', org?`ארגון: ${org.name}`:'', `[CRM-ID: ${t.id}]`].filter(Boolean).join('\n');
    };

    for (const t of items.filter(i => i.type === 'event')) {
      const body = {
        summary:     t.title, description: buildDesc(t), location: t.location||'',
        start: t.startDateTime ? { dateTime:new Date(t.startDateTime).toISOString(), timeZone:'Asia/Jerusalem' } : { date:t.dueDate },
        end:   t.endDateTime   ? { dateTime:new Date(t.endDateTime).toISOString(),   timeZone:'Asia/Jerusalem' } : { date:t.dueDate },
      };
      try {
        if (t.googleEventId) { await cal.events.update({ calendarId:'primary', eventId:t.googleEventId, requestBody:body }); result.updated++; }
        else { const { data } = await cal.events.insert({ calendarId:'primary', requestBody:body }); t.googleEventId = data.id; result.pushed++; }
      } catch(e) { result.errors.push({ id:t.id, err:e.message }); }
    }

    for (const t of items.filter(i => i.type === 'task')) {
      const body = { title:t.title, notes:buildDesc(t), due:t.dueDate?new Date(t.dueDate+'T00:00:00+02:00').toISOString():undefined, status:t.completed?'completed':'needsAction' };
      try {
        if (t.googleTaskId) { await gtasks.tasks.update({ tasklist:'@default', task:t.googleTaskId, requestBody:body }); result.updated++; }
        else { const { data } = await gtasks.tasks.insert({ tasklist:'@default', requestBody:body }); t.googleTaskId = data.id; result.pushed++; }
      } catch(e) { result.errors.push({ id:t.id, err:e.message }); }
    }

    const existingGEids = new Set(items.filter(i=>i.googleEventId).map(i=>i.googleEventId));
    const tMin = new Date(); tMin.setMonth(tMin.getMonth() - 1);
    const { data:evData } = await cal.events.list({ calendarId:'primary', timeMin:tMin.toISOString(), singleEvents:true, orderBy:'startTime', maxResults:200 });
    for (const ev of evData.items||[]) {
      if (existingGEids.has(ev.id)) continue;
      if ((ev.description||'').includes('[CRM-ID:')) continue;
      // Extract online meeting link (Google Meet / Zoom) from conferenceData
      let onlineMeetingUrl = null;
      const confEntry = ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video');
      if (confEntry?.uri) onlineMeetingUrl = confEntry.uri;
      // Also check hangoutLink (legacy Google Meet)
      if (!onlineMeetingUrl && ev.hangoutLink) onlineMeetingUrl = ev.hangoutLink;
      // Check description for Zoom link pattern
      if (!onlineMeetingUrl) {
        const zoomMatch = (ev.description||'').match(/https?:\/\/[^\s]*zoom\.us\/j\/[^\s<]*/);
        if (zoomMatch) onlineMeetingUrl = zoomMatch[0];
      }
      items.unshift({ id:uid(), title:ev.summary||'פגישה', type:'event', contactId:null, organizationId:null, conversationId:null, attendeeIds:[], meetingType:'', dueDate:ev.start?.date||ev.start?.dateTime?.split('T')[0]||today(), dueTime: ev.start?.dateTime ? ev.start.dateTime.split('T')[1]?.slice(0,5) : null, startDateTime:ev.start?.dateTime||null, endDateTime:ev.end?.dateTime||null, location:ev.location||null, onlineMeetingUrl, completed:ev.status==='cancelled', googleEventId:ev.id, googleTaskId:null, notes:ev.description||'', priority:'normal', createdAt:today(), fromGoogle:true });
      result.pulled++;
    }

    const existingGTids = new Set(items.filter(i=>i.googleTaskId).map(i=>i.googleTaskId));
    const { data:gtData } = await gtasks.tasks.list({ tasklist:'@default', maxResults:100 });
    for (const gt of gtData.items||[]) {
      if (existingGTids.has(gt.id)) continue;
      if ((gt.notes||'').includes('[CRM-ID:')) continue;
      items.unshift({ id:uid(), title:gt.title, type:'task', contactId:null, organizationId:null, conversationId:null, dueDate:gt.due?gt.due.split('T')[0]:'', startDateTime:null, endDateTime:null, location:null, completed:gt.status==='completed', googleEventId:null, googleTaskId:gt.id, notes:gt.notes||'', priority:'normal', createdAt:today(), fromGoogle:true });
      result.pulled++;
    }

    wj('tasks.json', items);
    const ss = rj('sync-status.json',{}); ss.calendar = new Date().toISOString(); wj('sync-status.json', ss);
    res.json({ ok:true, ...result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/sync/contacts', requireAuth, async (req, res) => {
  try {
    const ppl    = google.people({ version:'v1', auth:oauth2Client });
    const conts  = rj('contacts.json');
    const orgs   = rj('orgs.json');
    const result = { pushed:0, updated:0, pulled:0, errors:[] };
    const orgMap = Object.fromEntries(orgs.map(o=>[o.id,o]));

    const pushAll = async (list, isOrg=false) => {
      for (const item of list) {
        try {
          const body = buildPersonBody(item, isOrg, orgMap);
          if (item.googleContactId) {
            try {
              const { data:cur } = await ppl.people.get({ resourceName:item.googleContactId, personFields:'metadata' });
              await ppl.people.updateContact({ resourceName:item.googleContactId, updatePersonFields:'names,phoneNumbers,emailAddresses,addresses,organizations,biographies', requestBody:{ ...body, etag:cur.etag } });
              result.updated++;
            } catch { item.googleContactId = null; }
          }
          if (!item.googleContactId) {
            const { data } = await ppl.people.createContact({ requestBody: body });
            item.googleContactId = data.resourceName;
            result.pushed++;
          }
        } catch(e) { result.errors.push({ id:item.id, err:e.message }); }
      }
    };

    await pushAll(conts, false);
    await pushAll(orgs, true);

    const existingIds = new Set([...conts.filter(c=>c.googleContactId).map(c=>c.googleContactId), ...orgs.filter(o=>o.googleContactId).map(o=>o.googleContactId)]);
    let pageToken;
    do {
      const { data } = await ppl.people.connections.list({ resourceName:'people/me', pageSize:200, pageToken, personFields:'names,phoneNumbers,emailAddresses,addresses,organizations,biographies' });
      for (const gp of data.connections||[]) {
        if (existingIds.has(gp.resourceName)) continue;
        const bio = gp.biographies?.[0]?.value||'';
        if (bio.includes('[CRM-ID:')) continue;
        const gPhone2 = gp.phoneNumbers?.[0]?.value||'';
        const gEmail2 = gp.emailAddresses?.[0]?.value||'';
        if (/[\u0590-\u05ff]/.test(gPhone2)) { console.warn(`[Sync] Skipped corrupted: ${gp.names?.[0]?.displayName}`); continue; }
        conts.unshift({ id:uid(), name:gp.names?.[0]?.displayName||'ללא שם', organizationId:null, role:gp.organizations?.[0]?.title||'', phone:gPhone2, email:gEmail2, city:gp.addresses?.[0]?.city||'', status:'lead', source:'Google Contacts', notes:bio, tags:[], conversations:[], showHistory:[], nextFollowUp:'', googleContactId:gp.resourceName, createdAt:today(), fromGoogle:true });
        result.pulled++;
      }
      pageToken = data.nextPageToken;
    } while(pageToken);

    wj('contacts.json', conts);
    wj('orgs.json', orgs);
    const ss = rj('sync-status.json',{}); ss.contacts = new Date().toISOString(); wj('sync-status.json', ss);
    res.json({ ok:true, ...result });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── RECOVERY: Force-pull ALL Google Contacts (including CRM-pushed ones) ─────
app.post('/api/sync/contacts/restore', requirePassword, async (req, res) => {
  try {
    const auth = bgAuth();
    if (!auth) return res.status(401).json({ error: 'לא מחובר לגוגל' });
    const ppl = google.people({ version: 'v1', auth });
    const conts = rj('contacts.json');
    const existByGoogleId = new Map(conts.filter(c=>c.googleContactId).map(c=>[c.googleContactId, c]));
    let imported = 0, skipped = 0;
    let pageToken;
    do {
      const { data } = await ppl.people.connections.list({
        resourceName: 'people/me', pageSize: 200, pageToken,
        personFields: 'names,phoneNumbers,emailAddresses,addresses,organizations,biographies',
      });
      for (const gp of data.connections || []) {
        // Skip if already in CRM
        if (existByGoogleId.has(gp.resourceName)) { skipped++; continue; }
        const bio   = gp.biographies?.[0]?.value || '';
        const gPhone = gp.phoneNumbers?.[0]?.value || '';
        const gEmail = gp.emailAddresses?.[0]?.value || '';
        // Skip if phone contains Hebrew (corrupted import data)
        if (/[\u0590-\u05ff]/.test(gPhone)) { skipped++; continue; }
        // Try to extract original CRM id from bio [CRM-ID: xxxx]
        const crmIdMatch = bio.match(/\[CRM-ID:\s*([^\]]+)\]/);
        const existingId = crmIdMatch ? crmIdMatch[1].trim() : null;
        // Skip if id already exists in our list (different googleContactId)
        if (existingId && conts.find(c => c.id === existingId)) { skipped++; continue; }
        const notesClean = bio.replace(/\[CRM-ID:[^\]]*\]/g, '').trim();
        conts.unshift({
          id: existingId || uid(),
          name: gp.names?.[0]?.displayName || 'ללא שם',
          organizationId: null, role: gp.organizations?.[0]?.title || '',
          phone: gPhone, email: gEmail,
          city: gp.addresses?.[0]?.city || '',
          status: 'lead', source: 'Google Contacts',
          notes: notesClean, tags: [], conversations: [], showHistory: [],
          nextFollowUp: '', googleContactId: gp.resourceName,
          createdAt: today(), fromGoogle: true,
          restoredAt: new Date().toISOString(),
        });
        imported++;
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    wj('contacts.json', conts);
    res.json({ ok: true, imported, skipped, total: conts.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto-sync status endpoint ────────────────────────────────────────────────
app.get('/api/sync-status', (req, res) => {
  const ss = rj('sync-status.json', {});
  res.json({ ...ss, autoActive: !!(loadStoredTokens()), lastPollTime });
});

// ─── Start polling (Google → CRM every 5 minutes) ────────────────────────────
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Initial pull after 15 seconds (let server stabilize first)
setTimeout(async () => {
  if (loadStoredTokens()) {
    console.log('[Auto-sync] Starting initial pull from Google...');
    await pullFromGoogle().catch(e => console.error('[Auto-sync]', e.message));
  }
}, 15000);

// Recurring pull every 5 minutes
setInterval(async () => {
  if (loadStoredTokens()) {
    console.log('[Auto-sync] Polling Google for changes...');
    await pullFromGoogle().catch(e => console.error('[Auto-sync]', e.message));
  }
}, POLL_INTERVAL);

// ─── WhatsApp Cloud API (Meta) ────────────────────────────────────────────────
const WA_PHONE_ID  = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN     = process.env.WA_ACCESS_TOKEN;
const WA_CLOUD     = !!(WA_PHONE_ID && WA_TOKEN);

let waStatus    = WA_CLOUD ? 'ready' : 'disconnected';
let waQR        = null;
let waBcast     = null;
let waOverdue   = [];
let waLastError = WA_CLOUD ? null : 'לא הוגדרו פרטי WhatsApp Cloud API ב-.env';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Phone → digits only for Cloud API: 972XXXXXXXXX
function normalizePhone(phone) {
  let d = (phone || '').replace(/\D/g, '');
  if (d.startsWith('0'))         d = '972' + d.slice(1);
  else if (!d.startsWith('972')) d = '972' + d;
  return d;
}

// ── Scheduled messages ──────────────────────────────────────────────────────
function loadScheduled()      { return rj('scheduled-wa.json', []); }
function saveScheduled(list)  { wj('scheduled-wa.json', list); }

async function sendWaMessage(phone, text) {
  if (!WA_CLOUD) throw new Error('WhatsApp Cloud API לא מוגדר — הגדר WA_ACCESS_TOKEN ו-WA_PHONE_NUMBER_ID ב-.env');
  const resp = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizePhone(phone),
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `שגיאת Cloud API ${resp.status}`);
  return data;
}

async function sendWaTemplate(phone, templateName, langCode, params) {
  if (!WA_CLOUD) throw new Error('WhatsApp Cloud API לא מוגדר');
  const components = [];
  if (params && params.length > 0) {
    components.push({
      type: 'header',
      parameters: [{ type: 'text', text: String(params[0]) }],
    });
  }
  if (params && params.length > 1) {
    components.push({
      type: 'body',
      parameters: params.slice(1).map(p => ({ type: 'text', text: String(p) })),
    });
  }
  console.log('[WA Template] sending:', JSON.stringify({ templateName, langCode, components }));
  const resp = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: normalizePhone(phone),
      type: 'template',
      template: {
        name: templateName,
        language: { code: langCode || 'he' },
        components,
      },
    }),
  });
  const data = await resp.json();
  console.log('[WA Template] response:', JSON.stringify(data));
  if (!resp.ok) throw new Error(data.error?.message || `שגיאת Cloud API ${resp.status}`);
  return data;
}


async function runBroadcast(contacts, message, delayMs, progressObj, showId = null) {
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (!c.phone) { if (progressObj) progressObj.failed++; continue; }
    // Sleep BETWEEN messages, not before the first one
    if (i > 0) {
      const jitter = Math.floor(Math.random() * 2000);
      await sleep(delayMs + jitter);
    }
    if (progressObj) progressObj.currentName = c.name;
    const msg = message.replace(/\{\{name\}\}/g, c.name||'').replace(/\{\{שם\}\}/g, c.name||'');
    try {
      await sendWaMessage(c.phone, msg);
      if (progressObj) { progressObj.sent++; progressObj.lastSentAt = Date.now(); }
      console.log(`[WA] ✅ ${c.name}`);
      // תיעוד ההודעה
      logWaMsg({ direction:'sent', rawPhone:c.phone, name:c.name, contactId:c.contactId||null, showId, message:msg, source:'broadcast' });
    } catch(e) {
      if (progressObj) { progressObj.failed++; progressObj.errors.push({ name:c.name, error:e.message }); }
      console.error(`[WA] ❌ ${c.name}:`, e.message);
    }
  }
  if (progressObj) { progressObj.done = true; progressObj.currentName = ''; }
}

// Check scheduled messages every minute
setInterval(async () => {
  if (waStatus !== 'ready') return;
  const now  = new Date();
  const list = loadScheduled();
  let dirty  = false;
  for (const item of list) {
    if (item.status !== 'pending') continue;
    if (new Date(item.scheduleAt) > now) continue;
    dirty = true;
    item.status = 'sending';
    console.log(`[WA Scheduler] מריץ: ${item.type} #${item.id}`);
    if (item.type === 'single') {
      try {
        await sendWaMessage(item.phone, item.message);
        item.status = 'sent';
        console.log(`[WA Scheduler] ✅ נשלח ל-${item.phone}`);
      } catch(e) { item.status = 'failed'; item.error = e.message; }
    } else {
      item.status = 'sent';
      runBroadcast(item.contacts, item.message, item.delayMs||7000, null)
        .then(()=>console.log(`[WA Scheduler] ✅ ברודקאסט הסתיים`))
        .catch(e=>console.error('[WA Scheduler]', e.message));
    }
  }
  if (dirty) saveScheduled(list);
}, 60 * 1000);

// ─── Task Reminders (WhatsApp) ────────────────────────────────────────────────
function getAppBaseUrl() { return BASE_URL; }

function taskToken(id) {
  return crypto.createHash('sha256')
    .update(id + (process.env.SESSION_SECRET || 'crm-shakuf-secret-2024'))
    .digest('hex').slice(0, 14);
}

function loadTaskReminders()    { return rj('task-reminders.json', {}); }
function saveTaskReminders(d)   { wj('task-reminders.json', d); }

// Unicode bidi helpers for RTL WhatsApp messages
const RLM  = '\u200F'; // Right-to-Left Mark  — forces line direction RTL
const LRI  = '\u2066'; // Left-to-Right Isolate — wraps LTR content within RTL line
const PDI  = '\u2069'; // Pop Directional Isolate
const r    = t => RLM + t;             // force RTL on a line
const ltr  = t => LRI + t + PDI;      // isolate LTR chunk (URLs, emails, phones)

function buildTaskWaMsg(task, contact, baseUrl, isOverdue) {
  const isCall = /טלפוני|להתקשר|יצירת קשר/i.test(task.taskType || '');
  const lines = [];

  if (isOverdue) {
    lines.push(r('⚠️ *משימה שלא בוצעה — תזכורת יומית*'));
  } else {
    lines.push(r('📋 *משימה להיום*'));
  }
  lines.push('');
  lines.push(r(`📌 *${task.title}*`));
  if (task.taskType) lines.push(r(`🔖 סוג: ${task.taskType}`));

  const dueDateFmt = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('he-IL', {day:'numeric',month:'long',year:'numeric'})
    : '';
  if (dueDateFmt) lines.push(r(`📅 תאריך: ${dueDateFmt}`));
  if (task.dueTime) lines.push(r(`⏰ שעה: ${task.dueTime}`));
  if (task.notes) { lines.push(''); lines.push(r(`📝 ${task.notes}`)); }

  if (contact) {
    lines.push('');
    lines.push(r(`👤 *${contact.name}*`));
    if (isCall && contact.phone) {
      lines.push(r(`📞 ${ltr(contact.phone)}`));
      const digits = (contact.phone || '').replace(/\D/g, '').replace(/^0/, '972');
      lines.push(r(`☎️ חיוג: ${ltr('tel:' + digits)}`));
    } else if (contact.phone) {
      lines.push(r(`📞 ${ltr(contact.phone)}`));
    }
    if (contact.email) lines.push(r(`📧 ${ltr(contact.email)}`));
    lines.push(r(`🔗 כרטיס: ${ltr(baseUrl + '/?contact=' + contact.id)}`));
  }

  lines.push('');
  lines.push(r('✅ *סמן כבוצע:*'));
  lines.push(ltr(`${baseUrl}/task-done?id=${task.id}&secret=${taskToken(task.id)}`));

  return lines.join('\n');
}

// ── Meeting (event) WA reminder message ──────────────────────────────────────
function buildMeetingWaMsg(task, contact, attendees, baseUrl) {
  const lines = [];
  lines.push(r('📅 *תזכורת פגישה — מחר*'));
  lines.push('');
  lines.push(r(`📌 *${task.title}*`));
  if (task.meetingType) lines.push(r(`🗂 סוג: ${task.meetingType}`));

  const dueDateFmt = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('he-IL', {weekday:'long',day:'numeric',month:'long',year:'numeric'})
    : '';
  if (dueDateFmt) lines.push(r(`📆 תאריך: ${dueDateFmt}`));
  if (task.dueTime) lines.push(r(`⏰ שעה: ${task.dueTime}`));

  if (task.location) lines.push(r(`📍 מיקום: ${task.location}`));

  // Online meeting link — isolate URL as LTR within RTL line
  if (task.onlineMeetingUrl) {
    const url = task.onlineMeetingUrl;
    const isZoom = url.includes('zoom.us');
    const isMeet = url.includes('meet.google') || url.includes('hangout');
    const prefix = isZoom ? '🎥 זום' : isMeet ? '🟢 גוגל מיט' : '🔗 פגישה מקוונת';
    lines.push(r(`${prefix}: ${ltr(url)}`));
  }

  // Primary contact
  if (contact) {
    lines.push('');
    lines.push(r(`👤 *${contact.name}*`));
    if (contact.phone) lines.push(r(`📞 ${ltr(contact.phone)}`));
    if (contact.email) lines.push(r(`📧 ${ltr(contact.email)}`));
  }

  // Additional attendees
  if (attendees && attendees.length > 0) {
    lines.push('');
    lines.push(r(`👥 *משתתפים (${attendees.length}):*`));
    attendees.forEach(a => {
      const phone = a.phone ? ` · ${ltr(a.phone)}` : '';
      lines.push(r(`• ${a.name}${phone}`));
    });
  }

  if (task.notes) { lines.push(''); lines.push(r(`📝 ${task.notes}`)); }

  lines.push('');
  lines.push(r('✅ *סמן כבוצע:*'));
  lines.push(ltr(`${baseUrl}/task-done?id=${task.id}&secret=${taskToken(task.id)}`));

  return lines.join('\n');
}

// Task-done endpoint — public (secured by token)
app.get('/task-done', (req, res) => {
  const { id, secret } = req.query;
  if (!id || !secret || secret !== taskToken(id)) {
    return res.status(403).send('<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>שגיאה</title></head><body style="font-family:Arial;text-align:center;padding:60px"><h2>❌ קישור לא תקין</h2></body></html>');
  }
  const tasks = rj('tasks.json', []);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).send('<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"></head><body style="font-family:Arial;text-align:center;padding:60px"><h2>משימה לא נמצאה</h2></body></html>');
  if (tasks[idx].completed) {
    return res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>CRM</title></head><body style="font-family:Arial;text-align:center;padding:60px;background:#f0fdf4"><h2 style="color:#166534">✅ המשימה כבר סומנה כבוצעה</h2><p style="font-size:18px;color:#1e293b">${tasks[idx].title}</p><p style="color:#64748b">ניתן לסגור חלון זה</p></body></html>`);
  }
  tasks[idx].completed   = true;
  tasks[idx].taskStatus  = 'הושלמה';
  tasks[idx].completedAt = new Date().toISOString();
  wj('tasks.json', tasks);
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>CRM</title></head><body style="font-family:Arial;text-align:center;padding:60px;background:#f0fdf4"><h2 style="color:#166534">✅ משימה בוצעה!</h2><p style="font-size:20px;color:#1e293b;margin:16px 0">${tasks[idx].title}</p><p style="color:#64748b">עודכן בהצלחה. ניתן לסגור חלון זה.</p></body></html>`);
});

// Task & Meeting reminder scheduler — runs every minute
setInterval(async () => {
  if (!WA_CLOUD) return;
  const notifyPhone = process.env.NOTIFY_PHONE;
  if (!notifyPhone) return;

  const nowDate = new Date();
  // Use Israel time (UTC+3)
  const israelOffset = 3 * 60; // minutes
  const localNow = new Date(nowDate.getTime() + (israelOffset - nowDate.getTimezoneOffset()) * 60000);
  const todayStr    = localNow.toISOString().split('T')[0];
  const tomorrowStr = new Date(localNow.getTime() + 86400000).toISOString().split('T')[0];
  const nowHHMM     = localNow.toTimeString().slice(0, 5); // "HH:MM"

  const tasks    = rj('tasks.json', []);
  const contacts = rj('contacts.json', []);
  const contactMap = Object.fromEntries(contacts.map(c => [c.id, c]));
  const reminders  = loadTaskReminders();
  const baseUrl    = getAppBaseUrl();
  let changed = false;

  for (const task of tasks) {
    if (task.completed || !task.dueDate) continue;

    // ── TASK reminders (today / overdue) ──────────────────────────────
    if (task.type === 'task') {
      const isToday   = task.dueDate === todayStr;
      const isOverdue = task.dueDate < todayStr;
      if (!isToday && !isOverdue) continue;

      const targetTime = task.dueTime || '09:00';
      if (nowHHMM < targetTime) continue;

      const lastSentDate = (reminders[task.id] || '').slice(0, 10);
      if (lastSentDate === todayStr) continue; // already sent today

      try {
        const contact = task.contactId ? contactMap[task.contactId] : null;
        const msg = buildTaskWaMsg(task, contact, baseUrl, isOverdue);
        await sendWaMessage(normalizePhone(notifyPhone), msg);
        reminders[task.id] = localNow.toISOString();
        changed = true;
        console.log(`[Task Reminder] ✅ ${isOverdue ? 'פיגור' : 'היום'}: ${task.title}`);
      } catch (e) {
        console.error(`[Task Reminder] ❌ ${task.title}:`, e.message);
      }
    }

    // ── MEETING (event) reminders — 24 hours before ───────────────────
    if (task.type === 'event') {
      // We want to send the reminder on the day BEFORE the meeting
      if (task.dueDate !== tomorrowStr) continue;

      // Send at a sensible time: meeting hour - 1 min, OR at 09:00 day-before
      // Strategy: send at 09:00 on the day before, but only once
      const sendAt = '09:00';
      if (nowHHMM < sendAt) continue;

      const reminderKey = `meeting_24h_${task.id}`;
      const lastSentDate = (reminders[reminderKey] || '').slice(0, 10);
      if (lastSentDate === todayStr) continue; // already sent today (= day before)

      try {
        const contact  = task.contactId ? contactMap[task.contactId] : null;
        const attendees = (task.attendeeIds || []).map(id => contactMap[id]).filter(Boolean);
        const msg = buildMeetingWaMsg(task, contact, attendees, baseUrl);
        await sendWaMessage(normalizePhone(notifyPhone), msg);
        reminders[reminderKey] = localNow.toISOString();
        changed = true;
        console.log(`[Meeting Reminder] ✅ מחר: ${task.title}`);
      } catch (e) {
        console.error(`[Meeting Reminder] ❌ ${task.title}:`, e.message);
      }
    }
  }

  if (changed) saveTaskReminders(reminders);
}, 60 * 1000);

// ── Cloud API — initWA ───────────────────────────────────────────────────────
async function initWA() {
  if (WA_CLOUD) { waStatus = 'ready'; return; }
  console.log('[WA] Cloud API לא מוגדר — הגדר WA_ACCESS_TOKEN ב-.env');
}
// Legacy Baileys code removed — replaced by Cloud API
// The following is dead code kept only for reference, wrapped in a never-called function:
/*
  let makeWASocket, useMultiFileAuthState, DisconnectReason, QRCode, Browsers;
  try {
    ({ default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys'));
    QRCode = require('qrcode');
  } catch(e) {
    console.error('[WA] חבילות חסרות — הרץ: npm install');
    return;
  }
  waStatus = 'connecting';
  const myGen = ++waGeneration; // מזהה ייחודי לחיבור הזה
  console.log('[WA] שלב 1: מכין session...');
  const sessionDir = path.join(DATA, 'wa-session');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log('[WA] שלב 2: מביא גרסת WhatsApp עדכנית...');
  let waVersion;
  try { const v = await fetchLatestBaileysVersion(); waVersion = v.version; console.log('[WA] גרסה:', waVersion); }
  catch { waVersion = [2,3000,1023459663]; console.log('[WA] משתמש בגרסה ברירת מחדל'); }
  console.log('[WA] שלב 3: יוצר socket...');
  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    printQRInTerminal: false,
    logger: silentLogger,
    browser: Browsers.ubuntu('Chrome'),  // browser סטנדרטי — נדרש על ידי WhatsApp
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });
  console.log('[WA] שלב 4: socket נוצר, ממתין לאירועים...');
  waSock = sock;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // אם זה לא ה-socket הנוכחי — התעלם (מניעת race condition)
    if (myGen !== waGeneration) { console.log('[WA] התעלם מאירוע socket ישן (gen', myGen, '!= cur', waGeneration+')'); return; }

    if (qr) {
      waStatus = 'qr';
      try {
        waQR = await QRCode.toDataURL(qr);
        console.log('[WA] ✅ QR מוכן — סרוק בדפדפן');
      } catch(e) {
        console.error('[WA] שגיאה בייצור QR:', e.message);
        waQR = null;
      }
    }
    if (connection === 'close') {
      const code    = lastDisconnect?.error?.output?.statusCode;
      const loggedOut       = code === DisconnectReason?.loggedOut;   // 401
      const connectionReplaced = code === 440;
      const badSession = loggedOut || connectionReplaced || code === 403 || code === 500;
      waSock = null; waStatus = 'disconnected'; waQR = null;
      const errMsg = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'unknown');
      console.log('[WA] חיבור נסגר. קוד:', code, '| שגיאה:', errMsg);

      if (code === 515) {
        // 515 = Stream Errored / restart required — מיד מתחבר מחדש, QR יחזור תוך שניה
        console.log('[WA] 🔄 515 stream restart — מתחבר מחדש מיידית...');
        waAutoRetried = false;
        setTimeout(initWA, 800);
      } else if (badSession || code === 405) {
        // 405 = WhatsApp חסמה זמנית (יותר מדי ניסיונות) — אל תנסה מחדש אוטומטית!
        const sd = path.join(DATA, 'wa-session');
        if (fs.existsSync(sd)) { fs.rmSync(sd, { recursive:true, force:true }); console.log('[WA] 🗑️ סשן ישן נמחק'); }
        if (code === 405) {
          waBlockedUntil = Date.now() + 20 * 60 * 1000; // 20 דקות
          waLastError = 'WhatsApp חסמה זמנית את החיבור. המתן 20 דקות ונסה שוב.';
          console.log('[WA] ⚠️ קוד 405 — IP נחסם זמנית. חוסם ניסיונות חיבור ל-20 דקות!');
        } else {
          console.log('[WA] נותק — יש לסרוק QR מחדש');
        }
      } else if (!loggedOut) {
        // שגיאת רשת זמנית — נסה פעם אחת בלבד אחרי השהייה
        if (!waAutoRetried) {
          waAutoRetried = true;
          console.log('[WA] שגיאת רשת — מנסה פעם אחת נוספת בעוד 30 שניות...');
          setTimeout(initWA, 30000);
        } else {
          waAutoRetried = false;
          waLastError = 'שגיאת חיבור חוזרת. לחץ "חבר WhatsApp" לנסות שוב.';
          console.log('[WA] ⛔ ניסיון חוזר נכשל — ממתין לפקודה ידנית מהמשתמש');
        }
      }
    } else if (connection === 'open') {
      waStatus = 'ready'; waQR = null;
      console.log('[WA] ✅ מחובר ומוכן');
      // בדוק הודעות שתוזמנו ולא נשלחו
      const now = new Date();
      const overdue = loadScheduled().filter(m => m.status === 'pending' && new Date(m.scheduleAt) <= now);
      if (overdue.length > 0) {
        waOverdue = overdue;
        console.log(`[WA] נמצאו ${overdue.length} הודעות שלא נשלחו`);
      }
    }
  });
  sock.ev.on('creds.update', saveCreds);

  // ── האזנה להודעות נכנסות ───────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return; // רק הודעות חדשות, לא היסטוריה
    for (const msg of msgs) {
      try {
        if (msg.key?.fromMe) continue; // הודעות שאני שלחתי — מתועדות ב-runBroadcast
        const jid = msg.key?.remoteJid || '';
        if (jid.endsWith('@g.us')) continue; // דלג על הודעות קבוצה
        const rawPhone = jid.split('@')[0];

        // ── Bot: זיהוי לחיצת כפתור ──────────────────────────────────────────
        const selectedButtonId =
          msg.message?.buttonsResponseMessage?.selectedButtonId ||
          msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          msg.message?.templateButtonReplyMessage?.selectedId;

        if (selectedButtonId) {
          const parsed = parseBtnId(selectedButtonId);
          if (parsed) {
            const flows  = rj('bot-flows.json', []);
            const flow   = flows.find(f => f.id === parsed.flowId);
            const btn    = flow?.buttons?.[parsed.btnIdx];
            if (btn) {
              console.log(`[Bot] 🔘 ${rawPhone} לחץ: "${btn.text}"`);
              const contact = findContactByPhone(rawPhone);
              logWaMsg({ direction:'received', rawPhone, name:contact?.name||msg.pushName||rawPhone, contactId:contact?.id||null, showId:null, message:`[כפתור] ${btn.text}`, source:'incoming' });

              await sleep(600);
              if (btn.action === 'collect-lead') {
                botState.set(rawPhone, { mode:'collect', fields:['name','email'], collected:{ phone: normPhoneCrm(rawPhone) }, afterFlowId: btn.nextFlowId || null });
                await sock.sendMessage(jid, { text: 'נהדר! 😊\nמה השם שלך?' });
              } else if (btn.action === 'reply' && btn.replyText) {
                await sock.sendMessage(jid, { text: btn.replyText });
                if (btn.nextFlowId) { await sleep(1000); await sendBotFlow(jid, btn.nextFlowId, sock); }
              } else if (btn.action === 'link' && btn.linkUrl) {
                const linkMsg = btn.linkTitle
                  ? `${btn.linkTitle}\n${btn.linkUrl}`
                  : btn.linkUrl;
                await sock.sendMessage(jid, { text: linkMsg });
                if (btn.nextFlowId) { await sleep(1000); await sendBotFlow(jid, btn.nextFlowId, sock); }
              } else if (btn.action === 'phone' && btn.phoneNumber) {
                const phoneMsg = btn.phoneTitle
                  ? `${btn.phoneTitle}\n📞 ${btn.phoneNumber}`
                  : `📞 ${btn.phoneNumber}`;
                await sock.sendMessage(jid, { text: phoneMsg });
                if (btn.nextFlowId) { await sleep(1000); await sendBotFlow(jid, btn.nextFlowId, sock); }
              } else if (btn.nextFlowId) {
                await sendBotFlow(jid, btn.nextFlowId, sock);
              }
            }
            continue; // הודעה זו טופלה על ידי הבוט
          }
        }

        // ── Bot: מצב איסוף פרטים (free text answers) ────────────────────────
        const bState = botState.get(rawPhone);
        if (bState && bState.mode === 'collect') {
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          if (!text.trim()) continue;
          const field = bState.fields[0];

          if (field === 'name') {
            bState.collected.name = text.trim();
            bState.fields.shift();
            if (bState.fields[0] === 'email') {
              await sleep(600);
              await sock.sendMessage(jid, { text: 'מה כתובת האימייל שלך?\n(לדלג — שלח "דלג")' });
            } else {
              bState.fields = [];
            }
          } else if (field === 'email') {
            if (text.trim().toLowerCase() !== 'דלג' && text.trim() !== '-') {
              bState.collected.email = text.trim();
            }
            bState.fields.shift();
          }

          if (bState.fields.length === 0) {
            // שמור ליד ב-CRM
            const { name, phone: pn, email } = bState.collected;
            let contacts = rj('contacts.json', []);
            const norm   = normPhoneCrm(rawPhone);
            let contact  = contacts.find(c => normPhoneCrm(c.phone||'') === norm);
            if (!contact) {
              contact = { id:uid(), name:name||rawPhone, organizationId:null, role:'', phone:pn||normPhoneCrm(rawPhone), email:email||'', city:'', status:'lead', source:'WhatsApp בוט', notes:'ליד שנכנס דרך הבוט', tags:['ליד-וואטסאפ'], conversations:[], showHistory:[], nextFollowUp:'', googleContactId:null, createdAt:today() };
              contacts.unshift(contact);
              wj('contacts.json', contacts);
              console.log(`[Bot] 👤 ליד חדש: ${name}`);
            } else {
              const idx = contacts.findIndex(c=>c.id===contact.id);
              if (name && !contacts[idx].name) contacts[idx].name = name;
              if (email)                        contacts[idx].email = email;
              wj('contacts.json', contacts);
            }

            const afterFlowId = bState.afterFlowId;
            botState.delete(rawPhone);
            await sleep(600);
            await sock.sendMessage(jid, { text: `תודה ${name || ''}! 🙏\nקיבלנו את הפרטים שלך ונחזור אליך בקרוב.` });
            if (afterFlowId) { await sleep(1500); await sendBotFlow(jid, afterFlowId, sock); }
          }
          continue;
        }

        // ── הודעה רגילה — תיעוד בלבד ───────────────────────────────────────
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          '[הודעה ללא טקסט]';
        const pushName = msg.pushName || '';
        const contact = findContactByPhone(rawPhone);
        logWaMsg({ direction:'received', rawPhone, name:contact?.name||pushName||rawPhone, contactId:contact?.id||null, showId:null, message:text, source:'incoming' });
        console.log(`[WA] 📩 נכנסה הודעה מ-${contact?.name||pushName||rawPhone}`);
      } catch(e) {
        console.error('[WA] שגיאה בתיעוד הודעה נכנסת:', e.message);
      }
    }
  });
*/

// Cloud API — בדוק תקינות בהפעלה
if (WA_CLOUD) {
  console.log(`[WA] ✅ Cloud API מוגדר — Phone Number ID: ${WA_PHONE_ID}`);
} else {
  console.log('[WA] ⚠️  Cloud API לא מוגדר — הגדר WA_ACCESS_TOKEN ו-WA_PHONE_NUMBER_ID ב-.env');
}

// ── WA API routes ─────────────────────────────────────────────────────────────
app.get('/api/wa/status', (req, res) => {
  res.json({
    status: WA_CLOUD ? 'ready' : 'disconnected',
    cloudApi: WA_CLOUD,
    phoneNumberId: WA_PHONE_ID || null,
    qr: null,
    broadcast: waBcast,
    scheduled: loadScheduled(),
    overdue: waOverdue,
    lastError: waLastError,
  });
});

app.post('/api/wa/connect', async (req, res) => {
  if (!WA_CLOUD) return res.status(400).json({ error: 'הגדר WA_ACCESS_TOKEN ו-WA_PHONE_NUMBER_ID ב-.env' });
  // בדוק שהטוקן תקף
  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}?fields=display_phone_number,verified_name`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'טוקן לא תקף');
    waStatus = 'ready'; waLastError = null;
    res.json({ ok: true, status: 'ready', phone: data.display_phone_number, name: data.verified_name });
  } catch(e) {
    waStatus = 'disconnected'; waLastError = e.message;
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/wa/disconnect', async (req, res) => {
  // Cloud API אין "ניתוק" — רק מסמנים כמנותק ב-UI
  waStatus = 'disconnected';
  res.json({ ok: true });
});

// ─── Force fresh connect (מוחק סשן + מחובר מחדש מאפס) ────────────────────────
app.post('/api/wa/reset', async (req, res) => {
  // בטל את ה-generation הנוכחי (אירועים מה-socket הישן יתעלמו)
  waGeneration++;
  // כבה socket קיים בלי לחכות לאירוע close
  if (waSock) { try { waSock.end(); } catch {} waSock = null; }
  waStatus = 'disconnected'; waQR = null; waLastError = null;
  // מחק session
  const sd = path.join(DATA, 'wa-session');
  if (fs.existsSync(sd)) { try { fs.rmSync(sd, { recursive: true, force: true }); } catch(e) { console.error('[WA] שגיאה במחיקת סשן:', e.message); } }
  console.log('[WA] 🔄 Reset — סשן נמחק, מתחבר מחדש...');
  // התחל חיבור חדש
  await initWA();
  res.json({ ok: true, status: waStatus });
});

app.post('/api/wa/send', async (req, res) => {
  const { phone, message, scheduleAt, contactId, name, showId } = req.body;
  if (!phone)    return res.status(400).json({ error: 'חסר מספר טלפון' });
  if (!message)  return res.status(400).json({ error: 'חסרה הודעה' });

  // ── Scheduled ──
  if (scheduleAt) {
    const list = loadScheduled();
    const item = { id: uid(), type:'single', phone, message, scheduleAt, status:'pending', createdAt: new Date().toISOString() };
    list.push(item);
    saveScheduled(list);
    return res.json({ ok:true, scheduled:true, id:item.id });
  }

  // ── Immediate ──
  try {
    await sendWaMessage(phone, message);
    // תיעוד
    const cont = findContactByPhone(phone);
    logWaMsg({ direction:'sent', rawPhone:phone, name: name || cont?.name || '', contactId: contactId || cont?.id || null, showId: showId||null, message, source:'single' });
    res.json({ ok:true });
  }
  catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/wa/send-template', async (req, res) => {
  const { phone, templateName, langCode, params, contactId, name, showId } = req.body;
  if (!phone)         return res.status(400).json({ error: 'חסר מספר טלפון' });
  if (!templateName)  return res.status(400).json({ error: 'חסר שם תבנית' });
  try {
    await sendWaTemplate(phone, templateName, langCode || 'he', params || []);
    // תיעוד ב-wa-messages
    const cont = findContactByPhone(phone);
    const preview = `[תבנית: ${templateName}]` + (params?.length ? ' ' + params.join(', ') : '');
    logWaMsg({ direction:'sent', rawPhone:phone, name: name || cont?.name || '', contactId: contactId || cont?.id || null, showId: showId||null, message: preview, source:'template' });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/wa/broadcast', async (req, res) => {
  const { contacts, message, delayMs = 7000, scheduleAt, showId } = req.body;
  if (!contacts?.length) return res.status(400).json({ error: 'אין אנשי קשר' });

  // ── Scheduled ──
  if (scheduleAt) {
    const list = loadScheduled();
    const item = { id: uid(), type:'broadcast', contacts, message, delayMs, scheduleAt, showId: showId||null, status:'pending', createdAt: new Date().toISOString() };
    list.push(item);
    saveScheduled(list);
    return res.json({ ok:true, scheduled:true, id:item.id });
  }

  // ── Immediate ──
  if (waStatus !== 'ready') return res.status(400).json({ error: 'WhatsApp לא מחובר' });
  if (waBcast && !waBcast.done) return res.status(400).json({ error: 'שליחה כבר בתהליך' });
  waBcast = { total: contacts.length, sent:0, failed:0, done:false, errors:[] };
  res.json({ ok:true, total: contacts.length });
  runBroadcast(contacts, message, delayMs, waBcast, showId||null);
});

app.delete('/api/wa/scheduled/:id', (req, res) => {
  saveScheduled(loadScheduled().filter(x => x.id !== req.params.id));
  res.json({ ok:true });
});

// ─── WA Messages API ──────────────────────────────────────────────────────────
app.get('/api/wa/messages', (req, res) => {
  let msgs = loadWaMsgs();
  if (req.query.contactId) msgs = msgs.filter(m => m.contactId === req.query.contactId);
  if (req.query.showId)    msgs = msgs.filter(m => m.showId    === req.query.showId);
  res.json(msgs);
});

app.get('/api/wa/inbox', (req, res) => {
  const msgs = loadWaMsgs().filter(m => !m.contactId);
  res.json(msgs);
});

app.put('/api/wa/messages/:id/link', (req, res) => {
  const { contactId } = req.body;
  const msgs = loadWaMsgs();
  const idx = msgs.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
  msgs[idx].contactId = contactId;
  const contacts = rj('contacts.json', []);
  const cont = contacts.find(c => c.id === contactId);
  if (cont) msgs[idx].name = cont.name;
  saveWaMsgs(msgs);
  res.json(msgs[idx]);
});

app.put('/api/wa/messages/link-all', (req, res) => {
  const { phone, contactId } = req.body;
  if (!phone || !contactId) return res.status(400).json({ error: 'חסרים פרטים' });
  const msgs = loadWaMsgs();
  const norm = normPhoneCrm(phone);
  const contacts = rj('contacts.json', []);
  const cont = contacts.find(c => c.id === contactId);
  let count = 0;
  msgs.forEach(m => {
    if (normPhoneCrm(m.phone) === norm && !m.contactId) {
      m.contactId = contactId;
      if (cont) m.name = cont.name;
      count++;
    }
  });
  saveWaMsgs(msgs);
  res.json({ ok:true, linked: count });
});

app.delete('/api/wa/messages/:id', (req, res) => {
  saveWaMsgs(loadWaMsgs().filter(m => m.id !== req.params.id));
  res.json({ ok:true });
});

// הודעות שתוזמנו ולא נשלחו (overdue)
app.get('/api/wa/overdue', (req, res) => {
  res.json({ items: waOverdue });
});

app.post('/api/wa/overdue/send', async (req, res) => {
  if (waStatus !== 'ready') return res.status(400).json({ error: 'WA לא מחובר' });
  const items = [...waOverdue];
  waOverdue = [];
  res.json({ ok: true, count: items.length });
  // שלח בצורה אסינכרונית
  for (const item of items) {
    try {
      if (item.type === 'single') {
        await sendWaMessage(item.phone, item.message);
      } else {
        runBroadcast(item.contacts, item.message, item.delayMs || 7000, null);
      }
      const list = loadScheduled();
      const idx = list.findIndex(x => x.id === item.id);
      if (idx !== -1) { list[idx].status = 'sent'; saveScheduled(list); }
    } catch(e) {
      const list = loadScheduled();
      const idx = list.findIndex(x => x.id === item.id);
      if (idx !== -1) { list[idx].status = 'failed'; list[idx].error = e.message; saveScheduled(list); }
    }
  }
});

app.post('/api/wa/overdue/dismiss', (req, res) => {
  waOverdue = [];
  res.json({ ok: true });
});

// ─── WhatsApp Bot (Flows Engine) ──────────────────────────────────────────────

// Bot conversation state: phone → { mode, fields, collected, afterFlowId }
const botState = new Map();

function makeBtnId(flowId, btnIdx) { return `bf_${flowId}_${btnIdx}`; }

function parseBtnId(buttonId) {
  const m = (buttonId||'').match(/^bf_([a-z0-9]+)_(\d+)$/);
  if (!m) return null;
  return { flowId: m[1], btnIdx: parseInt(m[2]) };
}

async function sendBotFlow(jid, flowId, sock) {
  const flows   = rj('bot-flows.json', []);
  const flow    = flows.find(f => f.id === flowId);
  if (!flow) { console.log(`[Bot] Flow not found: ${flowId}`); return; }

  const buttons = (flow.buttons || []).filter(b => b.text);

  if (buttons.length === 0) {
    await sock.sendMessage(jid, { text: flow.message });
    return;
  }

  try {
    if (buttons.length <= 3) {
      await sock.sendMessage(jid, {
        buttons: buttons.map((b, i) => ({
          buttonId: makeBtnId(flowId, i),
          buttonText: { displayText: b.text },
          type: 1,
        })),
        text:       flow.message,
        footer:     flow.footer || '',
        headerType: 1,
      });
    } else {
      await sock.sendMessage(jid, {
        sections:    [{ title: 'אפשרויות', rows: buttons.map((b, i) => ({ title: b.text, rowId: makeBtnId(flowId, i) })) }],
        buttonText:  'בחר אפשרות',
        description: flow.message,
        listType:    1,
        title:       flow.title || '📋 תפריט',
      });
    }
    console.log(`[Bot] ✅ שלח flow "${flow.name}" ל-${jid}`);
  } catch(e) {
    // fallback: plain text with numbered options
    const lines = [flow.message, '', ...buttons.map((b,i)=>`${i+1}. ${b.text}`)];
    await sock.sendMessage(jid, { text: lines.join('\n') });
    console.log(`[Bot] ⚠️ נפל ל-fallback (plain text) — ${e.message}`);
  }
}

// Bot CRUD
const BF = crud('bot-flows.json', {});
app.get('/api/bot/flows',        BF.list);
app.post('/api/bot/flows',       BF.create);
app.put('/api/bot/flows/:id',    BF.update);
app.delete('/api/bot/flows/:id', BF.remove);

// Trigger a flow to a phone number
app.post('/api/bot/trigger', async (req, res) => {
  const { phone, flowId } = req.body;
  if (!phone || !flowId) return res.status(400).json({ error: 'חסרים פרטים' });
  if (waStatus !== 'ready')  return res.status(400).json({ error: 'WhatsApp לא מחובר' });
  try {
    await sendBotFlow(normalizePhone(phone), flowId, waSock);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bot settings (e.g., Elementor default flow)
app.get('/api/bot/settings', (req, res) => res.json(rj('bot-settings.json', {})));
app.put('/api/bot/settings', (req, res) => { wj('bot-settings.json', req.body); res.json({ ok: true }); });

// Quote default settings
app.get('/api/quote-settings', (req, res) => res.json(rj('quote-settings.json', {})));
app.put('/api/quote-settings', requirePassword, (req, res) => { wj('quote-settings.json', req.body); res.json({ ok: true }); });

// Show templates (name + description)
app.get('/api/show-templates', (req, res) => res.json(rj('show-templates.json', [])));
app.put('/api/show-templates', requirePassword, (req, res) => { wj('show-templates.json', req.body); res.json({ ok: true }); });

// ─── Elementor Webhook ────────────────────────────────────────────────────────
// Remove auth check for webhook so Elementor can POST from external server
app.post('/api/webhook/elementor', async (req, res) => {
  try {
    const body = req.body || {};
    // Support various field naming conventions
    const name  = body.name  || body.שם   || body['שם מלא'] || body.fullname || body.full_name || '';
    const phone = body.phone || body.טלפון || body.mobile   || body.cel      || body.telephone || '';
    const email = body.email || body.אימייל|| body.mail     || '';
    const flowId = body.flowId || body.flow_id || body.flow ||
                   rj('bot-settings.json', {}).elementorFlowId || '';

    if (!phone && !email) return res.json({ ok: true, message: 'no contact info' });

    // Find or create contact
    let contacts = rj('contacts.json', []);
    let contact  = null;
    if (phone) {
      const norm = normPhoneCrm(phone);
      contact = contacts.find(c => normPhoneCrm(c.phone||'') === norm);
    }
    if (!contact && email) {
      contact = contacts.find(c => (c.email||'').toLowerCase() === email.toLowerCase());
    }

    if (!contact) {
      contact = {
        id: uid(), name: name || phone || email, organizationId: null, role: '',
        phone, email, city: '', status: 'lead', source: 'אתר',
        notes: `ליד מאלמנטור\n${new Date().toLocaleString('he-IL')}\n${JSON.stringify(body)}`,
        tags: ['ליד-אתר'], conversations: [], showHistory: [],
        nextFollowUp: '', googleContactId: null, createdAt: today(),
      };
      contacts.unshift(contact);
      wj('contacts.json', contacts);
      console.log(`[Elementor] 👤 ליד חדש: ${contact.name}`);
    }

    // Trigger bot flow if configured and WA is ready
    if (flowId && waStatus === 'ready' && phone) {
      setTimeout(async () => {
        try { await sendBotFlow(normalizePhone(phone), flowId, waSock); }
        catch(e) { console.error('[Elementor] Bot trigger:', e.message); }
      }, 2000);
    }

    res.json({ ok: true, contactId: contact.id });
  } catch(e) {
    console.error('[Elementor webhook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Import Contacts from Excel/XLS ──────────────────────────────────────────
const multer   = require('multer');
const XLSX     = require('xlsx');
const iconvLite = require('iconv-lite');
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Read workbook with smart encoding detection for CSV files
function readWorkbook(buffer, originalname) {
  const ext = ((originalname || '').split('.').pop() || '').toLowerCase();
  if (ext === 'csv') {
    // Check for UTF-8 BOM
    const hasUtf8Bom = buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
    let csvStr;
    if (hasUtf8Bom) {
      csvStr = buffer.slice(3).toString('utf8');
    } else {
      // Try UTF-8; if replacement chars appear, fall back to Windows-1255
      const utf8Try = buffer.toString('utf8');
      if (utf8Try.includes('\uFFFD')) {
        csvStr = iconvLite.decode(buffer, 'windows-1255');
      } else {
        csvStr = utf8Try;
      }
    }
    const wb2 = XLSX.read(csvStr, { type: 'string' });
    // Convert all numeric cells to strings so phone numbers keep their leading zeros
    const ws2 = wb2.Sheets[wb2.SheetNames[0]];
    Object.keys(ws2).filter(k => k[0] !== '!').forEach(k => {
      if (ws2[k].t === 'n') { ws2[k].t = 's'; ws2[k].v = String(ws2[k].v); delete ws2[k].w; }
    });
    return wb2;
  }
  // Excel files — use buffer mode (xlsx handles xls/xlsx natively)
  return XLSX.read(buffer, { type: 'buffer' });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s\-\+\(\)]+$/;
const EMAIL_TYPOS = { 'gnail.com':'gmail.com','gmai.com':'gmail.com','gamil.com':'gmail.com','gmial.com':'gmail.com','yahooo.com':'yahoo.com','hotmial.com':'hotmail.com','hotmaill.com':'hotmail.com','walll.co.il':'walla.co.il','wala.co.il':'walla.co.il' };

function normPhone(v) {
  if (!v) return '';
  let d = String(v).replace(/[^\d]/g, '');
  if (d.startsWith('972') && d.length >= 11) d = '0' + d.slice(3);
  // Restore leading 0 for Israeli mobiles that lost it (e.g. xlsx parsed 0527… as number 527…)
  if (d.length === 9 && /^[5-9]/.test(d)) d = '0' + d;
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 9)  return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
  return String(v).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').trim();
}

function fixEmail(email) {
  if (!email) return { val:'', fix:null };
  const e = String(email).trim().toLowerCase();
  const domain = e.split('@')[1]||'';
  if (EMAIL_TYPOS[domain]) return { val: e.replace(domain, EMAIL_TYPOS[domain]), fix:`תוקן: ${domain} → ${EMAIL_TYPOS[domain]}` };
  return { val: e, fix: null };
}

function detectColumns(headers) {
  const map = { firstName:null, lastName:null, phone:null, email:null, role:null, org:null, city:null, source:null, status:null, birthday:null, tags:null, notes:null };
  const unrecognized = [];
  headers.forEach((h, i) => {
    const s = (h||'').toString().trim().toLowerCase();
    if (!s) return; // skip empty headers
    if (/שם.פרטי|first.?name/.test(s))             map.firstName = i;
    else if (/שם.משפחה|last.?name/.test(s))         map.lastName  = i;
    else if (/שם.מלא|full.?name/.test(s))            map.firstName = i;
    else if (/^טלפון|^phone|^mobile|^נייד/.test(s)) map.phone     = i;
    else if (/מייל|email|דואר/.test(s))              map.email     = i;
    else if (/תפקיד|role|title/.test(s))             map.role      = i;
    else if (/ארגון|org|company|חברה/.test(s))       map.org       = i;
    else if (/עיר|city/.test(s))                     map.city      = i;
    else if (/מקור|source/.test(s))                  map.source    = i;
    else if (/סטטוס|status/.test(s))                 map.status    = i;
    else if (/יום.הולדת|birthday|birth/.test(s))     map.birthday  = i;
    else if (/תגיות|tags/.test(s))                   map.tags      = i;
    else if (/הערות|notes/.test(s))                  map.notes     = i;
    else unrecognized.push({ col: (h||'').toString().trim(), index: i });
  });
  return { map, unrecognized };
}

function processRow(raw, map, idx) {
  const get = (k) => map[k] !== null && map[k] !== undefined ? (raw[map[k]]||'').toString().trim() : '';

  let firstName = get('firstName'), lastName = get('lastName');
  // If only full name, split it
  if (firstName && !lastName && map.lastName === null) {
    const parts = firstName.split(/\s+/);
    firstName = parts[0]; lastName = parts.slice(1).join(' ');
  }

  let rawPhone = get('phone'), rawEmail = get('email');
  const fixes = [];
  const warnings = [];

  // Clean invisible chars from phone
  const cleanPhone = rawPhone.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u00a0]/g,'').trim();
  if (cleanPhone !== rawPhone && rawPhone) fixes.push('הוסרו תווים בלתי נראים מהטלפון');
  rawPhone = cleanPhone;

  // Auto-detect phone/email swap
  if (rawPhone && rawEmail) {
    const phoneHasAt = rawPhone.includes('@');
    const emailIsNumeric = PHONE_RE.test(rawEmail.replace(/-/g,''));
    if (phoneHasAt && emailIsNumeric) {
      [rawPhone, rawEmail] = [rawEmail, rawPhone];
      fixes.push('תוקן: שדות טלפון ומייל הוחלפו');
    }
  } else if (rawPhone && rawPhone.includes('@') && !rawEmail) {
    rawEmail = rawPhone; rawPhone = '';
    fixes.push('תוקן: מייל היה בשדה טלפון');
  } else if (rawEmail && PHONE_RE.test(rawEmail.replace(/-/g,'')) && !rawPhone) {
    rawPhone = rawEmail; rawEmail = '';
    fixes.push('תוקן: טלפון היה בשדה מייל');
  }

  // Fix email typos
  const { val: fixedEmail, fix: emailFix } = fixEmail(rawEmail);
  if (emailFix) fixes.push(emailFix);

  // Normalize phone
  const normPhoneVal = normPhone(rawPhone);

  // Validate
  if (fixedEmail && !EMAIL_RE.test(fixedEmail)) warnings.push(`מייל לא תקין: ${fixedEmail}`);
  if (!firstName) warnings.push('חסר שם פרטי');

  // Birthday — accept MM-DD, DD/MM, DD.MM
  let birthday = get('birthday');
  if (birthday) {
    const bm = birthday.match(/^(\d{1,2})[\/\.\-](\d{1,2})$/);
    if (bm) {
      const [_, a, b] = bm;
      // Heuristic: if first number > 12 it's day, else could be MM-DD or DD/MM
      // Our format is MM-DD, so keep as-is if looks like MM-DD
      birthday = `${String(parseInt(a)).padStart(2,'0')}-${String(parseInt(b)).padStart(2,'0')}`;
    }
  }

  const tags = (get('tags')||'').split(/[,;]/).map(t=>t.trim()).filter(Boolean);

  return {
    _row: idx,
    firstName, lastName,
    name: [firstName, lastName].filter(Boolean).join(' '),
    phone: normPhoneVal,
    email: fixedEmail,
    role: get('role'),
    organizationName: get('org'),
    city: get('city'),
    source: get('source'),
    status: get('status') || 'lead',
    birthday,
    tags,
    notes: get('notes'),
    _fixes: fixes,
    _warnings: warnings,
    _ok: warnings.length === 0,
  };
}

// Analyze endpoint — fast, returns only headers + sample row + detected mapping
app.post('/api/import-contacts/analyze', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא התקבל קובץ' });
    const wb = readWorkbook(req.file.buffer, req.file.originalname);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 1) return res.status(400).json({ error: 'הקובץ ריק' });
    const headers   = rows[0].map(h => (h||'').toString().trim());
    const sampleRow = (rows[1] || []).map(c => (c||'').toString().trim());
    const { map, unrecognized } = detectColumns(headers);
    res.json({ headers, sampleRow, map, unrecognized });
  } catch(e) {
    console.error('[import analyze]', e);
    res.status(500).json({ error: 'שגיאה בקריאת הקובץ: ' + e.message });
  }
});

app.post('/api/import-contacts/preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא התקבל קובץ' });
    const wb   = readWorkbook(req.file.buffer, req.file.originalname);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) return res.status(400).json({ error: 'הקובץ ריק' });

    const headers = rows[0].map(h => (h||'').toString().trim());
    let { map, unrecognized } = detectColumns(headers);

    // If a custom mapping was submitted, override the detected map
    if (req.body && req.body.customMap) {
      try {
        const cm = JSON.parse(req.body.customMap);
        // Reset map to nulls first, then apply custom
        Object.keys(map).forEach(k => { map[k] = null; });
        Object.entries(cm).forEach(([field, colIdx]) => {
          if (field in map && colIdx !== null && colIdx !== undefined) map[field] = parseInt(colIdx);
        });
        unrecognized = [];
      } catch(e2) { /* ignore bad customMap, use auto-detected */ }
    }

    if (map.firstName === null && map.phone === null && map.email === null)
      return res.status(400).json({ error: 'לא ניתן לזהות עמודות — ודא שיש כותרות בשורה הראשונה' });

    const existing  = rj('contacts.json', []);
    const existPhones = new Set(existing.map(c => normPhone(c.phone)).filter(Boolean));
    const existEmails = new Set(existing.map(c => (c.email||'').toLowerCase()).filter(Boolean));
    // Name-based duplicate detection (first+last or full name)
    const existNames = new Set(existing.map(c => {
      const n = (c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')).trim().toLowerCase();
      return n;
    }).filter(Boolean));

    const processed = rows.slice(1)
      .filter(r => r.some(c => (c||'').toString().trim()))
      .map((r, i) => {
        const row = processRow(r, map, i + 2);
        const fullName = row.name.trim().toLowerCase();
        if (row.phone && existPhones.has(normPhone(row.phone))) row._duplicate = 'טלפון קיים במערכת';
        else if (row.email && existEmails.has(row.email.toLowerCase())) row._duplicate = 'מייל קיים במערכת';
        else if (fullName && existNames.has(fullName)) row._duplicate = 'שם קיים במערכת';
        return row;
      });

    res.json({ headers, map, unrecognized, rows: processed, total: processed.length,
      fixCount: processed.filter(r=>r._fixes.length).length,
      warnCount: processed.filter(r=>r._warnings.length).length,
      dupCount:  processed.filter(r=>r._duplicate).length });
  } catch (e) {
    console.error('[import preview]', e);
    res.status(500).json({ error: 'שגיאה בקריאת הקובץ: ' + e.message });
  }
});

app.post('/api/import-contacts/confirm', express.json({ limit: '5mb' }), (req, res) => {
  try {
    const { rows, skipDuplicates = true, linkToShowId = null } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'נתונים לא תקינים' });

    const existing = rj('contacts.json', []);
    const existPhones = new Set(existing.map(c => normPhone(c.phone)).filter(Boolean));
    const existEmails = new Set(existing.map(c => (c.email||'').toLowerCase()).filter(Boolean));

    let added = 0, skipped = 0;
    const newIds = [];      // IDs of newly created contacts
    const allLinkedIds = []; // IDs to link to show (new + existing duplicates)

    // Build phone→id and email→id maps for existing contacts (for show linking of duplicates)
    const phoneToId = {};
    const emailToId = {};
    existing.forEach(c => {
      const np = normPhone(c.phone); if (np) phoneToId[np] = c.id;
      const em = (c.email||'').toLowerCase(); if (em) emailToId[em] = c.id;
    });

    rows.forEach(row => {
      if (!row.name && !row.phone) return;
      if (skipDuplicates) {
        const np = normPhone(row.phone);
        const em = (row.email||'').toLowerCase();
        if (row.phone && existPhones.has(np)) {
          skipped++;
          if (linkToShowId && phoneToId[np]) {
            allLinkedIds.push(phoneToId[np]);
            // תקן פורמט טלפון של קשר קיים אם שונה
            const ec = existing.find(c => c.id === phoneToId[np]);
            if (ec && row.phone && ec.phone !== row.phone) ec.phone = row.phone;
          }
          return;
        }
        if (row.email && existEmails.has(em)) {
          skipped++;
          if (linkToShowId && emailToId[em]) {
            allLinkedIds.push(emailToId[em]);
            // תקן פורמט טלפון של קשר קיים אם שונה
            const ec = existing.find(c => c.id === emailToId[em]);
            if (ec && row.phone && ec.phone !== row.phone) ec.phone = row.phone;
          }
          return;
        }
      }
      const contact = { id: uid(), createdAt: today(), conversations: [], showHistory: [], tags: row.tags || [],
        name: row.name, firstName: row.firstName || '', lastName: row.lastName || '',
        phone: row.phone, email: row.email, role: row.role || '', city: row.city || '',
        source: row.source || '', status: row.status || 'lead', birthday: row.birthday || '',
        notes: row.notes || '', nextFollowUp: '', googleContactId: null };
      existing.unshift(contact);
      existPhones.add(normPhone(row.phone));
      if (row.email) existEmails.add(row.email.toLowerCase());
      newIds.push(contact.id);
      allLinkedIds.push(contact.id);
      added++;
    });

    wj('contacts.json', existing);

    // If a show was specified, link all contacts (new + existing duplicates) to it
    if (linkToShowId && allLinkedIds.length > 0) {
      const shows = rj('standalone-shows.json', []);
      const show = shows.find(s => s.id === linkToShowId);
      if (show) {
        const existing_ids = new Set(show.participantContactIds || []);
        allLinkedIds.forEach(id => existing_ids.add(id));
        show.participantContactIds = [...existing_ids];
        wj('standalone-shows.json', shows);
      }
    }

    res.json({ ok: true, added, skipped, linkedToShow: linkToShowId && allLinkedIds.length > 0 });
  } catch (e) {
    console.error('[import confirm]', e);
    res.status(500).json({ error: 'שגיאה בייבוא: ' + e.message });
  }
});

// ─── Migration: נרמל מספרי טלפון קיימים ────────────────────────────────────
(function migratePhones() {
  try {
    const contacts = rj('contacts.json', []);
    let fixed = 0;
    contacts.forEach(c => {
      if (!c.phone) return;
      const normalized = normPhone(c.phone);
      if (normalized && normalized !== c.phone) { c.phone = normalized; fixed++; }
    });
    if (fixed > 0) { wj('contacts.json', contacts); console.log(`[Migration] תוקנו ${fixed} מספרי טלפון לפורמט תקני`); }
  } catch(e) { console.error('[Migration] שגיאה בנרמול טלפונים:', e.message); }
})();

// ─── RSVP System ─────────────────────────────────────────────────────────────
function loadRegistrants()     { return rj('rsvp-registrants.json', []); }
function saveRegistrants(list) { wj('rsvp-registrants.json', list); }

function genRsvpToken() { return crypto.randomBytes(20).toString('hex'); }

function getBaseUrl() { return BASE_URL; }

// שליחת WhatsApp תבנית RSVP
async function sendRsvpWa(templateName, phone, params) {
  try {
    await sendWaTemplate(phone, templateName, 'he', params);
    return true;
  } catch(e) {
    console.error(`[RSVP] שגיאת WA template ${templateName} לטלפון ${phone}:`, e.message);
    return false;
  }
}

// שליחת מייל RSVP
async function sendRsvpEmail({ to, subject, html }) {
  if (!to) return false;
  try { await sendEmail({ to, subject, html }); return true; }
  catch(e) { console.error('[RSVP] שגיאת מייל:', e.message); return false; }
}

// הודעת התראה לירון על ביטול ברגע אחרון
async function notifyOwnerCancellation(registrant, show) {
  const phone = process.env.NOTIFY_PHONE || '972525105100';
  const msg = `⚠️ ביטול ברגע האחרון!\n${registrant.name} ביטל/ה השתתפות ב"${show.showName||show.name}"\nבתאריך ${show.date||''}\nטלפון: ${registrant.phone}`;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method:'POST',
      headers:{'Authorization':`Bearer ${process.env.WA_ACCESS_TOKEN}`,'Content-Type':'application/json'},
      body: JSON.stringify({ messaging_product:'whatsapp', to: phone, type:'text', text:{ body: msg } })
    });
  } catch(e) { console.error('[RSVP] שגיאת התראה:', e.message); }
}

// GET registrants for a show
app.get('/api/shows/:id/registrants', (req, res) => {
  const list = loadRegistrants().filter(r => r.showId === req.params.id);
  res.json(list);
});

// POST add registrant to show
app.post('/api/shows/:id/registrants', async (req, res) => {
  const showId = req.params.id;
  const shows  = rj('standalone-shows.json', []);
  const show   = shows.find(s => s.id === showId);
  if (!show) return res.status(404).json({ error: 'מופע לא נמצא' });

  const { contactId, name, phone, email } = req.body;
  if (!name && !contactId) return res.status(400).json({ error: 'נדרש שם או קשר' });

  // חשב קיבולת
  const regs = loadRegistrants().filter(r => r.showId === showId);
  const confirmed = regs.filter(r => r.status === 'confirmed').length;
  const capacity  = show.capacity ? parseInt(show.capacity) : 0;
  const isFull    = capacity > 0 && confirmed >= capacity;

  let cName = name, cPhone = phone, cEmail = email;
  if (contactId) {
    const contacts = rj('contacts.json', []);
    const c = contacts.find(c => c.id === contactId);
    if (c) { cName = c.name; cPhone = c.phone || phone; cEmail = c.email || email; }
  }

  const registrant = {
    id: uid(), showId, contactId: contactId || null,
    name: cName || '', phone: cPhone || '', email: cEmail || '',
    status: isFull ? 'waitlist' : 'pending',
    waitlistPosition: isFull ? regs.filter(r=>r.status==='waitlist').length + 1 : null,
    guestCount: 0, guests: [],
    token: genRsvpToken(),
    rsvpSentAt: null, reminder1SentAt: null, reminder2SentAt: null,
    dayBeforeSentAt: null, respondedAt: null, addedAt: today(),
  };

  const all = loadRegistrants();
  all.push(registrant);
  saveRegistrants(all);
  res.json({ ok: true, registrant, waitlisted: isFull });
});

// PUT update registrant
app.put('/api/shows/:showId/registrants/:id', (req, res) => {
  const all = loadRegistrants();
  const idx = all.findIndex(r => r.id === req.params.id && r.showId === req.params.showId);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
  all[idx] = { ...all[idx], ...req.body, id: all[idx].id, showId: all[idx].showId };
  saveRegistrants(all);
  res.json({ ok: true, registrant: all[idx] });
});

// DELETE registrant
app.delete('/api/shows/:showId/registrants/:id', (req, res) => {
  let all = loadRegistrants();
  all = all.filter(r => !(r.id === req.params.id && r.showId === req.params.showId));
  saveRegistrants(all);
  res.json({ ok: true });
});

// POST send RSVP to filtered group
app.post('/api/shows/:id/rsvp/send', async (req, res) => {
  const showId = req.params.id;
  const shows  = rj('standalone-shows.json', []);
  const show   = shows.find(s => s.id === showId);
  if (!show) return res.status(404).json({ error: 'מופע לא נמצא' });

  const { filter = 'pending', templateName = 'shakuf_rsvp_request', customMessage } = req.body;
  const all  = loadRegistrants();
  const targets = all.filter(r => r.showId === showId && (filter === 'all' || r.status === filter));
  const base = getBaseUrl();
  let sent = 0;

  for (const r of targets) {
    const link = `${base}/rsvp/${r.token}`;
    const locationLine = show.type === 'virtual'
      ? `💻 זום: ${show.address||''}`
      : `📍 ${show.address||show.venue||''}`;

    // שלח WhatsApp תבנית
    if (r.phone) {
      const ok = await sendRsvpWa(templateName, r.phone, [
        r.name, show.showName||show.name||'', show.date||'',
        show.time||'', locationLine, link
      ]);
      if (ok) {
        const idx = all.findIndex(x=>x.id===r.id);
        all[idx].rsvpSentAt = new Date().toISOString();
        sent++;
      }
    }
    // שלח מייל גם (אם יש)
    if (r.email) {
      await sendRsvpEmail({
        to: r.email,
        subject: `אישור הגעה — ${show.showName||show.name||'מופע'}`,
        html: buildRsvpEmailHtml(r, show, link),
      });
    }
  }
  saveRegistrants(all);
  res.json({ ok: true, sent, total: targets.length });
});

// POST אישור ידני ממתינה לרשימת המתנה
app.post('/api/shows/:showId/registrants/:id/approve-waitlist', async (req, res) => {
  const all = loadRegistrants();
  const idx = all.findIndex(r => r.id === req.params.id && r.showId === req.params.showId);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
  all[idx].status = 'pending';
  all[idx].waitlistPosition = null;
  saveRegistrants(all);
  // שלח לו הודעה שמקום התפנה
  const shows = rj('standalone-shows.json', []);
  const show  = shows.find(s => s.id === req.params.showId);
  if (show && all[idx].phone) {
    const base = getBaseUrl();
    const link = `${base}/rsvp/${all[idx].token}`;
    const expire = new Date(Date.now() + 24*3600000).toLocaleDateString('he-IL');
    await sendRsvpWa('shakuf_rsvp_waitlist', all[idx].phone, [
      all[idx].name, show.showName||show.name||'', show.date||'', expire, link
    ]);
  }
  res.json({ ok: true });
});

// ─── Public RSVP page ─────────────────────────────────────────────────────────
app.get('/rsvp/:token', (req, res) => {
  res.sendFile(path.join(PUB, 'rsvp.html'));
});

// GET token info (public — no auth)
app.get('/api/rsvp/:token', (req, res) => {
  const reg = loadRegistrants().find(r => r.token === req.params.token);
  if (!reg) return res.status(404).json({ error: 'קישור לא תקין' });
  const shows = rj('standalone-shows.json', []);
  const show  = shows.find(s => s.id === reg.showId);
  if (!show) return res.status(404).json({ error: 'מופע לא נמצא' });
  // לא מחזירים token לשרת
  const { token: _t, ...safeReg } = reg;
  res.json({ registrant: safeReg, show });
});

// POST respond to RSVP (public — no auth)
app.post('/api/rsvp/:token', async (req, res) => {
  const all = loadRegistrants();
  const idx = all.findIndex(r => r.token === req.params.token);
  if (idx === -1) return res.status(404).json({ error: 'קישור לא תקין' });

  const reg = all[idx];
  const shows = rj('standalone-shows.json', []);
  const show  = shows.find(s => s.id === reg.showId);
  if (!show) return res.status(404).json({ error: 'מופע לא נמצא' });

  // בדוק שהמופע לא עבר
  if (show.date && show.date < today()) {
    return res.status(400).json({ error: 'המופע כבר עבר — לא ניתן לשנות תשובה' });
  }

  const { action, guestCount, guests } = req.body; // action: confirm|decline
  const wasConfirmed = reg.status === 'confirmed';
  const now = new Date().toISOString();

  if (action === 'confirm') {
    all[idx].status      = 'confirmed';
    all[idx].respondedAt = now;
    all[idx].guestCount  = parseInt(guestCount) || 0;
    all[idx].guests      = guests || [];

    // הוסף אורחים כאנשי קשר
    if (guests && guests.length > 0) {
      const contacts = rj('contacts.json', []);
      for (const g of guests) {
        if (!g.name || !g.phone) continue;
        // בדוק אם כבר קיים
        const exists = contacts.find(c => normPhoneCrm(c.phone||'') === normPhoneCrm(g.phone));
        if (!exists) {
          const newContact = {
            id: uid(), name: g.name, phone: g.phone, email: '',
            status: 'warm', source: `אורח ל${show.showName||'מופע'}`,
            notes: `הגיע כאורח של ${reg.name}`,
            conversations:[], showHistory:[], tags:['אורח'],
            organizationId: null, googleContactId: null, createdAt: today(),
          };
          contacts.push(newContact);
          // קשר לכרטיס המופע
          const si = shows.findIndex(s => s.id === reg.showId);
          if (si !== -1) {
            if (!shows[si].participantContactIds) shows[si].participantContactIds = [];
            shows[si].participantContactIds.push(newContact.id);
          }
          all[idx].guests = all[idx].guests.map(gg =>
            gg.phone === g.phone ? { ...gg, contactId: newContact.id } : gg
          );
          g.contactId = newContact.id;
        }
      }
      wj('contacts.json', contacts);
      wj('standalone-shows.json', shows);
    }

    saveRegistrants(all);

    // שלח אישור
    const base = getBaseUrl();
    const locationLine = show.type === 'virtual'
      ? `💻 קישור זום: ${show.address||''}`
      : `📍 ${show.address||show.venue||''}\n🗺️ Waze: ${show.wazeLink||''}`;
    if (reg.phone) {
      await sendRsvpWa('shakuf_rsvp_confirmed', reg.phone, [
        reg.name, show.showName||show.name||'', show.date||'', show.time||'', locationLine
      ]);
    }
    if (reg.email) {
      await sendRsvpEmail({
        to: reg.email,
        subject: `✅ אישרת הגעה — ${show.showName||show.name||'מופע'}`,
        html: buildRsvpConfirmedEmailHtml(all[idx], show),
      });
    }
    return res.json({ ok: true, action: 'confirmed' });
  }

  if (action === 'decline') {
    all[idx].status      = 'declined';
    all[idx].respondedAt = now;
    saveRegistrants(all);

    // בדוק ביטול ברגע האחרון (<48 שעות)
    if (show.date) {
      const showDate = new Date(show.date + (show.time ? `T${show.time}` : 'T00:00'));
      const hoursLeft = (showDate - Date.now()) / 3600000;
      if (hoursLeft < 48 && hoursLeft > 0) {
        await notifyOwnerCancellation(all[idx], show);
      }
    }

    // שלח אישור ביטול
    const base = getBaseUrl();
    const reconfirmLink = `${base}/rsvp/${req.params.token}`;
    if (reg.phone) {
      await sendRsvpWa('shakuf_rsvp_cancelled', reg.phone, [
        reg.name, show.showName||show.name||'', show.date||'', reconfirmLink
      ]);
    }
    if (reg.email) {
      await sendRsvpEmail({
        to: reg.email,
        subject: `ביטול הגעה — ${show.showName||show.name||'מופע'}`,
        html: buildRsvpCancelledEmailHtml(all[idx], show, reconfirmLink),
      });
    }

    // קדם אוטומטית מרשימת המתנה אם מקום התפנה
    const capacity = show.capacity ? parseInt(show.capacity) : 0;
    if (capacity > 0 && wasConfirmed) {
      const remaining = all.filter(r=>r.showId===reg.showId&&r.status==='confirmed').length;
      if (remaining < capacity) {
        const nextWaiting = all.filter(r=>r.showId===reg.showId&&r.status==='waitlist')
          .sort((a,b)=>(a.waitlistPosition||0)-(b.waitlistPosition||0))[0];
        if (nextWaiting) {
          const wi = all.findIndex(r=>r.id===nextWaiting.id);
          all[wi].status = 'pending';
          all[wi].waitlistPosition = null;
          saveRegistrants(all);
          const expire = new Date(Date.now() + 24*3600000).toLocaleDateString('he-IL');
          if (nextWaiting.phone) {
            await sendRsvpWa('shakuf_rsvp_waitlist', nextWaiting.phone, [
              nextWaiting.name, show.showName||show.name||'', show.date||'',
              expire, `${getBaseUrl()}/rsvp/${nextWaiting.token}`
            ]);
          }
        }
      }
    }
    return res.json({ ok: true, action: 'declined' });
  }

  res.status(400).json({ error: 'פעולה לא חוקית' });
});

// ─── RSVP Email HTML builders ─────────────────────────────────────────────────
function buildRsvpEmailHtml(reg, show, confirmLink) {
  const loc = show.type==='virtual'
    ? `<p>💻 <strong>קישור זום:</strong> <a href="${show.address||''}">${show.address||''}</a></p>`
    : `<p>📍 <strong>מיקום:</strong> ${show.address||show.venue||''}</p>`;
  return `<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:12px">
    <h2 style="color:#1e293b">🎭 ${show.showName||show.name||'מופע'}</h2>
    <p>שלום ${reg.name},</p>
    <p>נרשמת למופע <strong>${show.showName||show.name||''}</strong>.</p>
    <p>📅 <strong>תאריך:</strong> ${show.date||''}</p>
    <p>🕐 <strong>שעה:</strong> ${show.time||''}</p>
    ${loc}
    <a href="${confirmLink}" style="display:inline-block;margin:20px 0;padding:14px 28px;background:#6366f1;color:white;text-decoration:none;border-radius:8px;font-weight:700">אשר הגעה →</a>
    <p style="color:#94a3b8;font-size:12px">— ירון אנטניר · שקוף בחזית</p>
  </div>`;
}

function buildRsvpConfirmedEmailHtml(reg, show) {
  const loc = show.type==='virtual'
    ? `<p>💻 <strong>קישור זום:</strong> <a href="${show.address||''}">${show.address||''}</a></p>`
    : `<p>📍 <strong>כתובת:</strong> ${show.address||show.venue||''}</p>${show.wazeLink?`<p><a href="${show.wazeLink}">🗺️ נווט ב-Waze</a></p>`:''}`;
  return `<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto;padding:32px;border:1px solid #86efac;border-radius:12px;background:#f0fdf4">
    <h2 style="color:#166534">✅ אישרת הגעה!</h2>
    <p>שלום ${reg.name}, כיף שתהיה/י!</p>
    <p><strong>${show.showName||show.name||''}</strong></p>
    <p>📅 ${show.date||''} 🕐 ${show.time||''}</p>
    ${loc}
    <p style="color:#94a3b8;font-size:12px">— ירון אנטניר · שקוף בחזית</p>
  </div>`;
}

function buildRsvpCancelledEmailHtml(reg, show, reconfirmLink) {
  return `<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:12px">
    <h2 style="color:#1e293b">ביטול הגעה</h2>
    <p>שלום ${reg.name}, קיבלנו את ביטולך ל<strong>${show.showName||show.name||''}</strong> בתאריך ${show.date||''}.</p>
    <p>שינית את דעתך? תוכל/י לאשר מחדש עד יום המופע:</p>
    <a href="${reconfirmLink}" style="display:inline-block;margin:16px 0;padding:12px 24px;background:#6366f1;color:white;text-decoration:none;border-radius:8px">שנה תשובה →</a>
    <p style="color:#94a3b8;font-size:12px">— ירון אנטניר · שקוף בחזית</p>
  </div>`;
}

// ─── RSVP Scheduler (פועל כל שעה) ────────────────────────────────────────────
async function runRsvpScheduler() {
  try {
    const shows = rj('standalone-shows.json', []);
    const all   = loadRegistrants();
    const now   = Date.now();
    let changed = false;

    for (const show of shows) {
      if (!show.rsvpEnabled || !show.date) continue;
      const showDate   = new Date(show.date + 'T' + (show.time||'00:00'));
      const daysLeft   = (showDate - now) / 86400000;
      const rsvpDays   = parseInt(show.rsvpDaysBefore  || 14);
      const rem1Days   = parseInt(show.reminder1DaysAfter || 7);
      const rem2Days   = parseInt(show.reminder2DaysBefore || 2);
      const base       = getBaseUrl();

      for (let i=0; i<all.length; i++) {
        const r = all[i];
        if (r.showId !== show.id) continue;
        if (r.status === 'waitlist') continue;

        const link = `${base}/rsvp/${r.token}`;
        const loc  = show.type==='virtual'
          ? `💻 זום: ${show.address||''}`
          : `📍 ${show.address||show.venue||''}`;

        // שלח RSVP ראשוני
        if (!r.rsvpSentAt && daysLeft <= rsvpDays && daysLeft > 0) {
          if (r.phone) {
            await sendRsvpWa('shakuf_rsvp_request', r.phone, [
              r.name, show.showName||show.name||'', show.date||'', show.time||'', loc, link
            ]);
          }
          if (r.email) await sendRsvpEmail({ to:r.email, subject:`אישור הגעה — ${show.showName||'מופע'}`, html:buildRsvpEmailHtml(r,show,link) });
          all[i].rsvpSentAt = new Date().toISOString();
          changed = true;
        }

        // תזכורת 1 — למי שלא ענה
        if (r.status==='pending' && r.rsvpSentAt && !r.reminder1SentAt) {
          const sentAt = new Date(r.rsvpSentAt);
          const daysSinceSent = (now - sentAt) / 86400000;
          if (daysSinceSent >= rem1Days && daysLeft > rem2Days) {
            if (r.phone) await sendRsvpWa('shakuf_rsvp_followup', r.phone, [r.name, show.showName||show.name||'', show.date||'', link]);
            all[i].reminder1SentAt = new Date().toISOString();
            changed = true;
          }
        }

        // תזכורת 2 — X ימים לפני
        if (r.status==='pending' && !r.reminder2SentAt && daysLeft <= rem2Days && daysLeft > 0) {
          if (r.phone) await sendRsvpWa('shakuf_rsvp_followup', r.phone, [r.name, show.showName||show.name||'', show.date||'', link]);
          all[i].reminder2SentAt = new Date().toISOString();
          changed = true;
        }

        // יום לפני — למאשרים
        if (r.status==='confirmed' && !r.dayBeforeSentAt && daysLeft <= 1 && daysLeft > 0) {
          const locFull = show.type==='virtual'
            ? `💻 קישור זום: ${show.address||''}`
            : `📍 ${show.address||show.venue||''}\n🗺️ Waze: ${show.wazeLink||''}`;
          if (r.phone) await sendRsvpWa('shakuf_rsvp_reminder', r.phone, [
            r.name, show.showName||show.name||'', show.date||'', show.time||'', locFull
          ]);
          if (r.email) await sendRsvpEmail({
            to:r.email, subject:`תזכורת מחר — ${show.showName||'מופע'}`,
            html: buildRsvpConfirmedEmailHtml(r,show)
          });
          all[i].dayBeforeSentAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    if (changed) saveRegistrants(all);
  } catch(e) { console.error('[RSVP Scheduler]', e.message); }
}

// הרץ scheduler כל שעה
setInterval(runRsvpScheduler, 60 * 60 * 1000);
setTimeout(runRsvpScheduler, 30000); // הרץ גם 30 שניות לאחר אתחול

// ─── Help Center API ──────────────────────────────────────────────────────────
function loadHelp()      { return rj('help.json', null); }
function saveHelp(data)  { wj('help.json', data); }

function initHelp() {
  if (loadHelp() !== null) return;
  const articles = [
    { id:'h1', type:'guide', category:'contacts', status:'published', title:'איך מוסיפים איש קשר חדש', content:'ניתן להוסיף איש קשר חדש ישירות מהלשונית "אנשי קשר" בסרגל הצד.', steps:['לחץ על "👤 אנשי קשר" בסרגל השמאלי','לחץ על כפתור "+ חדש" בפינה הימנית עליונה','מלא שם, טלפון ואימייל','בחר סטטוס (חם / קר / VIP וכד\')','לחץ "שמור"'], link:'', tags:['איש קשר','הוספה','חדש'], createdAt:today() },
    { id:'h2', type:'guide', category:'quotes', status:'published', title:'איך יוצרים הצעת מחיר', content:'ניתן ליצור הצעת מחיר מכרטיס איש קשר או ישירות מלשונית הצעות מחיר.', steps:['כנס לכרטיס איש קשר','לחץ על "📄 הצעת מחיר" בתפריט הכרטיס','בחר שם מופע, תאריך ומחיר','הוסף פריטים נוספים לפי הצורך','לחץ "שמור ושלח" לשליחה במייל'], link:'', tags:['הצעת מחיר','מחיר','שליחה'], createdAt:today() },
    { id:'h3', type:'guide', category:'whatsapp', status:'published', title:'איך שולחים הודעת WhatsApp', content:'המערכת מאפשרת שליחת הודעות WhatsApp ישירות מכרטיס איש קשר.', steps:['כנס לכרטיס איש קשר','לחץ על כפתור "📲 WhatsApp"','כתוב את ההודעה או בחר תבנית','לחץ "שלח"'], link:'', tags:['וואטסאפ','הודעה','שליחה'], createdAt:today() },
    { id:'h4', type:'guide', category:'tasks', status:'published', title:'איך יוצרים משימה או אירוע', content:'ניתן ליצור משימות ואירועים מלשונית המשימות או מכרטיס איש קשר.', steps:['לחץ על "📋 משימות" בסרגל','לחץ "+ חדש"','בחר סוג: משימה / אירוע / פגישה','הכנס כותרת, תאריך ותיאור','שמור — האירוע יסונכרן לגוגל קלנדר אוטומטית'], link:'', tags:['משימה','אירוע','לוח שנה'], createdAt:today() },
    { id:'h5', type:'guide', category:'orgs', status:'published', title:'איך מוסיפים ארגון', content:'ארגונים מאפשרים לקשר מספר אנשי קשר לאותו גוף (עירייה, חברה וכד\').', steps:['לחץ על "🏢 ארגונים" בסרגל','לחץ "+ חדש"','הכנס שם ארגון, תחום ופרטי קשר','שמור','כדי לקשר איש קשר לארגון — כנס לכרטיס איש הקשר ובחר ארגון'], link:'', tags:['ארגון','חברה','עירייה'], createdAt:today() },
    { id:'h6', type:'guide', category:'settings', status:'published', title:'איך מגדירים חתימה לאימייל', content:'ניתן להגדיר חתימות שיצורפו אוטומטית לאימיילים ולהצעות מחיר.', steps:['כנס להגדרות → 📄 הצעות מחיר','גלול למטה לקטע "חתימות"','לחץ "+ חתימה חדשה"','כתוב את הטקסט ובחר האם זו ברירת המחדל','שמור'], link:'', tags:['חתימה','מייל','הגדרות'], createdAt:today() },
    { id:'h7', type:'guide', category:'settings', status:'published', title:'איך מוסיפים משתמש למערכת', content:'כמנהל ראשי תוכל להזמין אנשים נוספים לעבוד עם המערכת.', steps:['כנס להגדרות → 👥 משתמשים','לחץ "+ הוסף משתמש"','הכנס שם ואימייל','הסיסמה נוצרת אוטומטית (ניתן לשנות)','לחץ "צור משתמש" — נשלח מייל ברוכים הבאים אוטומטית'], link:'', tags:['משתמש','הרשאות','כניסה'], createdAt:today() },
    { id:'h8', type:'qa', category:'contacts', status:'published', title:'איך מוחקים איש קשר?', content:'כנס לכרטיס איש הקשר → לחץ על "⋮" (שלוש נקודות) בפינה הימנית עליונה → בחר "מחק".\n\n⚠️ מחיקה היא פעולה בלתי הפיכה.', steps:[], link:'', tags:['מחיקה','איש קשר'], createdAt:today() },
    { id:'h9', type:'qa', category:'contacts', status:'published', title:'מה ההבדל בין סטטוסים: חם / קר / VIP?', content:'**קר** — ליד שיצרנו קשר ראשוני, עוד לא הייתה תגובה חיובית.\n**חם** — מתעניין, יש שיחה פעילה.\n**VIP** — לקוח חשוב, חוזר, שגריר.\n**בוקינג** — נסגרה עסקה, יש תאריך מופע.\n**לא רלוונטי** — לא מתאים כרגע.', steps:[], link:'', tags:['סטטוס','חם','קר','VIP'], createdAt:today() },
    { id:'h10', type:'qa', category:'settings', status:'published', title:'איך מסנכרנים עם גוגל?', content:'**חיבור ראשוני:**\nכנס להגדרות → 🔗 גוגל וסנכרון → לחץ "התחבר עם Google".\n\nלאחר החיבור הסנכרון הוא אוטומטי:\n- כל שינוי ב-CRM נדחף לגוגל מיד\n- משיכה מגוגל כל 5 דקות\n\n**סנכרון ידני:** לחץ "סנכרן עכשיו" בכל אחד מהחלקים.', steps:[], link:'', tags:['גוגל','סנכרון','קלנדר'], createdAt:today() },
    ...rsvpHelpArticles(),
  ];
  saveHelp(articles);
}

function rsvpHelpArticles() {
  return [
    {
      id:'h_rsvp1', type:'guide', category:'rsvp', status:'published',
      title:'מה זה RSVP ואיך זה עובד במערכת?',
      content:'RSVP (מצרפתית: Répondez s\'il vous plaît — "אנא השב") הוא מנגנון לאישורי הגעה לאירועים.\n\nכשמפעילים RSVP על מופע, המערכת:\n1. שולחת אוטומטית בקשת אישור לכל הנרשמים (WhatsApp + מייל)\n2. כל נרשם מקבל קישור אישי לדף אישור הגעה\n3. הנרשם לוחץ "כן מגיע" / "לא מגיע" — ומציין אם יביא אורחים\n4. המערכת מעדכנת את הסטטוס אוטומטית\n5. נשלחות תזכורות אוטומטיות לפי ההגדרות',
      steps:[
        'הפעל RSVP על המופע (עריכת מופע → מתג RSVP)',
        'הוסף נרשמים לרשימה (ידנית או מאנשי קשר)',
        'לחץ "שלח RSVP לממתינים" בלשונית RSVP',
        'הנרשמים מקבלים הודעה עם קישור אישי',
        'עקוב אחר הסטטוסים בלשונית RSVP'
      ],
      link:'', tags:['rsvp','אישור הגעה','מופע'], createdAt:today()
    },
    {
      id:'h_rsvp2', type:'guide', category:'rsvp', status:'published',
      title:'הגדרת RSVP למופע חדש',
      content:'כדי להפעיל אישורי הגעה על מופע, יש להגדיר את הפרמטרים הנכונים בטופס המופע.',
      steps:[
        'כנס ל"🎤 אירועים" ולחץ "+ מופע חדש" (או ערוך מופע קיים)',
        'גלול לקטע "📋 הגדרות אישורי הגעה (RSVP)"',
        'בחר סוג אירוע: פיזי (מקום) או וירטואלי (זום)',
        'הכנס קישור Waze (לאירוע פיזי) או קישור זום (לוירטואלי)',
        'הגדר קיבולת — מספר המקסימלי של נרשמים (רשות)',
        'הפעל את מתג ה-RSVP (⭕ כבוי → ✅ פעיל)',
        'קבע כמה ימים לפני האירוע לשלוח את הבקשה (ברירת מחדל: 14)',
        'קבע תזמון לתזכורת 1 (ימים אחרי השליחה, ברירת מחדל: 7)',
        'קבע תזמון לתזכורת 2 (ימים לפני האירוע, ברירת מחדל: 2)',
        'שמור את המופע'
      ],
      link:'', tags:['rsvp','הגדרה','מופע','הפעלה'], createdAt:today()
    },
    {
      id:'h_rsvp3', type:'guide', category:'rsvp', status:'published',
      title:'ניהול רשימת הרשומים',
      content:'לשונית RSVP בחלון פרטי המופע מציגה את כל הנרשמים ומאפשרת לנהל אותם בקלות.',
      steps:[
        'לחץ על המופע הרצוי ברשימת האירועים',
        'בחלון שנפתח, לחץ על לשונית "📋 RSVP"',
        'בחלק העליון: 4 כרטיסי סטטיסטיקה — לחיצה עליהם מסננת את הרשימה',
        'לחץ "+ הוסף רשום" כדי להוסיף נרשם ידנית (שם, טלפון, מייל)',
        'בכל שורה ניתן: 🔗 להעתיק קישור RSVP אישי, ✕ להסיר מהרשימה',
        'לנרשמים ברשימת המתנה — יופיע כפתור "✔ אשר" לאישור ידני'
      ],
      link:'', tags:['rsvp','רשומים','ניהול','רשימה'], createdAt:today()
    },
    {
      id:'h_rsvp4', type:'guide', category:'rsvp', status:'published',
      title:'שליחת בקשת אישור הגעה',
      content:'ניתן לשלוח בקשות RSVP ידנית בכל עת, בנוסף לשליחה האוטומטית של המערכת.',
      steps:[
        'פתח את חלון פרטי המופע ועבור ללשונית "📋 RSVP"',
        'לחץ "📤 שלח RSVP לממתינים" — ישלח רק לנרשמים שטרם קיבלו הודעה',
        'לחץ "📤 שלח לכולם" — ישלח לכל הנרשמים (כולל מי שכבר ענה)',
        'כל נרשם שיש לו טלפון — יקבל הודעת WhatsApp עם קישור אישי',
        'כל נרשם שיש לו מייל — יקבל גם מייל עם קישור אישי',
        'הקישור מוביל לדף אישור אישי: הנרשם בוחר כן/לא ומציין אורחים'
      ],
      link:'', tags:['rsvp','שליחה','whatsapp','מייל'], createdAt:today()
    },
    {
      id:'h_rsvp5', type:'guide', category:'rsvp', status:'published',
      title:'קיבולת ורשימת המתנה',
      content:'כאשר מוגדרת קיבולת מקסימלית למופע, המערכת מנהלת רשימת המתנה אוטומטית.',
      steps:[
        'הגדר קיבולת בשדה "קיבולת (מקסימום נרשמים)" בטופס המופע',
        'כשמספר המאשרים מגיע לקיבולת — נרשמים נוספים שמאשרים נכנסים לרשימת המתנה',
        'בלשונית RSVP ניתן לראות את כרטיס "📋 רשימת המתנה" עם מספר הממתינים',
        'אם נרשם מאשר מבטל — הראשון ברשימת ההמתנה (לפי סדר הרישום) מקודם אוטומטית',
        'לאישור ידני: לחץ "✔ אשר" ליד הנרשם ברשימת ההמתנה',
        'ביטול פחות מ-48 שעות לפני המופע — תישלח אליך התראה ב-WhatsApp'
      ],
      link:'', tags:['rsvp','קיבולת','המתנה','ביטול'], createdAt:today()
    },
    {
      id:'h_rsvp6', type:'qa', category:'rsvp', status:'published',
      title:'מה קורה כשנרשם לוחץ "לא מגיע"?',
      content:'כשנרשם מאשר שאינו מגיע:\n\n✅ הסטטוס שלו משתנה ל"לא מגיע" ברשימה\n✅ אם הייתה הגעה מאושרת קודמת — המקום מתפנה\n✅ הראשון ברשימת ההמתנה מקבל הצעה לתפוס את המקום\n✅ אם הביטול בפחות מ-48 שעות — תשלח אליך התראה ב-WhatsApp\n\nהנרשם עצמו מקבל מייל/הודעה שמאשר את הביטול.',
      steps:[], link:'', tags:['rsvp','ביטול','לא מגיע','התראה'], createdAt:today()
    },
    {
      id:'h_rsvp7', type:'qa', category:'rsvp', status:'published',
      title:'האם נרשם יכול לציין שמביא אורחים?',
      content:'כן! בדף האישור האישי (הקישור שנשלח לנרשם), לאחר שלוחץ "כן, מגיע" מופיע שדה:\n\n"מביא אורחים? כמה?"\n\nהנרשם מכניס את מספר האורחים ושמותיהם.\nהאורחים מתווספים אוטומטית לרשימת אנשי הקשר ב-CRM.\n\nבכרטיסי הסטטיסטיקה ניתן לראות: "3 אישרו (5 מושבים)" — מה שמשקף את המספר האמיתי של הנוכחים.',
      steps:[], link:'', tags:['rsvp','אורחים','אישור','מושבים'], createdAt:today()
    },
    {
      id:'h_rsvp8', type:'qa', category:'rsvp', status:'published',
      title:'מתי נשלחות התזכורות האוטומטיות?',
      content:'המערכת שולחת תזכורות אוטומטיות לנרשמים שעדיין לא ענו ("ממתינים").\n\nשתי תזכורות ברצף:\n\n**תזכורת 1** — X ימים אחרי שליחת הבקשה הראשונית (ברירת מחדל: 7 ימים)\n**תזכורת 2** — X ימים לפני האירוע (ברירת מחדל: 2 ימים)\n\nניתן לשנות את מספר הימים בטופס עריכת המופע.\n\nמי שכבר ענה (אישר או דחה) — לא יקבל תזכורות.',
      steps:[], link:'', tags:['rsvp','תזכורות','אוטומטי','תזמון'], createdAt:today()
    },
  ];
}

function migrateRsvpHelp() {
  const articles = loadHelp();
  if (!articles) return; // initHelp יטפל בזה
  const hasRsvp = articles.some(a => a.id && a.id.startsWith('h_rsvp'));
  if (hasRsvp) return; // כבר קיים
  const updated = [...articles, ...rsvpHelpArticles()];
  saveHelp(updated);
  console.log('[Help] הוספו', rsvpHelpArticles().length, 'מאמרי RSVP למרכז ההדרכה');
}

app.get('/api/help', (req, res) => {
  initHelp();
  res.json(loadHelp());
});

app.post('/api/help', (req, res) => {
  initHelp();
  const articles = loadHelp();
  const article = {
    id: 'h' + Date.now(),
    type:     req.body.type     || 'guide',
    category: req.body.category || 'general',
    status:   req.body.status   || 'published',
    title:    req.body.title    || '',
    content:  req.body.content  || '',
    steps:    req.body.steps    || [],
    link:     req.body.link     || '',
    tags:     req.body.tags     || [],
    createdAt: today(),
    updatedAt: today(),
  };
  articles.push(article);
  saveHelp(articles);
  res.json({ ok: true, article });
});

app.put('/api/help/:id', (req, res) => {
  const articles = loadHelp() || [];
  const idx = articles.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'לא נמצא' });
  articles[idx] = { ...articles[idx], ...req.body, id: articles[idx].id, updatedAt: today() };
  saveHelp(articles);
  res.json({ ok: true, article: articles[idx] });
});

app.delete('/api/help/:id', (req, res) => {
  let articles = loadHelp() || [];
  articles = articles.filter(a => a.id !== req.params.id);
  saveHelp(articles);
  res.json({ ok: true });
});

// ─── Test Email ───────────────────────────────────────────────────────────────
app.post('/api/admin/test-email', async (req, res) => {
  const to = req.body.to || process.env.SMTP_USER;
  console.log('[TestEmail] מתחיל בדיקה אל:', to, '| SMTP_USER:', process.env.SMTP_USER, '| SMTP_PASS set:', !!process.env.SMTP_PASS);
  // הגדר timeout כולל של 25 שניות
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.status(408).json({ ok: false, error: 'Timeout — החיבור ל-Gmail לוקח יותר מדי זמן (>25s). בדוק שה-App Password נכון.' });
  }, 25000);
  try {
    await sendEmail({
      to,
      subject: 'בדיקת מייל — שקוף בחזית CRM',
      html: `<div dir="rtl" style="font-family:Arial;padding:20px"><h2>🎭 בדיקת מייל</h2><p>אם קיבלת הודעה זו, שליחת המיילים עובדת תקין! ✅</p><p style="color:#94a3b8;font-size:12px;">${new Date().toLocaleString('he-IL')}</p></div>`,
    });
    clearTimeout(timeout);
    console.log('[TestEmail] נשלח בהצלחה');
    if (!res.headersSent) res.json({ ok: true, message: `מייל נשלח אל ${to}` });
  } catch(e) {
    clearTimeout(timeout);
    console.error('[TestEmail] שגיאה:', e.message, '| code:', e.code, '| responseCode:', e.responseCode);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message, code: e.code, responseCode: e.responseCode });
  }
});

// ─── Data Migration (one-time import) ────────────────────────────────────────
app.post('/api/admin/import-data', (req, res) => {
  const { secret, files } = req.body;
  if (secret !== (process.env.ADMIN_PASSWORD || 'changeme')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'No files provided' });
  }
  const results = {};
  for (const [filename, content] of Object.entries(files)) {
    // Only allow JSON files, no path traversal
    if (!/^[\w\-]+\.json$/.test(filename)) { results[filename] = 'skipped'; continue; }
    try {
      wj(filename, content);
      results[filename] = 'ok';
    } catch(e) { results[filename] = 'error: ' + e.message; }
  }
  res.json({ ok: true, results });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

migrateRsvpHelp();

// ─── גיבוי אוטומטי יומי ───────────────────────────────────────────────────────
async function runDailyBackup() {
  try {
    const dataFiles = ['contacts.json','orgs.json','tasks.json','quotes.json','orders.json',
      'shows.json','users.json','help.json','signatures.json','wa-messages.json','rsvp-registrants.json'];
    const backup = {};
    let totalRecords = 0;
    for (const f of dataFiles) {
      const filePath = path.join(DATA, f);
      if (fs.existsSync(filePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          backup[f] = data;
          if (Array.isArray(data)) totalRecords += data.length;
        } catch(e) { backup[f] = null; }
      }
    }
    const dateStr = new Date().toLocaleDateString('he-IL').replace(/\./g, '-');
    const backupJson = JSON.stringify(backup, null, 2);
    const sizekb = Math.round(Buffer.byteLength(backupJson) / 1024);

    await sendEmail({
      to: process.env.SMTP_USER || 'tony@thezebra.co.il',
      subject: `💾 גיבוי יומי — שקוף בחזית CRM · ${dateStr}`,
      html: `<div dir="rtl" style="font-family:Arial;padding:20px;color:#1e293b">
        <h2 style="color:#4f46e5">💾 גיבוי יומי — שקוף בחזית CRM</h2>
        <p>תאריך: <strong>${dateStr}</strong></p>
        <p>סה"כ רשומות: <strong>${totalRecords}</strong></p>
        <p>גודל גיבוי: <strong>${sizekb} KB</strong></p>
        <p style="color:#64748b;font-size:12px">הגיבוי מצורף כקובץ JSON. שמור אותו במקום בטוח.</p>
        <hr/>
        <details><summary style="cursor:pointer;color:#4f46e5;font-weight:600">📋 פרטי גיבוי (לחץ להרחבה)</summary>
        <ul>${dataFiles.map(f=>backup[f]!=null?`<li>${f}: ${Array.isArray(backup[f])?backup[f].length+' רשומות':'קיים'}</li>`:``).join('')}</ul>
        </details>
        <pre style="background:#f8fafc;padding:16px;border-radius:8px;font-size:11px;max-height:400px;overflow:auto;direction:ltr">${backupJson.substring(0,8000)}${backupJson.length>8000?'\n... (קובץ גדול)':''}</pre>
        <p style="color:#94a3b8;font-size:11px">נשלח אוטומטית מ-CRM שקוף בחזית · ${new Date().toLocaleString('he-IL')}</p>
      </div>`,
    });
    console.log(`[Backup] ✅ גיבוי יומי נשלח — ${totalRecords} רשומות, ${sizekb}KB`);
  } catch(e) {
    console.error('[Backup] ❌ שגיאה בגיבוי:', e.message);
  }
}

// הרץ גיבוי כל יום ב-3:00 לילה
function scheduleDailyBackup() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  const msUntil3am = next3am - now;
  setTimeout(() => {
    runDailyBackup();
    setInterval(runDailyBackup, 24 * 60 * 60 * 1000);
  }, msUntil3am);
  console.log(`[Backup] ⏰ גיבוי יומי מתוזמן ל-${next3am.toLocaleString('he-IL')}`);
}
scheduleDailyBackup();

app.listen(PORT, () => {
  console.log('\n🎭  CRM שקוף בחזית');
  console.log(`✅  רץ על http://localhost:${PORT}`);
  console.log(`[WA] WA_PHONE_NUMBER_ID set: ${!!process.env.WA_PHONE_NUMBER_ID}, WA_ACCESS_TOKEN set: ${!!process.env.WA_ACCESS_TOKEN}, WA_CLOUD: ${WA_CLOUD}`);
  const tokens = loadStoredTokens();
  if (tokens) {
    console.log('🔄  סנכרון אוטומטי פעיל — דוחף שינויים לגוגל מיד, מושך כל 5 דקות');
  } else {
    console.log('⚠️   כדי להפעיל סנכרון אוטומטי: התחבר לגוגל בהגדרות');
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠️   לסנכרון גוגל: ערוך את קובץ .env עם GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET');
  }
});
