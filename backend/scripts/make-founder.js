// Server-side only: npm run make-founder -- <username>
// There is deliberately NO network API that can create a founder.
import { openDb } from '../src/db.js';
const name = (process.argv[2] || '').toLowerCase();
const db = openDb(process.env.DB_PATH || './data/mivo.db');
const r = db.prepare("UPDATE users SET role='founder' WHERE username=?").run(name);
if (r.changes !== 1) { console.error('User not found:', name); process.exit(1); }
db.prepare('INSERT INTO audit(ts,actor_id,action,target) VALUES(?,?,?,?)').run(Date.now(), null, 'cli_make_founder', name);
console.log('OK:', name, 'is now founder');
