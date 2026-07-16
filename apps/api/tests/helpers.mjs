import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load .env from repo root if present and env not already set
const envPath = resolve(__dir, '../../../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file — use actual env vars */ }

export const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  && !process.env.SUPABASE_URL.includes('your-project'));

let _server = null;
let _baseUrl = null;

export async function startServer() {
  if (_server) return _baseUrl;

  // Dynamic import so env vars are loaded first
  const { app } = await import('../src/index.mjs');

  return new Promise((resolve, reject) => {
    _server = createServer(app);
    _server.listen(0, '127.0.0.1', () => {
      const { port } = _server.address();
      _baseUrl = `http://127.0.0.1:${port}`;
      resolve(_baseUrl);
    });
    _server.on('error', reject);
  });
}

export async function stopServer() {
  if (!_server) return;
  await new Promise(res => _server.close(res));
  _server = null;
  _baseUrl = null;
}

export async function get(path, headers = {}) {
  const base = await startServer();
  return fetch(`${base}${path}`, { headers });
}

export async function post(path, body, headers = {}) {
  const base = await startServer();
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function patch(path, body, headers = {}) {
  const base = await startServer();
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function del(path, headers = {}) {
  const base = await startServer();
  return fetch(`${base}${path}`, { method: 'DELETE', headers });
}
