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

  // Build stat holiday set for fast lookup
  const holidays = getAll("SELECT date FROM holidays");
  const statDays = new Set(holidays.map(h => h.date));

  const summary = staff.map(s => {
    const entries = getAll(
      `SELECT * FROM entries WHERE staff_id=? AND (substr(start_date,1,4)=? OR substr(end_date,1,4)=?)`,
      [s.id, year, year]
    );
    const breakdown = {};
    ALL_CATS.forEach(c => breakdown[c] = 0);
    entries.forEach(e => {
      const days = e.category === 'Travel (work)'
        ? calendarDays(e.start_date, e.end_date, year)
        : workdaysBetween(e.start_date, e.end_date, year, statDays);
      const key = ALL_CATS.includes(e.category) ? e.category : 'Other';
      breakdown[key] += days;
    });
    const used = breakdown['Vacation'];
    return { ...s, used, remaining: s.vacation_days - used, breakdown };
  });

  res.json(summary);
});

function workdaysBetween(start, end, year, statDays = new Set()) {
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
    const ds = cur.toISOString().slice(0, 10);
    if (d >= 1 && d <= 4 && !statDays.has(ds)) count++; // Mon–Thu, not a stat holiday
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Count all calendar days (for Travel) clamped to year
function calendarDays(start, end, year) {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const yS = new Date(`${year}-01-01T00:00:00`);
  const yE = new Date(`${year}-12-31T00:00:00`);
  const from = s < yS ? yS : s;
  const to   = e > yE ? yE : e;
  return Math.max(0, Math.round((to - from) / 86400000) + 1);
}

// ── Holidays ──────────────────────────────────────────────────────────────────

// Flat list for calendar (optionally filtered by year)
app.get('/api/holidays', requireAuth, (req, res) => {
  const { year } = req.query;
  const rows = getAll("SELECT * FROM holidays ORDER BY date");
  if (!year) return res.json(rows);
  res.json(rows.filter(h => h.date.startsWith(year)));
});

// Grouped list for Holidays tab display
app.get('/api/holidays/grouped', requireAuth, (req, res) => {
  const rows = getAll("SELECT * FROM holidays ORDER BY date");
  const groups = {};
  rows.forEach(h => {
    if (!groups[h.group_id]) groups[h.group_id] = { group_id: h.group_id, name: h.name, dates: [] };
    groups[h.group_id].dates.push(h.date);
  });
  const sorted = Object.values(groups).sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
  res.json(sorted);
});

// Add a holiday — single date or range, expanded to individual rows sharing a group_id
app.post('/api/holidays', requireAuth, requireAdmin, (req, res) => {
  const { name, start_date, end_date } = req.body;
  if (!name || !start_date) return res.status(400).json({ error: 'Name and start date required' });
  const endD = end_date || start_date;
  if (endD < start_date) return res.status(400).json({ error: 'End date must be on or after start date' });

  const groupId = Date.now().toString();
  const cur = new Date(start_date + 'T00:00:00');
  const end = new Date(endD + 'T00:00:00');
  let count = 0;
  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    try { run("INSERT OR REPLACE INTO holidays(date,name,group_id) VALUES(?,?,?)", [ds, name, groupId]); count++; } catch(e) {}
    cur.setDate(cur.getDate() + 1);
  }
  res.json({ ok: true, count });
});

// Delete all dates belonging to a holiday group
app.delete('/api/holidays/group/:groupId', requireAuth, requireAdmin, (req, res) => {
  run("DELETE FROM holidays WHERE group_id=?", [req.params.groupId]);
  res.json({ ok: true });
});

// ── iCal feed ─────────────────────────────────────────────────────────────────
// No auth required — Google Calendar subscribes via URL
// Full feed:     https://your-app.railway.app/calendar.ics
// Per person:    https://your-app.railway.app/calendar.ics?person=Dave

app.get('/calendar.ics', (req, res) => {
  const { person } = req.query;
  let sql = 'SELECT e.*,s.name as staff_name FROM entries e JOIN staff s ON e.staff_id=s.id';
  const params = [];
  if (person) { sql += ' WHERE s.name=?'; params.push(person); }
  sql += ' ORDER BY e.start_date';
  const entries = getAll(sql, params);

  function icalDate(ds) { return ds.replace(/-/g, ''); }
  function icalDateNext(ds) {
    const d = new Date(ds + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0,10).replace(/-/g,'');
  }
  function esc(str) { return (str || '').replace(/[;,]/g, s => '\\' + s); }

  const now = new Date().toISOString().replace(/[-:.Z]/g,'').slice(0,15) + 'Z';
  const calName = person ? 'PTS Canada OOO \u2014 ' + person : 'PTS Canada Out of Office';
  const CRLF = '\r\n';

  const events = entries.map(e => {
    const label = (e.category === 'Other' && e.other_label)
      ? e.staff_name + ': ' + e.other_label
      : e.staff_name + ': ' + e.category;
    const lines = [
      'BEGIN:VEVENT',
      'UID:pts-ooo-' + e.id + '@canada.pts',
      'DTSTAMP:' + now,
      'DTSTART;VALUE=DATE:' + icalDate(e.start_date),
      'DTEND;VALUE=DATE:' + icalDateNext(e.end_date),
      'SUMMARY:' + esc(label),
      'END:VEVENT'
    ];
    if (e.notes) lines.splice(-1, 0, 'DESCRIPTION:' + esc(e.notes));
    return lines.join(CRLF);
  });

  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PTS Canada//Out of Office Planner//EN',
    'X-WR-CALNAME:' + calName,
    'X-WR-TIMEZONE:America/Vancouver',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR'
  ].join(CRLF);

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="pts-ooo.ics"');
  res.send(ical);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`PTS Canada Out of Office Planner running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
