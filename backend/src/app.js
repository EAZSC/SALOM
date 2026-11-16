import http from 'node:http';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { openDb } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 80 * 1024 * 1024 };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = () => crypto.randomBytes(32).toString('base64url');
const RANK = { user: 0, admin: 1, founder: 2 };
const RESERVED = new Set(['admin', 'founder', 'mivo', 'aster', 'support', 'newbot', 'root', 'system', 'moderator']);
const COMMON_PW = ['password123', '1234567890', 'qwertyuiop', 'mivo123456', 'password1234', '12345678910', 'iloveyou123', 'abcdefghij1'];

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const bad = (c = 'invalid_input') => new HttpError(400, c);
function str(v, min, max) {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
}
function int(v, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw bad();
  return v;
}
function uname(v) {
  const s = str(v, 4, 20).toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,19}$/.test(s)) throw bad('invalid_username');
  return s;
}
const cid = (v) => { const s = str(v, 8, 64); if (!/^[A-Za-z0-9_-]+$/.test(s)) throw bad(); return s; };
const pid = (v) => { if (!/^\d{1,12}$/.test(v)) throw bad(); return Number(v); };
const b64 = (v, max) => { const s = str(v, 1, max); if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) throw bad(); return s; };

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPw(pw, stored) {
  const [v, s, k] = stored.split('$');
  if (v !== 's1') return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 32, SCRYPT);
  const want = Buffer.from(k, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
let dummyP;
const dummyHash = () => (dummyP ??= hashPw(crypto.randomBytes(12).toString('hex')));

function checkPw(pw, username) {
  if (COMMON_PW.includes(pw.toLowerCase())) throw bad('weak_password');
  if (pw.toLowerCase().includes(username)) throw bad('weak_password');
  const hasL = /[A-Za-z]/.test(pw), hasD = /\d/.test(pw);
  if (!(pw.length >= 16 || (hasL && hasD))) throw bad('weak_password');
  if (new Set(pw).size < 5) throw bad('weak_password');
}

function makeLimiter(enabled) {
  const m = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, a] of m) if (!a.length || now - a[a.length - 1] > 3600e3) m.delete(k); }, 60e3).unref();
  return (key, max, win) => {
    if (!enabled) return true;
    const now = Date.now();
    const a = (m.get(key) || []).filter((t) => now - t < win);
    if (a.length >= max) { m.set(key, a); return false; }
    a.push(now); m.set(key, a); return true;
  };
}

export function createApp({ dbPath = ':memory:', trustProxy = false, limits = true } = {}) {
  const db = openDb(dbPath);
  const limit = makeLimiter(limits);
  const routes = [];
  const route = (method, path, opts, fn) => routes.push({
    method, fn, auth: opts.auth !== false, role: opts.role, rl: opts.rl, rlu: opts.rlu,
    re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
  });

  const audit = (actor, action, target = '', detail = '') =>
    db.prepare('INSERT INTO audit(ts,actor_id,action,target,detail) VALUES(?,?,?,?,?)').run(Date.now(), actor, action, String(target), String(detail));

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  }

  function newSession(userId) {
    const access = rnd(), refresh = rnd(), now = Date.now();
    db.prepare('INSERT INTO sessions(user_id,access_hash,access_exp,refresh_hash,refresh_exp,created) VALUES(?,?,?,?,?,?)')
      .run(userId, sha(access), now + 15 * 60e3, sha(refresh), now + 30 * 86400e3, now);
    return { access_token: access, refresh_token: refresh, expires_in: 900 };
  }

  function authenticate(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const r = db.prepare(`SELECT s.id sid, s.access_exp, s.revoked, u.id, u.username, u.role, u.banned
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.access_hash=?`).get(sha(m[1]));
    if (!r || r.revoked || r.banned || r.access_exp < Date.now()) return null;
    return { id: r.id, username: r.username, role: r.role, sid: r.sid };
  }

  const findByName = (name) => db.prepare('SELECT u.id,u.username,u.pubkey FROM usernames n JOIN users u ON u.id=n.owner_id WHERE n.name=?').get(name);
  function getConv(id, uid) {
    const c = db.prepare('SELECT * FROM conversations WHERE id=? AND (user_a=? OR user_b=?)').get(id, uid, uid);
    if (!c) throw new HttpError(404, 'not_found');
    return c;
  }
  const peerId = (c, uid) => (c.user_a === uid ? c.user_b : c.user_a);
  const nameOf = (id) => db.prepare('SELECT username FROM users WHERE id=?').get(id)?.username;
  const balanceOf = (id) => db.prepare('SELECT balance FROM users WHERE id=?').get(id).balance;
  const uniq = (e) => /UNIQUE/.test(String(e?.message));

  // ---------- health ----------
  route('GET', '/health', { auth: false }, () => ({ ok: true }));

  // ---------- auth ----------
  route('POST', '/auth/register', { auth: false, rl: ['reg', 5, 3600e3] }, async ({ body }) => {
    const username = uname(body.username);
    const pw = str(body.password, 10, 128);
    if (RESERVED.has(username)) throw new HttpError(409, 'username_taken');
    checkPw(pw, username);
    const hash = await hashPw(pw);
    let id;
    try {
      id = tx(() => {
        const r = db.prepare('INSERT INTO users(username,pw_hash,role,balance,created) VALUES(?,?,?,?,?)').run(username, hash, 'user', 0, Date.now());
        const uid = Number(r.lastInsertRowid);
        db.prepare('INSERT INTO usernames(name,owner_id,is_primary) VALUES(?,?,1)').run(username, uid);
        return uid;
      });
    } catch (e) { if (uniq(e)) throw new HttpError(409, 'username_taken'); throw e; }
    return [201, { user: { id, username, role: 'user' }, ...newSession(id) }];
  });

  route('POST', '/auth/login', { auth: false, rl: ['login', 20, 600e3] }, async ({ body }) => {
    const username = uname(body.username);
    const pw = str(body.password, 1, 128);
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (u && u.locked_until > Date.now()) throw new HttpError(429, 'account_locked');
    let ok = false;
    if (u) ok = await verifyPw(pw, u.pw_hash);
    else await verifyPw(pw, await dummyHash());
    if (!u || !ok) {
      if (u) {
        db.prepare('UPDATE users SET failed_logins=failed_logins+1 WHERE id=?').run(u.id);
        const f = db.prepare('SELECT failed_logins f FROM users WHERE id=?').get(u.id).f;
        if (f >= 5) {
          db.prepare('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?').run(Date.now() + 15 * 60e3, u.id);
          audit(u.id, 'account_locked', u.id);
        }
      }
      throw new HttpError(401, 'invalid_credentials');
    }
    if (u.banned) throw new HttpError(403, 'banned');
    db.prepare('UPDATE users SET failed_logins=0 WHERE id=?').run(u.id);
    return { user: { id: u.id, username: u.username, role: u.role }, ...newSession(u.id) };
  });

  route('POST', '/auth/refresh', { auth: false, rl: ['refresh', 60, 60e3] }, ({ body }) => {
    const h = sha(str(body.refresh_token, 20, 100));
    const s = db.prepare('SELECT * FROM sessions WHERE refresh_hash=?').get(h);
    if (!s) {
      const old = db.prepare('SELECT id,user_id FROM sessions WHERE prev_refresh_hash=?').get(h);
      if (old) { db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(old.id); audit(old.user_id, 'refresh_reuse_detected', old.id); }
      throw new HttpError(401, 'invalid_token');
    }
    const u = db.prepare('SELECT id,username,role,banned FROM users WHERE id=?').get(s.user_id);
    if (s.revoked || s.refresh_exp < Date.now() || u.banned) throw new HttpError(401, 'invalid_token');
    const access = rnd(), refresh = rnd(), now = Date.now();
    db.prepare('UPDATE sessions SET access_hash=?,access_exp=?,prev_refresh_hash=refresh_hash,refresh_hash=?,refresh_exp=? WHERE id=?')
      .run(sha(access), now + 15 * 60e3, sha(refresh), now + 30 * 86400e3, s.id);
    return { user: { id: u.id, username: u.username, role: u.role }, access_token: access, refresh_token: refresh, expires_in: 900 };
  });

  route('POST', '/auth/logout', {}, ({ user }) => {
    db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(user.sid);
    return { ok: true };
  });

  // ---------- profile / keys ----------
  route('GET', '/me', {}, ({ user }) => {
    const u = db.prepare('SELECT id,username,role,balance FROM users WHERE id=?').get(user.id);
    const names = db.prepare(`SELECT n.name, n.is_primary, EXISTS(SELECT 1 FROM listings l WHERE l.username=n.name AND l.status='active') listed
      FROM usernames n WHERE n.owner_id=? ORDER BY n.is_primary DESC, n.name`).all(user.id)
      .map((r) => ({ name: r.name, primary: !!r.is_primary, listed: !!r.listed }));
    return { id: u.id, username: u.username, role: u.role, balance: u.balance, usernames: names };
  });

  route('PUT', '/keys', { rlu: ['keys', 10, 3600e3] }, ({ user, body }) => {
    db.prepare('UPDATE users SET pubkey=? WHERE id=?').run(b64(body.pubkey, 4000).length ? body.pubkey : null, user.id);
    return { ok: true };
  });
  route('GET', '/users/:name/key', { rlu: ['getkey', 60, 60e3] }, ({ params }) => {
    const p = findByName(uname(params.name));
    if (!p || !p.pubkey) throw new HttpError(404, 'not_found');
    return { pubkey: p.pubkey };
  });

  // ---------- conversations ----------
  route('GET', '/conversations', {}, ({ user }) => {
    const rows = db.prepare('SELECT * FROM conversations WHERE user_a=? OR user_b=? ORDER BY last_at DESC LIMIT 200').all(user.id, user.id);
    return { items: rows.map((c) => ({ id: c.id, kind: c.kind, status: c.status, peer: nameOf(peerId(c, user.id)), requested_by_me: c.requested_by === user.id, last_at: c.last_at })) };
  });

  route('POST', '/conversations', { rlu: ['newconv', 30, 3600e3] }, ({ user, body }) => {
    const peer = findByName(uname(body.username));
    if (!peer) throw new HttpError(404, 'user_not_found');
    if (peer.id === user.id) throw bad();
    const kind = body.kind === 'secret' ? 'secret' : body.kind === 'normal' ? 'normal' : null;
    if (!kind) throw bad();
    const a = Math.min(user.id, peer.id), b = Math.max(user.id, peer.id);
    let c = db.prepare('SELECT * FROM conversations WHERE user_a=? AND user_b=? AND kind=?').get(a, b, kind);
    if (kind === 'secret') {
      const me = db.prepare('SELECT pubkey FROM users WHERE id=?').get(user.id);
      if (!me.pubkey) throw new HttpError(409, 'no_key');
      if (!peer.pubkey) throw new HttpError(409, 'peer_no_key');
    }
    if (c && kind === 'secret' && c.status === 'rejected') {
      // only the side that rejected may re-open; the requester cannot spam
      if (c.requested_by === user.id) throw new HttpError(409, 'rejected');
      db.prepare("UPDATE conversations SET status='pending', requested_by=?, last_at=? WHERE id=?").run(user.id, Date.now(), c.id);
      c = db.prepare('SELECT * FROM conversations WHERE id=?').get(c.id);
    }
    if (!c) {
      const now = Date.now();
      const r = db.prepare('INSERT INTO conversations(user_a,user_b,kind,status,requested_by,created,last_at) VALUES(?,?,?,?,?,?,?)')
        .run(a, b, kind, kind === 'secret' ? 'pending' : 'active', kind === 'secret' ? user.id : null, now, now);
      c = db.prepare('SELECT * FROM conversations WHERE id=?').get(Number(r.lastInsertRowid));
    }
    return [201, { id: c.id, kind: c.kind, status: c.status, peer: peer.username }];
  });

  route('POST', '/conversations/:id/respond', {}, ({ user, params, body }) => {
    const c = getConv(pid(params.id), user.id);
    if (c.kind !== 'secret' || c.status !== 'pending' || c.requested_by === user.id) throw new HttpError(409, 'invalid_state');
    if (typeof body.accept !== 'boolean') throw bad();
    const st = body.accept ? 'active' : 'rejected';
    db.prepare('UPDATE conversations SET status=?, last_at=? WHERE id=?').run(st, Date.now(), c.id);
    // NOTE: a rejected secret chat is never downgraded to a normal chat.
    return { status: st };
  });

  route('GET', '/conversations/:id/messages', {}, ({ user, params, query }) => {
    const c = getConv(pid(params.id), user.id);
    const after = /^\d{1,12}$/.test(query.get('after') || '') ? Number(query.get('after')) : 0;
    const rows = db.prepare('SELECT * FROM messages WHERE conv_id=? AND id>? ORDER BY id LIMIT 100').all(c.id, after);
    return {
      conversation: { id: c.id, kind: c.kind, status: c.status, peer: nameOf(peerId(c, user.id)), requested_by_me: c.requested_by === user.id },
      items: rows.map((m) => {
        const mine = m.sender_id === user.id;
        return c.kind === 'secret'
          ? { id: m.id, mine, cipher: mine ? m.cipher_sender : m.cipher_recipient, created: m.created }
          : { id: m.id, mine, body: m.body, created: m.created };
      }),
    };
  });

  route('POST', '/conversations/:id/messages', { rlu: ['msg', 120, 60e3] }, ({ user, params, body }) => {
    const c = getConv(pid(params.id), user.id);
    if (c.status !== 'active') throw new HttpError(409, 'not_active');
    const client = cid(body.client_msg_id);
    let body_ = null, cr = null, cs = null;
    if (c.kind === 'secret') {
      if ('body' in body) throw bad('plaintext_not_allowed');
      cr = b64(body.cipher_recipient, 16000); cs = b64(body.cipher_sender, 16000);
    } else {
      if ('cipher_recipient' in body || 'cipher_sender' in body) throw bad();
      body_ = str(body.body, 1, 4000);
    }
    return tx(() => {
      const dup = db.prepare('SELECT id FROM messages WHERE conv_id=? AND sender_id=? AND client_id=?').get(c.id, user.id, client);
      if (dup) return { id: dup.id, duplicate: true };
      const now = Date.now();
      const r = db.prepare('INSERT INTO messages(conv_id,sender_id,client_id,body,cipher_recipient,cipher_sender,created) VALUES(?,?,?,?,?,?,?)')
        .run(c.id, user.id, client, body_, cr, cs, now);
      db.prepare('UPDATE conversations SET last_at=? WHERE id=?').run(now, c.id);
      return [201, { id: Number(r.lastInsertRowid) }];
    });
  });

  // ---------- ASTER wallet ----------
  route('POST', '/wallet/transfer', { rlu: ['transfer', 30, 60e3] }, ({ user, body }) => {
    const to = uname(body.to_username), amount = int(body.amount, 1, 1e9), client = cid(body.client_tx_id);
    return tx(() => {
      if (db.prepare('SELECT 1 FROM ledger WHERE from_id=? AND client_id=?').get(user.id, client))
        return { balance: balanceOf(user.id), duplicate: true };
      const peer = findByName(to);
      if (!peer) throw new HttpError(404, 'user_not_found');
      if (peer.id === user.id) throw bad();
      const r = db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amount, user.id, amount);
      if (r.changes !== 1) throw new HttpError(402, 'insufficient_funds');
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, peer.id);
      db.prepare("INSERT INTO ledger(from_id,to_id,amount,kind,client_id,ts) VALUES(?,?,?,'transfer',?,?)").run(user.id, peer.id, amount, client, Date.now());
      return { balance: balanceOf(user.id) };
    });
  });

  route('GET', '/wallet/history', {}, ({ user }) => {
    const rows = db.prepare('SELECT * FROM ledger WHERE from_id=? OR to_id=? ORDER BY id DESC LIMIT 50').all(user.id, user.id);
    return {
      items: rows.map((l) => {
        const out = l.from_id === user.id;
        return { id: l.id, dir: out ? 'out' : 'in', peer: l.from_id == null ? 'MIVO' : nameOf(out ? l.to_id : l.from_id), amount: l.amount, kind: l.kind, ts: l.ts };
      }),
    };
  });

  // ---------- username marketplace ----------
  const OWN_CAP = 10;
  const extraCount = (uid) => db.prepare('SELECT COUNT(*) c FROM usernames WHERE owner_id=? AND is_primary=0').get(uid).c;

  route('POST', '/usernames/claim', { rlu: ['claim', 10, 3600e3] }, ({ user, body }) => {
    const name = uname(body.username);
    if (RESERVED.has(name)) throw new HttpError(409, 'username_taken');
    if (extraCount(user.id) >= OWN_CAP) throw new HttpError(409, 'limit_reached');
    try { db.prepare('INSERT INTO usernames(name,owner_id,is_primary) VALUES(?,?,0)').run(name, user.id); }
    catch (e) { if (uniq(e)) throw new HttpError(409, 'username_taken'); throw e; }
    return [201, { ok: true }];
  });

  route('GET', '/market', {}, ({ user }) => ({
    items: db.prepare(`SELECT l.id,l.username,l.price,l.seller_id,u.username seller FROM listings l JOIN users u ON u.id=l.seller_id
      WHERE l.status='active' ORDER BY l.id DESC LIMIT 100`).all()
      .map((l) => ({ id: l.id, username: l.username, price: l.price, seller: l.seller, mine: l.seller_id === user.id })),
  }));

  route('POST', '/market/list', { rlu: ['mlist', 20, 3600e3] }, ({ user, body }) => {
    const name = uname(body.username), price = int(body.price, 1, 1e9);
    const n = db.prepare('SELECT * FROM usernames WHERE name=?').get(name);
    if (!n || n.owner_id !== user.id) throw new HttpError(404, 'not_found');
    if (n.is_primary) throw new HttpError(409, 'primary_not_sellable');
    try {
      const r = db.prepare("INSERT INTO listings(username,seller_id,price,status,created) VALUES(?,?,?,'active',?)").run(name, user.id, price, Date.now());
      return [201, { id: Number(r.lastInsertRowid) }];
    } catch (e) { if (uniq(e)) throw new HttpError(409, 'already_listed'); throw e; }
  });

  route('POST', '/market/:id/cancel', {}, ({ user, params }) => {
    const r = db.prepare("UPDATE listings SET status='cancelled' WHERE id=? AND seller_id=? AND status='active'").run(pid(params.id), user.id);
    if (r.changes !== 1) throw new HttpError(404, 'not_found');
    return { ok: true };
  });

  route('POST', '/market/:id/buy', { rlu: ['buy', 20, 60e3] }, ({ user, params }) => {
    const id = pid(params.id);
    return tx(() => {
      const l = db.prepare('SELECT * FROM listings WHERE id=?').get(id);
      if (!l || l.status !== 'active') throw new HttpError(409, 'not_available');
      if (l.seller_id === user.id) throw bad();
      if (extraCount(user.id) >= OWN_CAP) throw new HttpError(409, 'limit_reached');
      const now = Date.now();
      if (db.prepare("UPDATE listings SET status='sold',buyer_id=?,sold_at=? WHERE id=? AND status='active'").run(user.id, now, id).changes !== 1)
        throw new HttpError(409, 'not_available');
      if (db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(l.price, user.id, l.price).changes !== 1)
        throw new HttpError(402, 'insufficient_funds');
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(l.price, l.seller_id);
      if (db.prepare('UPDATE usernames SET owner_id=? WHERE name=? AND owner_id=? AND is_primary=0').run(user.id, l.username, l.seller_id).changes !== 1)
        throw new HttpError(409, 'not_available');
      db.prepare("INSERT INTO ledger(from_id,to_id,amount,kind,client_id,ts) VALUES(?,?,?,'market',?,?)").run(user.id, l.seller_id, l.price, 'listing-' + id, now);
      return { balance: balanceOf(user.id), username: l.username };
    });
  });

  // ---------- admin / founder ----------
  route('GET', '/admin/users', { role: 'admin' }, () => ({
    items: db.prepare('SELECT id,username,role,banned,balance FROM users ORDER BY id DESC LIMIT 200').all().map((u) => ({ ...u, banned: !!u.banned })),
  }));

  route('POST', '/admin/ban', { role: 'admin' }, ({ user, body }) => {
    const t = db.prepare('SELECT id,role FROM users WHERE username=?').get(uname(body.username));
    if (!t) throw new HttpError(404, 'user_not_found');
    if (typeof body.banned !== 'boolean') throw bad();
    if (RANK[t.role] >= RANK[user.role]) throw new HttpError(403, 'forbidden');
    db.prepare('UPDATE users SET banned=? WHERE id=?').run(body.banned ? 1 : 0, t.id);
    if (body.banned) db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(t.id);
    audit(user.id, body.banned ? 'ban' : 'unban', t.id);
    return { ok: true };
  });

  route('POST', '/admin/grant', { role: 'founder', rlu: ['grant', 30, 3600e3] }, ({ user, body }) => {
    const t = db.prepare('SELECT id FROM users WHERE username=?').get(uname(body.username));
    if (!t) throw new HttpError(404, 'user_not_found');
    const amount = int(body.amount, 1, 1e9);
    tx(() => {
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount, t.id);
      db.prepare("INSERT INTO ledger(from_id,to_id,amount,kind,ts) VALUES(NULL,?,?,'grant',?)").run(t.id, amount, Date.now());
      audit(user.id, 'grant_aster', t.id, amount);
    });
    return { ok: true };
  });

  route('POST', '/admin/role', { role: 'founder' }, ({ user, body }) => {
    const t = db.prepare('SELECT id,role FROM users WHERE username=?').get(uname(body.username));
    if (!t) throw new HttpError(404, 'user_not_found');
    if (!['user', 'admin'].includes(body.role) || t.role === 'founder') throw bad();
    db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, t.id);
    audit(user.id, 'set_role', t.id, body.role);
    return { ok: true };
  });

  route('GET', '/admin/audit', { role: 'founder' }, () => ({ items: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() }));

  // ---------- HTTP plumbing ----------
  const clientIp = (req) => {
    if (trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (x) return x; }
    return req.socket.remoteAddress || 'unknown';
  };

  function readBody(req, max = 65536) {
    return new Promise((resolve, reject) => {
      let size = 0, over = false; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max * 8) req.destroy();
        else if (size > max) over = true;
        else chunks.push(c);
      });
      req.on('end', () => (over ? reject(new HttpError(413, 'too_large')) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  function send(res, status, obj) {
    const data = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
    });
    res.end(data);
  }

  async function handle(req, res) {
    const ip = clientIp(req);
    let status = 500;
    try {
      if (!limit('g:' + ip, 600, 60e3)) throw new HttpError(429, 'rate_limited');
      const url = new URL(req.url, 'http://x');
      let m, params;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const x = r.re.exec(url.pathname);
        if (x) { m = r; params = { ...x.groups }; break; }
      }
      if (!m) throw new HttpError(404, 'not_found');
      let user = null;
      if (m.auth) {
        user = authenticate(req);
        if (!user) throw new HttpError(401, 'unauthorized');
        if (m.role && RANK[user.role] < RANK[m.role]) throw new HttpError(403, 'forbidden');
      }
      if (m.rl && !limit(`${m.rl[0]}:${ip}`, m.rl[1], m.rl[2])) throw new HttpError(429, 'rate_limited');
      if (m.rlu && !limit(`${m.rlu[0]}:u${user.id}`, m.rlu[1], m.rlu[2])) throw new HttpError(429, 'rate_limited');
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        if (Number(req.headers['content-length'] || 0) > 65536) { req.resume(); throw new HttpError(413, 'too_large'); }
        const raw = await readBody(req);
        if (raw.length) {
          if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'unsupported_media_type');
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('invalid_json'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_json');
        }
      }
      let out = await m.fn({ req, ip, user, params, query: url.searchParams, body });
      status = 200;
      if (Array.isArray(out)) [status, out] = out;
      send(res, status, out);
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; send(res, e.status, { error: e.code }); }
      else { console.error('internal error:', e?.message); status = 500; send(res, 500, { error: 'internal_error' }); }
    }
    if (process.env.LOG_REQUESTS === '1') console.log(req.method, (req.url || '').split('?')[0], status); // never log bodies/tokens
  }

  const server = http.createServer(handle);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  setInterval(() => db.prepare('DELETE FROM sessions WHERE refresh_exp<? OR (revoked=1 AND created<?)').run(Date.now(), Date.now() - 7 * 86400e3), 3600e3).unref();
  return { server, db };
}
