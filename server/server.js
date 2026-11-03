// Serves PatchLab on Cloud Run and keeps each signed-in user's lab apart.
// IAP signs every request with x-goog-iap-jwt-assertion; the server verifies that JWT and
// stores one JSON document per user in Cloud Storage. No npm dependencies.
//
// Environment:
//   PORT          port to listen on (Cloud Run sets 8080)
//   IAP_AUDIENCE  /projects/NUMBER/locations/REGION/services/SERVICE, checked against the JWT
//   BUCKET        Cloud Storage bucket for user labs; without it, labs go to ./data (local runs)
//   DEV_USER      local testing only: treat every request as this email instead of checking IAP
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = +process.env.PORT || 8080;
const AUD = process.env.IAP_AUDIENCE || '';
const BUCKET = process.env.BUCKET || '';
const DEV_USER = process.env.DEV_USER || '';
const MAX_BODY = 4 * 1024 * 1024;
const PAGE = path.join(__dirname, '..', 'dist', 'patchlab.html');
const DATA = path.join(__dirname, '..', 'data');

if (process.env.K_SERVICE && (DEV_USER || !AUD || !BUCKET)) {
  console.error('On Cloud Run, set IAP_AUDIENCE and BUCKET, and never DEV_USER.');
  process.exit(1);
}

const PAGE_HTML = fs.readFileSync(PAGE);

// ---------- IAP identity ----------

let keys = { at: 0, byKid: {} };

async function iapKeys() {
  if (Date.now() - keys.at < 3600e3 && Object.keys(keys.byKid).length) return keys.byKid;
  const res = await fetch('https://www.gstatic.com/iap/verify/public_key-jwk');
  if (!res.ok) throw new Error(`IAP keys: HTTP ${res.status}`);
  const byKid = {};
  (await res.json()).keys.forEach((k) => { byKid[k.kid] = crypto.createPublicKey({ key: k, format: 'jwk' }); });
  keys = { at: Date.now(), byKid };
  return byKid;
}

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Returns { email, sub } from a valid IAP JWT, or null.
async function verifyIap(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let head;
  let body;
  try {
    head = JSON.parse(b64(parts[0]).toString());
    body = JSON.parse(b64(parts[1]).toString());
  } catch (e) {
    return null;
  }
  if (head.alg !== 'ES256') return null;
  const key = (await iapKeys())[head.kid];
  if (!key) return null;
  const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, b64(parts[2]));
  const now = Date.now() / 1000;
  if (!ok || body.iss !== 'https://cloud.google.com/iap' || !(body.exp > now) || !(body.iat < now + 60)) return null;
  if (AUD && body.aud !== AUD) return null;
  if (!body.email || !body.sub) return null;
  return { email: String(body.email).toLowerCase(), sub: body.sub };
}

async function userOf(req) {
  if (DEV_USER) {
    const as = req.headers['x-dev-user'] || DEV_USER;
    return { email: String(as).toLowerCase(), sub: `dev:${as}` };
  }
  return verifyIap(req.headers['x-goog-iap-jwt-assertion']);
}

// ---------- Storage ----------

// Object names use a hash of the stable IAP subject, so emails do not appear in listings.
const objectFor = (user) => `users/${crypto.createHash('sha256').update(user.sub).digest('hex')}.json`;

let token = { at: 0, value: '' };

async function accessToken() {
  if (Date.now() - token.at < 50 * 60e3 && token.value) return token.value;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
  token = { at: Date.now(), value: (await res.json()).access_token };
  return token.value;
}

async function load(user) {
  const name = objectFor(user);
  if (!BUCKET) {
    const file = path.join(DATA, path.basename(name));
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`load: HTTP ${res.status}`);
  return res.text();
}

async function save(user, text) {
  const name = objectFor(user);
  if (!BUCKET) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, path.basename(name)), text);
    return;
  }
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST', body: text, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`save: HTTP ${res.status}`);
}

// ---------- HTTP ----------

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-store' };

function send(req, res, status, body, type) {
  let data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { ...SECURITY, 'Content-Type': type || 'application/json; charset=utf-8' };
  if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = zlib.gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(status, headers);
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method not allowed' });
    return send(req, res, 200, PAGE_HTML, 'text/html; charset=utf-8');
  }
  const user = await userOf(req);
  if (!user) return send(req, res, 401, { error: 'Not signed in through IAP.' });
  if (url.pathname === '/api/me' && req.method === 'GET') return send(req, res, 200, { email: user.email });
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const text = await load(user);
    // A new user has nothing saved yet; that is not an error.
    if (!text) {
      res.writeHead(204, SECURITY);
      return res.end();
    }
    return send(req, res, 200, text);
  }
  if (url.pathname === '/api/state' && req.method === 'PUT') {
    // Same-origin requests only: the page itself sends this header.
    if (req.headers['x-patchlab'] !== '1') return send(req, res, 403, { error: 'forbidden' });
    const text = await readBody(req);
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      return send(req, res, 400, { error: 'Not JSON.' });
    }
    if (!doc || typeof doc !== 'object' || !doc.project || !Array.isArray(doc.project.devices)) return send(req, res, 400, { error: 'Not a PatchLab lab.' });
    await save(user, JSON.stringify({ project: doc.project, savedAt: new Date().toISOString(), email: user.email }));
    return send(req, res, 200, { ok: true });
  }
  return send(req, res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(req, res, err.status || 500, { error: err.status === 413 ? 'Lab too large.' : 'Server error.' });
  });
}).listen(PORT, () => console.log(`PatchLab on :${PORT}${BUCKET ? ` (bucket ${BUCKET})` : ' (local ./data)'}${DEV_USER ? ' DEV_USER mode' : ''}${AUD ? '' : ' (no IAP audience check)'}`));
