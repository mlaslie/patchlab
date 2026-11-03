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

// The page is marked as served by this server, so the app only asks for /api where it exists.
const PAGE_HTML = Buffer.from(fs.readFileSync(PAGE, 'utf8').replace('<head>', '<head>\n<meta name="patchlab-server" content="1">'));

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
// users/<hash>.json is the working lab (autosaved); users/<hash>/labs/<name>.json are the labs
// the user saved by name, each overwritten by the next save of the same name.
const userKey = (user) => crypto.createHash('sha256').update(user.sub).digest('hex');
const workingObject = (user) => `users/${userKey(user)}.json`;
const labPrefix = (user) => `users/${userKey(user)}/labs/`;

// Lab names become object names: letters, digits, dot, dash and underscore only.
const slug = (name) => String(name || '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);

let token = { at: 0, value: '' };

async function accessToken() {
  if (Date.now() - token.at < 50 * 60e3 && token.value) return token.value;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
  token = { at: Date.now(), value: (await res.json()).access_token };
  return token.value;
}

const localPath = (name) => path.join(DATA, ...name.split('/'));

async function getObject(name) {
  if (!BUCKET) return fs.existsSync(localPath(name)) ? fs.readFileSync(localPath(name), 'utf8') : null;
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${name}: HTTP ${res.status}`);
  return res.text();
}

async function putObject(name, text) {
  if (!BUCKET) {
    fs.mkdirSync(path.dirname(localPath(name)), { recursive: true });
    fs.writeFileSync(localPath(name), text);
    return;
  }
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST', body: text, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`put ${name}: HTTP ${res.status}`);
}

async function deleteObject(name) {
  if (!BUCKET) {
    if (!fs.existsSync(localPath(name))) return false;
    fs.unlinkSync(localPath(name));
    return true;
  }
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`delete ${name}: HTTP ${res.status}`);
  return true;
}

// Objects under a prefix, newest first: [{ name, updated, size }].
async function listObjects(prefix) {
  if (!BUCKET) {
    const dir = localPath(prefix);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: prefix + f, updated: st.mtime.toISOString(), size: st.size };
    }).sort((a, b) => b.updated.localeCompare(a.updated));
  }
  const out = [];
  let page = '';
  do {
    const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}&fields=nextPageToken,items(name,updated,size)${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) throw new Error(`list: HTTP ${res.status}`);
    const body = await res.json();
    (body.items || []).forEach((i) => out.push({ name: i.name, updated: i.updated, size: +i.size }));
    page = body.nextPageToken || '';
  } while (page);
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
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
  // Writes must come from the page itself, which sends this header; a plain cross-site form cannot.
  if (req.method !== 'GET' && req.headers['x-patchlab'] !== '1') return send(req, res, 403, { error: 'forbidden' });
  const readLab = async () => {
    let doc;
    try {
      doc = JSON.parse(await readBody(req));
    } catch (e) {
      return null;
    }
    return doc && typeof doc === 'object' && doc.project && Array.isArray(doc.project.devices) ? doc.project : null;
  };
  const stamp = (project) => JSON.stringify({ project, savedAt: new Date().toISOString(), email: user.email });

  // The working lab, saved as the user edits.
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const text = await getObject(workingObject(user));
    // A new user has nothing saved yet; that is not an error.
    if (!text) {
      res.writeHead(204, SECURITY);
      return res.end();
    }
    return send(req, res, 200, text);
  }
  if (url.pathname === '/api/state' && req.method === 'PUT') {
    const project = await readLab();
    if (!project) return send(req, res, 400, { error: 'Not a PatchLab lab.' });
    await putObject(workingObject(user), stamp(project));
    return send(req, res, 200, { ok: true });
  }

  // Labs saved by name. Saving a name again replaces the earlier copy.
  if (url.pathname === '/api/labs' && req.method === 'GET') {
    const prefix = labPrefix(user);
    const items = await listObjects(prefix);
    return send(req, res, 200, { labs: items.map((i) => ({ id: i.name.slice(prefix.length).replace(/\.json$/, ''), savedAt: i.updated, size: i.size })) });
  }
  const m = /^\/api\/labs\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const id = slug(decodeURIComponent(m[1]));
    if (!id) return send(req, res, 400, { error: 'Give the lab a name.' });
    const name = `${labPrefix(user)}${id}.json`;
    if (req.method === 'GET') {
      const text = await getObject(name);
      return text ? send(req, res, 200, text) : send(req, res, 404, { error: 'No saved lab by that name.' });
    }
    if (req.method === 'PUT') {
      const project = await readLab();
      if (!project) return send(req, res, 400, { error: 'Not a PatchLab lab.' });
      await putObject(name, stamp(project));
      return send(req, res, 200, { ok: true, id });
    }
    if (req.method === 'DELETE') {
      return (await deleteObject(name)) ? send(req, res, 200, { ok: true }) : send(req, res, 404, { error: 'No saved lab by that name.' });
    }
  }
  return send(req, res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(req, res, err.status || 500, { error: err.status === 413 ? 'Lab too large.' : 'Server error.' });
  });
}).listen(PORT, () => console.log(`PatchLab on :${PORT}${BUCKET ? ` (bucket ${BUCKET})` : ' (local ./data)'}${DEV_USER ? ' DEV_USER mode' : ''}${AUD ? '' : ' (no IAP audience check)'}`));
