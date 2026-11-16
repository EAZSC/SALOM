import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';

const dbPath = process.env.DB_PATH || './data/mivo.db';
mkdirSync(dirname(dbPath), { recursive: true });
const { server } = createApp({ dbPath, trustProxy: process.env.TRUST_PROXY === '1' });
const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => console.log(`MIVO backend listening on :${port}`));
