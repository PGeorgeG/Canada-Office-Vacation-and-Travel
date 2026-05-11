const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'planner.db');
console.log('[DB] Using database at:', DB_PATH);
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      vacation_days INTEGER NOT NULL DEFAULT 10,
      travel_days INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      other_label TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      group_id TEXT NOT NULL
    );
  `);

  // Migrate: add travel_days column if it doesn't exist yet
  try { db.run("ALTER TABLE staff ADD COLUMN travel_days INTEGER NOT NULL DEFAULT 0"); } catch(e) { /* already exists */ }

  if (!getOne("SELECT value FROM settings WHERE key='app_password'")) {
    run("INSERT INTO settings(key,value) VALUES('app_password',?)", [bcrypt.hashSync('pts2026', 10)]);
  }
  if (!getOne("SELECT value FROM settings WHERE key='admin_password'")) {
    run("INSERT INTO settings(key,value) VALUES('admin_password',?)", [bcrypt.hashSync('admin2026', 10)]);
  }

  const count = getOne("SELECT COUNT(*) as c FROM staff");
  if (!count || count.c === 0) {
    const names  = ['Trudy','Dave','Deb','Phil','Rachelle'];
    const colors = ['#4f86c6','#e07b39','#5aaa6f','#9b59b6','#c0392b'];
    const days   = [10, 17, 15, 20, 15];
    names.forEach((n,i) => run("INSERT INTO staff(name,color,vacation_days) VALUES(?,?,?)", [n,colors[i],days[i]]));
  }
}

function persist() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
  const last = getOne("SELECT last_insert_rowid() as id");
  return { lastInsertRowid: last ? last.id : null };
}

module.exports = { initDb, getOne, getAll, run };
