// Ravians FM – Campus Web Radio server
// Serves the website, the audio library, and relays the live microphone stream
// from the presenter (Studio page) to every listener over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PIN = process.env.STUDIO_PIN || 'ravians';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const AUDIO = path.join(ROOT, 'audio');
const DATA = path.join(ROOT, 'data');
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.flac'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.webm': 'audio/webm', '.flac': 'audio/flac'
};

// ---------- helpers ----------
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2));
const prettyName = f => path.basename(f, path.extname(f)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const safeName = s => String(s).replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80);

function listAudio(kind) {
  const dir = path.join(AUDIO, kind);
  return fs.readdirSync(dir).filter(f => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, title: prettyName(f), url: `/audio/${kind}/${encodeURIComponent(f)}`, size: st.size, added: st.mtimeMs };
    }).sort((a, b) => b.added - a.added);
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req, limit = 1e6) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}
const authed = req => req.headers['x-pin'] === PIN;

// ---------- live state ----------
const live = { on: false, title: '', host: '', mime: '', init: null, started: 0, rec: null, recName: '' };
let announcement = readJSON('announcement.json', { text: '', time: 0 });
const listeners = new Set();   // sockets that asked for audio
const sockets = new Set();     // all sockets (status updates)
let hostSocket = null;
const HAS_FFMPEG = !spawnSync('ffmpeg', ['-version']).error;
const mp3Clients = new Set();   // plain HTTP listeners of /stream.mp3 (iPhones, Safari, VLC, any player)
let ff = null;
function startTranscoder() {
  if (!HAS_FFMPEG) return;
  ff = spawn('ffmpeg', ['-loglevel', 'error', '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0', '-i', 'pipe:0', '-vn', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '96k', '-flush_packets', '1', '-f', 'mp3', 'pipe:1']);
  ff.stdout.on('data', d => { for (const r of mp3Clients) r.write(d); });
  ff.stdin.on('error', () => {}); ff.on('error', () => { ff = null; });
  ff.on('close', () => { ff = null; for (const r of mp3Clients) r.end(); mp3Clients.clear(); });
}
function stopTranscoder() { if (ff) { try { ff.stdin.end(); } catch {} const f = ff; setTimeout(() => f.kill('SIGKILL'), 1500); ff = null; } for (const r of mp3Clients) r.end(); mp3Clients.clear(); }

const status = () => ({
  type: 'status', live: live.on, title: live.title, host: live.host, started: live.started,
  mime: live.mime, mp3: HAS_FFMPEG, listeners: listeners.size + mp3Clients.size, announcement
});
function broadcast(obj) { const m = JSON.stringify(obj); for (const s of sockets) if (s.readyState === 1) s.send(m); }
function isClusterStart(b) { return b.length > 4 && b[0] === 0x1f && b[1] === 0x43 && b[2] === 0xb6 && b[3] === 0x75; }

function stopLive() {
  if (!live.on) return;
  live.on = false; live.init = null; stopTranscoder();
  const rec = live.rec; live.rec = null;
  if (rec) finishRecording(rec, live.recName);
  for (const s of listeners) s.waiting = false;
  broadcast(status());
}
function finishRecording(stream, file) {
  stream.end(() => {
    const full = path.join(AUDIO, 'shows', file);
    try { if (fs.statSync(full).size < 20000) return fs.unlinkSync(full); } catch { return; }
    const mp3 = full.replace(/\.webm$/, '.mp3');
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', full, '-codec:a', 'libmp3lame', '-q:a', '4', mp3], err => {
      if (!err) fs.unlink(full, () => {}); else console.log('ffmpeg not available – recording kept as .webm');
    });
  });
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/stream.mp3') {
      if (!live.on || !ff) return send(res, 503, 'Off air', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'icy-name': 'Ravians FM' });
      mp3Clients.add(res); broadcast(status());
      req.on('close', () => { mp3Clients.delete(res); broadcast(status()); });
      return;
    }
    if (p === '/api/status') return send(res, 200, status());
    if (p === '/api/songs') return send(res, 200, listAudio('songs'));
    if (p === '/api/shows') return send(res, 200, listAudio('shows'));
    if (p === '/api/programs') return send(res, 200, readJSON('programs.json', []));
    if (p === '/api/schedule') return send(res, 200, readJSON('schedule.json', []));
    if (p === '/api/auth') return send(res, authed(req) ? 200 : 401, { ok: authed(req) });

    if (req.method === 'POST' && p.startsWith('/api/admin/')) {
      if (!authed(req)) return send(res, 401, { error: 'Wrong studio PIN' });
      if (p === '/api/admin/schedule' || p === '/api/admin/programs') {
        const data = JSON.parse((await body(req)).toString());
        if (!Array.isArray(data)) return send(res, 400, { error: 'Expected a list' });
        writeJSON(p.endsWith('schedule') ? 'schedule.json' : 'programs.json', data);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/announce') {
        const { text } = JSON.parse((await body(req)).toString());
        announcement = { text: String(text || '').slice(0, 280), time: Date.now() };
        writeJSON('announcement.json', announcement);
        broadcast(status());
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/upload') {
        const kind = url.searchParams.get('kind') === 'shows' ? 'shows' : 'songs';
        const name = safeName(url.searchParams.get('name') || 'upload');
        if (!AUDIO_EXT.includes(path.extname(name).toLowerCase())) return send(res, 400, { error: 'Unsupported audio file type' });
        const data = await body(req, 150e6);
        fs.writeFileSync(path.join(AUDIO, kind, name), data);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/admin/delete') {
        const { kind, file } = JSON.parse((await body(req)).toString());
        if (!['songs', 'shows'].includes(kind)) return send(res, 400, { error: 'bad kind' });
        fs.unlinkSync(path.join(AUDIO, kind, path.basename(file)));
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    // static files (public/ and audio/, with Range support for seeking)
    let file;
    if (p.startsWith('/audio/')) file = path.join(ROOT, p);
    else file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    const base = p.startsWith('/audio/') ? AUDIO : PUBLIC;
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { send(res, 500, { error: e.message }); }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4e6 });
wss.on('connection', (ws, req) => {
  sockets.add(ws);
  ws.send(JSON.stringify(status()));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {                       // audio chunk – only from the presenter
      if (ws !== hostSocket || !live.on) return;
      if (!live.init) live.init = data;   // first chunk carries the WebM header
      if (live.rec) live.rec.write(data);
      if (ff) ff.stdin.write(data);
      const aligned = isClusterStart(data);
      for (const l of listeners) {
        if (l.readyState !== 1) continue;
        if (l.waiting) {
          if (!aligned && Date.now() - l.waitSince < 600) continue;   // wait for a clean cut point
          l.waiting = false; l.send(live.init, { binary: true });
          if (data !== live.init) l.send(data, { binary: true });
        } else l.send(data, { binary: true });
      }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'listen') {
      listeners.add(ws); ws.waiting = !!live.on; ws.waitSince = Date.now();
      if (live.on && live.init && live.init.length) { /* will start at next clean chunk */ }
      broadcast(status());
    } else if (m.type === 'unlisten') { listeners.delete(ws); broadcast(status()); }
    else if (m.type === 'host-start') {
      if (m.pin !== PIN) return ws.send(JSON.stringify({ type: 'error', message: 'Wrong studio PIN' }));
      if (live.on && hostSocket && hostSocket !== ws) return ws.send(JSON.stringify({ type: 'error', message: 'Another presenter is already live' }));
      hostSocket = ws; live.on = true; live.init = null; live.started = Date.now();
      live.title = String(m.title || 'Live from the Studio').slice(0, 80);
      live.host = String(m.host || '').slice(0, 60); live.mime = m.mime || 'audio/webm;codecs=opus';
      for (const l of listeners) { l.waiting = true; l.waitSince = Date.now(); }
      startTranscoder();
      if (m.record) {
        live.recName = `${safeName(live.title)}_${new Date().toISOString().slice(0, 10)}_${Date.now() % 100000}.webm`;
        live.rec = fs.createWriteStream(path.join(AUDIO, 'shows', live.recName));
      }
      ws.send(JSON.stringify({ type: 'host-ok' }));
      broadcast(status());
    } else if (m.type === 'host-stop' && ws === hostSocket) { stopLive(); hostSocket = null; }
  });
  ws.on('close', () => {
    sockets.delete(ws);
    if (listeners.delete(ws)) broadcast(status());
    if (ws === hostSocket) { hostSocket = null; stopLive(); }
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  📻  Ravians FM is on air (server running)\n');
  if (!HAS_FFMPEG) console.log('  (ffmpeg not found: iPhone/Safari listeners need it – see README)\n');
  console.log(`  Presenter (this PC):  http://localhost:${PORT}/#/studio   (PIN: ${PIN})`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  Share with listeners: http://${n.address}:${PORT}`);
  console.log();
});
