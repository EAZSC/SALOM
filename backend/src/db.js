import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin','founder')),
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
  banned INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  pubkey TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usernames(
  name TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  access_hash TEXT NOT NULL UNIQUE,
  access_exp INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT,
  refresh_exp INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_prev ON sessions(prev_refresh_hash);
CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('normal','secret')),
  status TEXT NOT NULL CHECK(status IN ('active','pending','rejected')),
  requested_by INTEGER,
  created INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  CHECK(user_a<user_b),
  UNIQUE(user_a,user_b,kind)
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  conv_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  body TEXT,
  cipher_recipient TEXT,
  cipher_sender TEXT,
  created INTEGER NOT NULL,
  UNIQUE(conv_id,sender_id,client_id)
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv_id,id);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY,
  from_id INTEGER REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK(amount>0),
  kind TEXT NOT NULL,
  client_id TEXT,
  ts INTEGER NOT NULL,
  UNIQUE(from_id,client_id)
);
CREATE TABLE IF NOT EXISTS listings(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL REFERENCES usernames(name),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  price INTEGER NOT NULL CHECK(price>0),
  status TEXT NOT NULL CHECK(status IN ('active','sold','cancelled')),
  buyer_id INTEGER,
  created INTEGER NOT NULL,
  sold_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS listings_one_active ON listings(username) WHERE status='active';
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`);
  return db;
}
