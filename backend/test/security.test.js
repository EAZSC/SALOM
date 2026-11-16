import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function boot(opts = { limits: false }) {
  const { server, db } = createApp(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token, extra = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  let n = 0;
  const reg = async (name) => {
    const username = name || `user${Date.now() % 100000}x${n++}`;
    const r = await call('POST', '/auth/register', { username, password: 'Str0ng-Pass-123' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { username, token: r.json.access_token, refresh: r.json.refresh_token, id: r.json.user.id };
  };
  const grant = (username, amount) => {
    db.prepare("UPDATE users SET balance=balance+? WHERE username=?").run(amount, username); // test helper = direct DB
  };
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { call, reg, grant, db, close, base };
}

test('T1 IDOR: outsider cannot read or write another pair\'s chat', async () => {
  const s = await boot();
  const a = await s.reg('alice_one'), b = await s.reg('bob_two'), c = await s.reg('carol_three');
  const conv = await s.call('POST', '/conversations', { username: 'bob_two', kind: 'normal' }, a.token);
  assert.equal(conv.status, 201);
  await s.call('POST', `/conversations/${conv.json.id}/messages`, { client_msg_id: 'msg-00000001', body: 'salom' }, a.token);
  assert.equal((await s.call('GET', `/conversations/${conv.json.id}/messages`, undefined, c.token)).status, 404);
  assert.equal((await s.call('POST', `/conversations/${conv.json.id}/messages`, { client_msg_id: 'msg-00000002', body: 'hack' }, c.token)).status, 404);
  assert.equal((await s.call('POST', `/conversations/${conv.json.id}/respond`, { accept: true }, c.token)).status, 404);
  assert.equal((await s.call('GET', `/conversations/${conv.json.id}/messages`, undefined, b.token)).json.items.length, 1);
  await s.close();
});

test('T2 ASTER: balance cannot be changed by other users or by crafted input', async () => {
  const s = await boot();
  const a = await s.reg('alice_one'), b = await s.reg('bob_two'), c = await s.reg('carol_three');
  s.grant('alice_one', 100);
  const mk = (extra) => ({ to_username: 'bob_two', client_tx_id: 'tx-' + Math.random().toString(36).slice(2, 12), ...extra });
  assert.equal((await s.call('POST', '/wallet/transfer', mk({ amount: -5 }), c.token)).status, 400);
  assert.equal((await s.call('POST', '/wallet/transfer', mk({ amount: 1.5 }), c.token)).status, 400);
  assert.equal((await s.call('POST', '/wallet/transfer', mk({ amount: '10' }), c.token)).status, 400);
  assert.equal((await s.call('POST', '/wallet/transfer', mk({ amount: 10 }), c.token)).status, 402); // carol has 0
  const own = await s.call('POST', '/wallet/transfer', { to_username: 'alice_one', amount: 1, client_tx_id: 'tx-selfself1' }, a.token);
  assert.equal(own.status, 400);
  // attacker sets from/balance fields: ignored, still debits carol only
  assert.equal((await s.call('POST', '/wallet/transfer', mk({ amount: 10, from_id: a.id, balance: 99999 }), c.token)).status, 402);
  // mass assignment at registration and no balance-writing endpoint
  const r = await s.call('POST', '/auth/register', { username: 'mallory_x', password: 'Str0ng-Pass-123', balance: 5000, role: 'founder' });
  const me = await s.call('GET', '/me', undefined, r.json.access_token);
  assert.equal(me.json.balance, 0); assert.equal(me.json.role, 'user');
  assert.equal((await s.call('PUT', '/me', { balance: 1e6 }, c.token)).status, 404);
  assert.equal((await s.call('PATCH', '/me', { balance: 1e6 }, c.token)).status, 404);
  // legit transfer + idempotent retry
  const ok = await s.call('POST', '/wallet/transfer', { to_username: 'bob_two', amount: 30, client_tx_id: 'tx-legit0001' }, a.token);
  assert.equal(ok.json.balance, 70);
  const retry = await s.call('POST', '/wallet/transfer', { to_username: 'bob_two', amount: 30, client_tx_id: 'tx-legit0001' }, a.token);
  assert.equal(retry.json.balance, 70); assert.equal(retry.json.duplicate, true);
  assert.equal((await s.call('GET', '/me', undefined, b.token)).json.balance, 30);
  // double-spend race
  const race = await Promise.all([1, 2, 3, 4, 5].map((i) => s.call('POST', '/wallet/transfer', { to_username: 'carol_three', amount: 60, client_tx_id: 'race-tx-000' + i }, a.token)));
  assert.equal(race.filter((x) => x.status === 200).length, 1);
  assert.equal((await s.call('GET', '/me', undefined, a.token)).json.balance, 10);
  await s.close();
});

test('T3 Privilege escalation: normal user cannot become admin/founder', async () => {
  const s = await boot();
  const a = await s.reg('alice_one'); await s.reg('bob_two');
  for (const [m, p, b] of [['GET', '/admin/users'], ['POST', '/admin/ban', { username: 'bob_two', banned: true }], ['POST', '/admin/grant', { username: 'alice_one', amount: 100 }], ['POST', '/admin/role', { username: 'alice_one', role: 'admin' }], ['GET', '/admin/audit']])
    assert.equal((await s.call(m, p, b, a.token)).status, 403, p);
  // admin cannot grant ASTER (founder only) nor ban another admin/founder
  s.db.prepare("UPDATE users SET role='admin' WHERE username='alice_one'").run();
  s.db.prepare("INSERT INTO users(username,pw_hash,role,created) VALUES('boss_one','x','founder',0)").run();
  s.db.prepare("INSERT INTO usernames(name,owner_id,is_primary) VALUES('boss_one',(SELECT id FROM users WHERE username='boss_one'),1)").run();
  assert.equal((await s.call('POST', '/admin/grant', { username: 'alice_one', amount: 100 }, a.token)).status, 403);
  assert.equal((await s.call('POST', '/admin/ban', { username: 'boss_one', banned: true }, a.token)).status, 403);
  assert.equal((await s.call('POST', '/admin/ban', { username: 'bob_two', banned: true }, a.token)).status, 200);
  assert.equal((await s.call('POST', '/auth/login', { username: 'bob_two', password: 'Str0ng-Pass-123' })).status, 403);
  await s.close();
});

test('T4 Marketplace: a username cannot be sold twice (race)', async () => {
  const s = await boot();
  const seller = await s.reg('seller_one'), b1 = await s.reg('buyer_one'), b2 = await s.reg('buyer_two');
  s.grant('buyer_one', 100); s.grant('buyer_two', 100);
  assert.equal((await s.call('POST', '/usernames/claim', { username: 'rare_name' }, seller.token)).status, 201);
  const l = await s.call('POST', '/market/list', { username: 'rare_name', price: 40 }, seller.token);
  assert.equal(l.status, 201);
  assert.equal((await s.call('POST', '/market/list', { username: 'rare_name', price: 10 }, seller.token)).status, 409);
  assert.equal((await s.call('POST', '/market/list', { username: 'seller_one', price: 10 }, seller.token)).status, 409); // primary
  assert.equal((await s.call('POST', '/market/list', { username: 'rare_name', price: 10 }, b1.token)).status, 404); // not owner
  const res = await Promise.all([s.call('POST', `/market/${l.json.id}/buy`, {}, b1.token), s.call('POST', `/market/${l.json.id}/buy`, {}, b2.token)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  const total = ['buyer_one', 'buyer_two', 'seller_one'].reduce((t, u) => t + s.db.prepare('SELECT balance FROM users WHERE username=?').get(u).balance, 0);
  assert.equal(total, 200); // ASTER conserved
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM usernames WHERE name='rare_name'").get().c, 1);
  assert.equal((await s.call('GET', '/me', undefined, seller.token)).json.balance, 40);
  await s.close();
});

test('T5 Tokens: refresh rotation, reuse detection, logout, expiry', async () => {
  const s = await boot();
  const a = await s.reg('alice_one');
  const r1 = await s.call('POST', '/auth/refresh', { refresh_token: a.refresh });
  assert.equal(r1.status, 200);
  assert.equal((await s.call('GET', '/me', undefined, a.token)).status, 401); // old access dead after rotation
  assert.equal((await s.call('GET', '/me', undefined, r1.json.access_token)).status, 200);
  const replay = await s.call('POST', '/auth/refresh', { refresh_token: a.refresh }); // stolen/old refresh reused
  assert.equal(replay.status, 401);
  assert.equal((await s.call('GET', '/me', undefined, r1.json.access_token)).status, 401); // whole session revoked
  assert.equal((await s.call('POST', '/auth/refresh', { refresh_token: r1.json.refresh_token })).status, 401);
  const l = await s.call('POST', '/auth/login', { username: 'alice_one', password: 'Str0ng-Pass-123' });
  assert.equal((await s.call('POST', '/auth/logout', {}, l.json.access_token)).status, 200);
  assert.equal((await s.call('GET', '/me', undefined, l.json.access_token)).status, 401);
  const l2 = await s.call('POST', '/auth/login', { username: 'alice_one', password: 'Str0ng-Pass-123' });
  s.db.prepare('UPDATE sessions SET access_exp=1').run();
  assert.equal((await s.call('GET', '/me', undefined, l2.json.access_token)).status, 401);
  assert.equal((await s.call('GET', '/me', undefined, 'garbage')).status, 401);
  assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='refresh_reuse_detected'").get());
  await s.close();
});

test('T6 Brute force: account lockout, IP rate limit, password policy', async () => {
  const s = await boot();
  await s.reg('alice_one');
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/auth/login', { username: 'alice_one', password: 'wrong-pass-' + i })).status, 401);
  assert.equal((await s.call('POST', '/auth/login', { username: 'alice_one', password: 'Str0ng-Pass-123' })).status, 429); // locked even for correct pw
  // parallel guesses cannot bypass the counter
  await s.reg('bob_two');
  const par = await Promise.all(Array.from({ length: 12 }, (_, i) => s.call('POST', '/auth/login', { username: 'bob_two', password: 'bad-guess-' + i })));
  assert.ok(par.some((r) => r.status === 429) || s.db.prepare("SELECT locked_until l FROM users WHERE username='bob_two'").get().l > Date.now());
  for (const pw of ['short1A', 'password123', '1111111111aa', 'alllettersonly']) {
    assert.equal((await s.call('POST', '/auth/register', { username: 'weak_' + pw.length, password: pw })).status, 400, pw);
  }
  await s.close();
  const s2 = await boot({ limits: true });
  await s2.reg('carol_three');
  let last;
  for (let i = 0; i < 22; i++) last = await s2.call('POST', '/auth/login', { username: 'nobody_x' + (i % 3), password: 'whatever-123' });
  assert.equal(last.status, 429);
  await s2.close();
});

test('T7 Every protected route rejects missing/invalid tokens; input hardening', async () => {
  const s = await boot();
  const a = await s.reg('alice_one');
  const protectedRoutes = [['GET', '/me'], ['PUT', '/keys', { pubkey: 'AAAA' }], ['GET', '/users/bob_two/key'], ['GET', '/conversations'], ['POST', '/conversations', { username: 'bob_two', kind: 'normal' }],
    ['POST', '/conversations/1/respond', { accept: true }], ['GET', '/conversations/1/messages'], ['POST', '/conversations/1/messages', { client_msg_id: 'abcdefgh1', body: 'x' }],
    ['POST', '/wallet/transfer', { to_username: 'bob_two', amount: 1, client_tx_id: 'abcdefgh1' }], ['GET', '/wallet/history'], ['POST', '/usernames/claim', { username: 'abcd' }], ['GET', '/market'],
    ['POST', '/market/list', { username: 'abcd', price: 1 }], ['POST', '/market/1/buy', {}], ['POST', '/market/1/cancel', {}], ['GET', '/admin/users'], ['POST', '/admin/ban', {}], ['POST', '/admin/grant', {}], ['POST', '/admin/role', {}], ['GET', '/admin/audit'], ['POST', '/auth/logout', {}]];
  for (const [m, p, b] of protectedRoutes) {
    assert.equal((await s.call(m, p, b)).status, 401, `${m} ${p} no token`);
    assert.equal((await s.call(m, p, b, 'x'.repeat(43))).status, 401, `${m} ${p} bad token`);
  }
  // SQL injection attempts
  assert.equal((await s.call('POST', '/auth/login', { username: "' OR 1=1--", password: 'x' })).status, 400);
  assert.equal((await s.call('POST', '/auth/register', { username: "a'; DROP TABLE users;--", password: 'Str0ng-Pass-123' })).status, 400);
  const c = await s.call('POST', '/conversations', { username: 'alice_one', kind: 'normal' }, a.token); // self → 400
  assert.equal(c.status, 400);
  await s.reg('bob_two');
  const cv = await s.call('POST', '/conversations', { username: 'bob_two', kind: 'normal' }, a.token);
  const evil = "x'); DROP TABLE messages;-- <script>alert(1)</script>";
  assert.equal((await s.call('POST', `/conversations/${cv.json.id}/messages`, { client_msg_id: 'evilmsg001', body: evil }, a.token)).status, 201);
  assert.equal((await s.call('GET', `/conversations/${cv.json.id}/messages`, undefined, a.token)).json.items[0].body, evil); // stored literally, JSON-only responses
  assert.equal((await s.call('GET', '/conversations/1%20OR%201=1/messages', undefined, a.token)).status, 400);
  // size / type / malformed
  assert.equal((await s.call('POST', '/auth/login', 'x'.repeat(70000), undefined, { 'Content-Type': 'application/json' })).status, 413);
  assert.equal((await s.call('POST', '/auth/login', '{bad json', undefined, { 'Content-Type': 'application/json' })).status, 400);
  assert.equal((await s.call('POST', '/auth/login', 'a=b', undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.call('POST', '/auth/login', '[1,2]', undefined, { 'Content-Type': 'application/json' })).status, 400);
  await s.close();
});

test('T8 Secret chat (server side): consent, no plaintext, no fallback to normal chat', async () => {
  const s = await boot();
  const a = await s.reg('alice_one'), b = await s.reg('bob_two');
  assert.equal((await s.call('POST', '/conversations', { username: 'bob_two', kind: 'secret' }, a.token)).status, 409); // no keys yet
  await s.call('PUT', '/keys', { pubkey: 'QUFBQUFBQUE=' }, a.token); await s.call('PUT', '/keys', { pubkey: 'QkJCQkJCQkI=' }, b.token);
  const sc = await s.call('POST', '/conversations', { username: 'bob_two', kind: 'secret' }, a.token);
  assert.equal(sc.json.status, 'pending');
  const m = (body) => s.call('POST', `/conversations/${sc.json.id}/messages`, body, a.token);
  assert.equal((await m({ client_msg_id: 'secretmsg1', cipher_recipient: 'QUJD', cipher_sender: 'REVG' })).status, 409); // no consent yet
  assert.equal((await s.call('POST', `/conversations/${sc.json.id}/respond`, { accept: true }, a.token)).status, 409); // requester can't self-accept
  assert.equal((await s.call('POST', `/conversations/${sc.json.id}/respond`, { accept: false }, b.token)).json.status, 'rejected');
  assert.equal((await m({ client_msg_id: 'secretmsg2', cipher_recipient: 'QUJD', cipher_sender: 'REVG' })).status, 409); // rejected → nothing sent
  assert.equal((await s.call('POST', '/conversations', { username: 'bob_two', kind: 'secret' }, a.token)).status, 409); // requester cannot spam
  const nm = await s.call('POST', '/conversations', { username: 'bob_two', kind: 'normal' }, a.token);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM messages WHERE conv_id=?').get(nm.json.id).c, 0); // no auto fallback
  // re-open by rejector, accept, then send
  const re = await s.call('POST', '/conversations', { username: 'alice_one', kind: 'secret' }, b.token);
  assert.equal(re.json.status, 'pending');
  assert.equal((await s.call('POST', `/conversations/${sc.json.id}/respond`, { accept: true }, a.token)).json.status, 'active');
  assert.equal((await m({ client_msg_id: 'secretmsg3', body: 'ochiq matn' })).status, 400); // plaintext refused
  assert.equal((await m({ client_msg_id: 'secretmsg4', cipher_recipient: 'QUJD', cipher_sender: '###' })).status, 400);
  assert.equal((await m({ client_msg_id: 'secretmsg5', cipher_recipient: 'Q0lQSEVSLUZPUi1CT0I=', cipher_sender: 'Q0lQSEVSLUZPUi1BTElDRQ==' })).status, 201);
  const rb = (await s.call('GET', `/conversations/${sc.json.id}/messages`, undefined, b.token)).json.items[0];
  const ra = (await s.call('GET', `/conversations/${sc.json.id}/messages`, undefined, a.token)).json.items[0];
  assert.equal(rb.cipher, 'Q0lQSEVSLUZPUi1CT0I='); assert.equal(ra.cipher, 'Q0lQSEVSLUZPUi1BTElDRQ=='); assert.equal(rb.body, undefined);
  const row = s.db.prepare('SELECT * FROM messages WHERE conv_id=?').get(sc.json.id);
  assert.equal(row.body, null);
  // normal chat refuses cipher fields
  assert.equal((await s.call('POST', `/conversations/${nm.json.id}/messages`, { client_msg_id: 'normalmsg1', body: 'x', cipher_sender: 'QUJD' }, a.token)).status, 400);
  await s.close();
});

test('T9 Reliability: retries with same client id never duplicate messages', async () => {
  const s = await boot();
  const a = await s.reg('alice_one'); await s.reg('bob_two');
  const cv = await s.call('POST', '/conversations', { username: 'bob_two', kind: 'normal' }, a.token);
  const send = () => s.call('POST', `/conversations/${cv.json.id}/messages`, { client_msg_id: 'retry-id-0001', body: 'bir marta' }, a.token);
  const rs = await Promise.all([send(), send(), send()]);
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201));
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM messages WHERE conv_id=?').get(cv.json.id).c, 1);
  await s.close();
});

test('T10 Response hygiene: security headers, no secrets in audit/db, passwords hashed', async () => {
  const s = await boot();
  await s.reg('alice_one');
  const res = await fetch(s.base + '/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!res.headers.get('x-powered-by'));
  const u = s.db.prepare("SELECT pw_hash FROM users WHERE username='alice_one'").get();
  assert.ok(u.pw_hash.startsWith('s1$') && !u.pw_hash.includes('Str0ng'));
  const tok = s.db.prepare('SELECT access_hash FROM sessions').get().access_hash;
  assert.equal(tok.length, 64); // only SHA-256 digests of tokens are stored
  await s.close();
});
