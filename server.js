// Choose Your Own Ethics — zero-dependency Node server (uses built-in node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORY_PATH = process.env.STORY_PATH || path.join(__dirname, 'story.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'stats.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    good INTEGER,
    bad INTEGER,
    ending TEXT,
    path TEXT
  );
  CREATE TABLE IF NOT EXISTS poll_answers (
    run_id TEXT NOT NULL,
    poll_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, poll_id)
  );
`);

function loadStory() {
  return JSON.parse(fs.readFileSync(STORY_PATH, 'utf8'));
}
// Validate once at boot so a broken story.json fails loudly.
validateStory(loadStory());

function validateStory(story) {
  const ids = new Set(Object.keys(story.nodes));
  const problems = [];
  const check = (from, to) => { if (!ids.has(to)) problems.push(`${from} -> missing node "${to}"`); };
  if (!ids.has(story.start)) problems.push(`start node "${story.start}" missing`);
  for (const [id, n] of Object.entries(story.nodes)) {
    if (n.next) check(id, n.next);
    if (n.else) check(id, n.else);
    (n.branch || []).forEach(b => check(id, b.next));
    (n.choices || []).forEach(c => check(id, c.next));
    if (n.poll && !story.polls?.[n.poll]) problems.push(`${id} -> missing poll "${n.poll}"`);
    if (!n.next && !n.choices && !n.branch && !n.ending) problems.push(`${id} is a dead end with no "ending"`);
  }
  if (problems.length) {
    console.error('story.json problems:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
}

const now = () => new Date().toISOString();

function pollCounts() {
  const story = loadStory();
  const out = {};
  for (const [pollId, poll] of Object.entries(story.polls || {})) {
    out[pollId] = { question: poll.question, options: {}, total: 0 };
    for (const [optId, label] of Object.entries(poll.options)) out[pollId].options[optId] = { label, count: 0 };
  }
  for (const r of db.prepare('SELECT poll_id, option_id, COUNT(*) AS n FROM poll_answers GROUP BY poll_id, option_id').all()) {
    if (!out[r.poll_id]?.options[r.option_id]) continue;
    out[r.poll_id].options[r.option_id].count = r.n;
    out[r.poll_id].total += r.n;
  }
  return out;
}

function adminStats() {
  const one = sql => db.prepare(sql).get();
  const started = one('SELECT COUNT(*) AS n FROM runs').n;
  const completed = one('SELECT COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL').n;
  const avg = one('SELECT AVG(good) AS good, AVG(bad) AS bad FROM runs WHERE finished_at IS NOT NULL');
  const endings = db.prepare(`SELECT ending, COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL GROUP BY ending ORDER BY n DESC`).all();
  const scores = db.prepare(`SELECT good, bad, COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL GROUP BY good, bad ORDER BY good DESC, bad ASC`).all();
  const recent = db.prepare(`
    SELECT r.id, r.started_at, r.finished_at, r.good, r.bad, r.ending,
           (SELECT group_concat(poll_id || ':' || option_id) FROM poll_answers p WHERE p.run_id = r.id) AS polls
    FROM runs r ORDER BY r.started_at DESC LIMIT 50`).all();
  return { started, completed, avgGood: avg.good, avgBad: avg.bad, endings, scores, recent, polls: pollCounts() };
}

function exportCsv() {
  const rows = db.prepare(`
    SELECT r.id, r.started_at, r.finished_at, r.good, r.bad, r.ending, r.path,
           (SELECT group_concat(poll_id || '=' || option_id, ';') FROM poll_answers p WHERE p.run_id = r.id) AS polls
    FROM runs r ORDER BY r.started_at`).all();
  const cols = ['id', 'started_at', 'finished_at', 'good', 'bad', 'ending', 'polls', 'path'];
  const esc = v => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

// ---------- HTTP plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const safeEqual = (x, y) => {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Session cookie value: derived from the password, so changing ADMIN_PASSWORD logs everyone out.
const ADMIN_TOKEN = crypto.createHmac('sha256', ADMIN_PASSWORD).update('cyoe-admin-session').digest('hex');

function isAdmin(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('cyoe_admin='));
  if (cookie && safeEqual(cookie.slice('cyoe_admin='.length), ADMIN_TOKEN)) return true;
  // Also accept HTTP Basic auth (handy for curl).
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  return safeEqual(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'), ADMIN_PASSWORD);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  send(res, 401, { error: 'login required' });
  return false;
}

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;
  try {
    // ---- public game API ----
    if (m === 'GET' && p === '/api/story') return send(res, 200, loadStory());
    if (m === 'GET' && p === '/api/polls') return send(res, 200, pollCounts());

    if (m === 'POST' && p === '/api/runs') {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO runs (id, started_at) VALUES (?, ?)').run(id, now());
      return send(res, 201, { id });
    }

    let match;
    if (m === 'POST' && (match = p.match(/^\/api\/runs\/([\w-]+)\/poll$/))) {
      const { pollId, option } = await readJson(req);
      const poll = loadStory().polls?.[pollId];
      if (!poll || !poll.options[option]) return send(res, 400, { error: 'unknown poll/option' });
      db.prepare(`INSERT INTO poll_answers (run_id, poll_id, option_id, created_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(run_id, poll_id) DO UPDATE SET option_id = excluded.option_id`).run(match[1], pollId, option, now());
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && (match = p.match(/^\/api\/runs\/([\w-]+)\/finish$/))) {
      const { good, bad, ending, path: trail } = await readJson(req);
      db.prepare('UPDATE runs SET finished_at = ?, good = ?, bad = ?, ending = ?, path = ? WHERE id = ? AND finished_at IS NULL')
        .run(now(), Number(good) || 0, Number(bad) || 0, String(ending || ''), JSON.stringify(trail || []), match[1]);
      return send(res, 200, { ok: true, polls: pollCounts() });
    }

    // ---- admin ----
    if (m === 'GET' && (p === '/admin' || p === '/admin.html')) return serveStatic(res, 'admin.html');
    if (m === 'POST' && p === '/api/admin/login') {
      const { password } = await readJson(req);
      if (!safeEqual(password || '', ADMIN_PASSWORD)) return send(res, 401, { error: 'wrong password' });
      res.setHeader('Set-Cookie', `cyoe_admin=${ADMIN_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/admin/logout') {
      res.setHeader('Set-Cookie', 'cyoe_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/admin')) {
      if (!requireAdmin(req, res)) return;
      if (m === 'GET' && p === '/api/admin/stats') return send(res, 200, adminStats());
      if (m === 'GET' && p === '/api/admin/export.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="playthroughs.csv"' });
        return res.end(exportCsv());
      }
      if (m === 'POST' && p === '/api/admin/reset') {
        db.exec('DELETE FROM poll_answers; DELETE FROM runs;');
        return send(res, 200, { ok: true });
      }
      if (m === 'POST' && p === '/api/admin/clear-unfinished') {
        db.exec('DELETE FROM poll_answers WHERE run_id IN (SELECT id FROM runs WHERE finished_at IS NULL); DELETE FROM runs WHERE finished_at IS NULL;');
        return send(res, 200, { ok: true });
      }
      if (m === 'DELETE' && (match = p.match(/^\/api\/admin\/runs\/([\w-]+)$/))) {
        db.prepare('DELETE FROM poll_answers WHERE run_id = ?').run(match[1]);
        db.prepare('DELETE FROM runs WHERE id = ?').run(match[1]);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    // ---- static ----
    if (m === 'GET') return serveStatic(res, p === '/' ? 'index.html' : p.slice(1));
    send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, () => console.log(`Choose Your Own Ethics running on http://localhost:${PORT}  (admin: /admin)`));
