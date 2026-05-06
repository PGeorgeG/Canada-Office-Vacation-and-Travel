const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { initDb, getOne, getAll, run } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pts-vacation-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const requireAuth  = (req, res, next) => req.session.authenticated ? next() : res.status(401).json({ error: 'Not authenticated' });
const requireAdmin = (req, res, next) => req.session.admin ? next() : res.status(403).json({ error: 'Admin access required' });

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const row = getOne("SELECT value FROM settings WHERE key='app_password'");
  if (row && bcrypt.compareSync(req.body.password, row.value)) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/admin-login', (req, res) => {
  const row = getOne("SELECT value FROM settings WHERE key='admin_password'");
  if (row && bcrypt.compareSync(req.body.password, row.value)) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect admin password' });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/session', (req, res) =>
  res.json({ authenticated: !!req.session.authenticated, admin: !!req.session.admin })
);

// ── Staff ─────────────────────────────────────────────────────────────────────
app.get('/api/staff', requireAuth, (req, res) => {
  res.json(getAll("SELECT * FROM staff WHERE active=1 ORDER BY id"));
});

app.put('/api/staff/:id', requireAuth, requireAdmin, (req, res) => {
  const { vacation_days, color } = req.body;
  run("UPDATE staff SET vacation_days=?,color=? WHERE id=?", [vacation_days, color, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', requireAuth, requireAdmin, (req, res) => {
  const { type, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Too short' });
  const key = type === 'admin' ? 'admin_password' : 'app_password';
  run("UPDATE settings SET value=? WHERE key=?", [bcrypt.hashSync(newPassword, 10), key]);
  res.json({ ok: true });
});

// ── Entries ───────────────────────────────────────────────────────────────────
app.get('/api/entries', requireAuth, (req, res) => {
  const { year } = req.query;
  let sql = `SELECT e.*,s.name as staff_name,s.color FROM entries e JOIN staff s ON e.staff_id=s.id`;
  const params = [];
  if (year) {
    sql += " WHERE (substr(e.start_date,1,4)=? OR substr(e.end_date,1,4)=?)";
    params.push(year, year);
  }
  sql += " ORDER BY e.start_date";
  res.json(getAll(sql, params));
});

app.post('/api/entries', requireAuth, (req, res) => {
  const { staff_id, category, other_label, start_date, end_date, notes } = req.body;
  if (!staff_id || !category || !start_date || !end_date)
    return res.status(400).json({ error: 'Missing fields' });
  const result = run(
    "INSERT INTO entries(staff_id,category,other_label,start_date,end_date,notes) VALUES(?,?,?,?,?,?)",
    [staff_id, category, other_label || null, start_date, end_date, notes || null]
  );
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/entries/:id', requireAuth, (req, res) => {
  const { staff_id, category, other_label, start_date, end_date, notes } = req.body;
  run("UPDATE entries SET staff_id=?,category=?,other_label=?,start_date=?,end_date=?,notes=? WHERE id=?",
    [staff_id, category, other_label || null, start_date, end_date, notes || null, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/entries/:id', requireAuth, (req, res) => {
  run("DELETE FROM entries WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

// ── Summary ───────────────────────────────────────────────────────────────────
app.get('/api/summary/:year', requireAuth, (req, res) => {
  const { year } = req.params;
  const staff = getAll("SELECT * FROM staff WHERE active=1 ORDER BY id");

  const ALL_CATS = ['Vacation','Lieu Day','Conference / Training','Travel (work)','Sick Day','Other'];

  const summary = staff.map(s => {
    const entries = getAll(
      `SELECT * FROM entries WHERE staff_id=? AND (substr(start_date,1,4)=? OR substr(end_date,1,4)=?)`,
      [s.id, year, year]
    );
    const breakdown = {};
    ALL_CATS.forEach(c => breakdown[c] = 0);
    entries.forEach(e => {
      const days = workdaysBetween(e.start_date, e.end_date, year);
      const key = ALL_CATS.includes(e.category) ? e.category : 'Other';
      breakdown[key] += days;
    });
    const used = breakdown['Vacation'];
    return { ...s, used, remaining: s.vacation_days - used, breakdown };
  });

  res.json(summary);
});

function workdaysBetween(start, end, year) {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const yS = new Date(`${year}-01-01T00:00:00`);
  const yE = new Date(`${year}-12-31T00:00:00`);
  const from = s < yS ? yS : s;
  const to   = e > yE ? yE : e;
  let count = 0;
  const cur = new Date(from);
  while (cur <= to) {
    const d = cur.getDay();
    if (d >= 1 && d <= 4) count++; // Mon–Thu only (Fridays off)
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`PTS Vacation Planner running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
