// =====================================================================
// 2026 GALAXY IDEATHON 인생네컷 — 포토부스 서버
//   - prototype/ 정적 서빙 (부스 앱)
//   - POST /api/photos : 합성 이미지 업로드 → { id, url, qr(dataURL) }
//   - GET  /p/:id      : 폰용 다운로드 페이지
//   - GET  /i/:id.png  : 원본 이미지
//   - 3시간 뒤 자동 삭제
// 실행:  node server.mjs   (기본 포트 5173)
// =====================================================================
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

const ROOT     = process.cwd();
const PUBLIC   = join(ROOT, 'prototype');
const UPLOADS  = join(ROOT, 'uploads');
const PORT     = process.env.PORT || 5173;
const TTL_MS   = 3 * 60 * 60 * 1000;          // 3시간
const MAX_BYTES = 12 * 1024 * 1024;            // 업로드 상한 12MB

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.json':'application/json', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

if (!existsSync(UPLOADS)) await mkdir(UPLOADS, { recursive: true });

// 누적 촬영 횟수 카운터 (사진 저장 = 1컷). 파일에 저장해 서버 재시작(배치파일 재실행) 후에도 유지.
const COUNT_FILE = join(ROOT, 'count.json');
let shotCount = 0;
let saveLog = [];                                     // 저장 이력 [{ n, at }]
try {
  const j = JSON.parse(await readFile(COUNT_FILE, 'utf8'));
  shotCount = j.count || 0;
  if (Array.isArray(j.saves)) saveLog = j.saves;
} catch {}
// 사람이 읽기 좋은 시각(YYYY-MM-DD HH:mm:ss)
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function saveCount() {
  try { await writeFile(COUNT_FILE, JSON.stringify({ count: shotCount, updatedAt: stamp(), saves: saveLog }, null, 2)); } catch {}
}

// 공개 base URL (Tailscale Funnel 등 프록시 뒤에서도 정확히)
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}

function downloadPage(id, base) {
  const img = `${base}/i/${id}.jpg`;
  const vid = `${base}/v/${id}`;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>인생네컷 저장 · 2026 GALAXY IDEATHON</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<style>
  *{box-sizing:border-box;margin:0} body{font-family:"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
    background:linear-gradient(160deg,#0a1a6e,#241a7a,#14103a);color:#fff;min-height:100dvh;
    display:flex;flex-direction:column;align-items:center;padding:24px 18px 40px;gap:16px;}
  .tag{font-size:12px;letter-spacing:2px;color:#9fb4ff;text-transform:uppercase}
  h1{font-size:19px;font-weight:800;text-align:center;margin-top:2px}
  .toggle{display:flex;background:rgba(255,255,255,.1);border-radius:999px;padding:4px;gap:4px}
  .toggle button{border:none;background:transparent;color:#fff;font-family:inherit;font-weight:800;font-size:15px;
    padding:9px 28px;border-radius:999px;cursor:pointer}
  .toggle button.on{background:#fff;color:#101433}
  .panel{display:none;flex-direction:column;align-items:center;gap:14px}
  .panel.on{display:flex}
  img.cut,video.cut{width:min(86vw,400px);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.45);background:#000}
  a.save{background:#7c4dff;color:#fff;font-weight:800;font-size:17px;text-decoration:none;
    padding:14px 30px;border-radius:999px;box-shadow:0 10px 26px rgba(124,77,255,.45)}
  a.save.vid{background:#2aa8ff;box-shadow:0 10px 26px rgba(42,168,255,.4)}
  .hint{font-size:12px;color:#c7d0ff;opacity:.85;text-align:center;line-height:1.6}
  .spin{width:38px;height:38px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;
    animation:sp 1s linear infinite;margin:22px} @keyframes sp{to{transform:rotate(360deg)}}
  #vwait{display:flex;flex-direction:column;align-items:center;gap:8px;color:#c7d0ff;font-size:14px;text-align:center}
</style></head><body>
  <div class="tag">2026 GALAXY IDEATHON</div>
  <h1>📸 인생네컷 저장하기</h1>
  <div class="toggle">
    <button id="tPhoto" class="on" onclick="show('photo')">사진</button>
    <button id="tVideo" onclick="show('video')">영상</button>
  </div>

  <div class="panel on" id="pPhoto">
    <img class="cut" src="${img}" alt="인생네컷">
    <a class="save" href="${img}" download="갤럭시아이디어톤_인생네컷.jpg">이미지 저장</a>
    <div class="hint">버튼이 안 되면 사진을 <b>길게 눌러</b> 저장하세요.</div>
  </div>

  <div class="panel" id="pVideo">
    <div id="vwait"><div class="spin"></div>움직이는 영상 준비 중…<br>잠시만 기다려 주세요</div>
    <div id="vready" style="display:none;flex-direction:column;align-items:center;gap:14px">
      <video class="cut" id="vid" src="${vid}" autoplay loop muted playsinline></video>
      <a class="save vid" href="${vid}" download="갤럭시아이디어톤_인생네컷.webm">영상 저장</a>
      <div class="hint">버튼이 안 되면 영상을 <b>길게 눌러</b> 저장하세요.</div>
    </div>
  </div>

  <script>
  function show(which){
    var p=which==='photo';
    document.getElementById('pPhoto').classList.toggle('on', p);
    document.getElementById('pVideo').classList.toggle('on', !p);
    document.getElementById('tPhoto').classList.toggle('on', p);
    document.getElementById('tVideo').classList.toggle('on', !p);
  }
  (function(){ var id="${id}", tries=0, ready=false;
    function check(){
      if(ready) return;
      fetch('/api/hasvideo?id='+id).then(function(r){return r.json();}).then(function(j){
        if(j&&j.ok){ ready=true; document.getElementById('vwait').style.display='none';
          document.getElementById('vready').style.display='flex';
          var v=document.getElementById('vid'); if(v&&v.load) v.load(); return; }
        if(tries++<60) setTimeout(check,2000);
      }).catch(function(){ if(tries++<60) setTimeout(check,2000); });
    }
    check();
  })();
  </script>
</body></html>`;
}

// (업로드 파일은 자동 삭제하지 않고 그대로 보관)

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // 업로드
  if (req.method === 'POST' && url === '/api/photos') {
    try {
      const buf = await readBody(req, MAX_BYTES);
      if (!buf.length) throw new Error('empty');
      const id = randomBytes(6).toString('hex');
      await writeFile(join(UPLOADS, `${id}.jpg`), buf);
      shotCount++;                                    // 저장 성공 = 1컷 누적
      const at = stamp();
      saveLog.push({ n: shotCount, at });
      saveCount();
      console.log(`  >> ${shotCount}번째 촬영 저장됨  (${at})`);   // 이모지 없이 → cmd에서 안 깨짐
      const base = baseUrl(req);
      const pageUrl = `${base}/p/${id}`;
      const qr = await QRCode.toDataURL(pageUrl, { width: 420, margin: 1,
        color: { dark: '#101433', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id, url: pageUrl, qr, count: shotCount }));
    } catch (e) {
      res.writeHead(e.message === 'too large' ? 413 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 이미지 원본
  if (req.method === 'GET' && url.startsWith('/i/')) {
    const id = url.slice(3).replace(/\.(png|jpg|jpeg)$/, '').replace(/[^a-f0-9]/g, '');
    try {
      const data = await readFile(join(UPLOADS, `${id}.jpg`));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('만료되었거나 없는 사진입니다.'); }
  }

  // QR 생성 (페어링 등 임의 텍스트)
  if (req.method === 'GET' && url === '/api/qr') {
    try {
      const text = new URL(req.url, 'http://x').searchParams.get('text') || '';
      const dataUrl = await QRCode.toDataURL(text, { width: 440, margin: 1,
        color: { dark: '#101433', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ dataUrl }));
    } catch (e) { res.writeHead(400); return res.end('qr error'); }
  }

  // 폰 카메라 페이지
  if (req.method === 'GET' && url === '/cam') {
    try {
      const data = await readFile(join(PUBLIC, 'cam.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('cam.html not found'); }
  }

  // 영상 업로드 (사진 id에 연결)
  if (req.method === 'POST' && url === '/api/videos') {
    try {
      const qid = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      if (!qid) throw new Error('no id');
      const buf = await readBody(req, 30 * 1024 * 1024);
      if (!buf.length) throw new Error('empty');
      await writeFile(join(UPLOADS, `${qid}.webm`), buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 영상 존재 확인 (다운로드 페이지 폴링용)
  if (req.method === 'GET' && url === '/api/hasvideo') {
    const qid = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
    const ok = !!(qid && existsSync(join(UPLOADS, `${qid}.webm`)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }

  // 영상 원본
  if (req.method === 'GET' && url.startsWith('/v/')) {
    const id = url.slice(3).replace(/\.webm$/, '').replace(/[^a-f0-9]/g, '');
    try {
      const data = await readFile(join(UPLOADS, `${id}.webm`));
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end('no video'); }
  }

  // 폰 다운로드 페이지
  if (req.method === 'GET' && url.startsWith('/p/')) {
    const id = url.slice(3).replace(/[^a-f0-9]/g, '');
    if (!existsSync(join(UPLOADS, `${id}.jpg`))) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta charset=utf-8><body style="font-family:sans-serif;background:#141033;color:#fff;text-align:center;padding:60px">사진이 만료되었거나 존재하지 않아요 😢</body>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(downloadPage(id, baseUrl(req)));
  }

  // 정적 (부스 앱)
  return serveStatic(req, res);
});

// =====================================================================
// WebRTC 신호중계 (WebSocket) — 폰(카메라) ↔ 태블릿(뷰어) 페어링
//   방(room) 코드로 두 피어를 연결하고 offer/answer/ICE를 중계만 한다.
// =====================================================================
const wss = new WebSocketServer({ server });
const rooms = new Map();   // roomCode -> Set<ws>

function relay(room, msg, except){
  const set = rooms.get(room); if (!set) return;
  const str = JSON.stringify(msg);
  for (const w of set) if (w !== except && w.readyState === 1) w.send(str);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'join') {
      ws.room = String(msg.room || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      ws.role = msg.role === 'camera' ? 'camera' : 'viewer';
      if (!ws.room) return;
      let set = rooms.get(ws.room); if (!set) { set = new Set(); rooms.set(ws.room, set); }
      set.add(ws);
      relay(ws.room, { type: 'peer', role: ws.role, event: 'join' }, ws);
      const roles = [...set].map(w => w.role);
      if (roles.includes('viewer') && roles.includes('camera')) relay(ws.room, { type: 'ready' });
      return;
    }
    // offer/answer/ice/cmd → 방의 상대 피어에게 중계
    if (ws.room) relay(ws.room, msg, ws);
  });
  ws.on('close', () => {
    if (!ws.room) return;
    const set = rooms.get(ws.room);
    if (set) { set.delete(ws); relay(ws.room, { type: 'peer', role: ws.role, event: 'leave' }, ws); if (!set.size) rooms.delete(ws.room); }
  });
});
// 유휴 연결 정리 (30초 ping)
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }); }, 30000);

server.listen(PORT, () => {
  console.log(`\n  == 2026 GALAXY IDEATHON 인생네컷 포토부스 ==`);
  console.log(`  - 로컬:      http://localhost:${PORT}`);
  console.log(`  - 폰 카메라:  같은 주소 + 화면 QR 스캔`);
  console.log(`  - 업로드 폴더: ${UPLOADS}  (자동 삭제 안 함 · 계속 보관)`);
  console.log(`  - 누적 촬영: 지금까지 ${shotCount}회  (다음 저장 = ${shotCount + 1}번째)`);
  console.log(`  - 종료하려면 이 창에서 Ctrl+C\n`);
});
