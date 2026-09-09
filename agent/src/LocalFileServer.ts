/**
 * LocalFileServer — serves registered files over HTTP on the LAN.
 * Mobile devices on the same WiFi can download files directly at full LAN speed,
 * bypassing WebRTC signaling and SCTP overhead entirely.
 *
 * Port 9002, listens on 0.0.0.0 (LAN accessible, not just localhost).
 * Files are streamed to a tmpdir — no large memory allocations.
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

interface RegisteredFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  tmpPath: string;
}

export class LocalFileServer {
  private server: http.Server;
  private files = new Map<string, RegisteredFile>();
  private tmpDir: string;
  readonly port: number;

  constructor(port = 9002) {
    this.port = port;
    this.tmpDir = path.join(os.tmpdir(), 'screenmirror-files');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.server = http.createServer((req, res) => this.route(req, res));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[FileServer] Listening on 0.0.0.0:${this.port} (LAN)`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    this.server.close();
    this.cleanTmp();
  }

  getLocalIPs(): string[] {
    const ips: string[] = [];
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const addr of iface ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
      }
    }
    return ips;
  }

  /** Register a file by streaming request body to tmpdir. Called from route handler. */
  private registerStream(
    req: http.IncomingMessage,
    id: string, name: string, size: number, mime: string,
    cb: (err: Error | null) => void,
  ) {
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const tmpPath = path.join(this.tmpDir, `${id}_${safeName}`);
    const ws = fs.createWriteStream(tmpPath);
    req.pipe(ws);
    ws.on('finish', () => {
      this.files.set(id, {
        id, name, mimeType: mime,
        size: size || fs.statSync(tmpPath).size,
        tmpPath,
      });
      console.log(`[FileServer] Registered: ${name} (${fmtBytes(size)})`);
      cb(null);
    });
    ws.on('error', cb);
    req.on('error', (e) => { ws.destroy(e); });
  }

  removeFile(id: string) {
    const f = this.files.get(id);
    if (!f) return;
    try { fs.unlinkSync(f.tmpPath); } catch {}
    this.files.delete(id);
    console.log(`[FileServer] Removed: ${f.name}`);
  }

  private cleanTmp() {
    for (const f of this.files.values()) {
      try { fs.unlinkSync(f.tmpPath); } catch {}
    }
    this.files.clear();
  }

  // ── Router ───────────────────────────────────────────────────────────────────

  private route(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const { method } = req;

    if (method === 'GET' && url.pathname === '/') { this.handleListPage(res); return; }
    if (method === 'GET' && url.pathname === '/info') { this.handleInfo(res); return; }
    if (method === 'GET' && url.pathname === '/files') { this.handleFileList(res); return; }

    const dlMatch = url.pathname.match(/^\/download\/([^/]+)$/);
    if (method === 'GET' && dlMatch) { this.handleDownload(dlMatch[1], res); return; }

    const delMatch = url.pathname.match(/^\/files\/([^/]+)$/);
    if (method === 'DELETE' && delMatch) { this.removeFile(delMatch[1]); res.writeHead(204); res.end(); return; }

    if (method === 'POST' && url.pathname === '/register') { this.handleRegister(req, res, url); return; }

    res.writeHead(404); res.end('Not found');
  }

  private handleInfo(res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ port: this.port, localIPs: this.getLocalIPs() }));
  }

  private handleFileList(res: http.ServerResponse) {
    const list = [...this.files.values()].map(f => ({
      id: f.id, name: f.name, size: f.size, mimeType: f.mimeType,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
  }

  private handleDownload(id: string, res: http.ServerResponse) {
    const f = this.files.get(id);
    if (!f) { res.writeHead(404); res.end('File not found'); return; }
    let stat: fs.Stats;
    try { stat = fs.statSync(f.tmpPath); } catch { res.writeHead(404); res.end('File gone'); return; }
    res.writeHead(200, {
      'Content-Type': f.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(f.tmpPath).pipe(res);
  }

  private handleRegister(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const id   = url.searchParams.get('id')   ?? crypto.randomUUID();
    const name = url.searchParams.get('name') ?? 'file';
    const mime = url.searchParams.get('mime') ?? 'application/octet-stream';
    const size = parseInt(url.searchParams.get('size') ?? '0', 10);

    this.registerStream(req, id, name, size, mime, (err) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, ok: true }));
    });
  }

  private handleListPage(res: http.ServerResponse) {
    const files = [...this.files.values()];
    const items = files.length === 0
      ? `<div class="empty">Henüz dosya paylaşılmadı</div>`
      : files.map(f => `
        <div class="item">
          <div class="meta">
            <div class="fname">${esc(f.name)}</div>
            <div class="fsize">${fmtBytes(f.size)}</div>
          </div>
          <a class="dl-btn" href="/download/${f.id}">İndir</a>
        </div>`).join('');

    const ips = this.getLocalIPs().join(' · ');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>ScreenMirror — Lokal Aktarım</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0c0e14;color:#e2e8f0;min-height:100vh}
    header{padding:16px 20px;border-bottom:1px solid #1e2130;display:flex;align-items:center;gap:10px}
    .logo{font-weight:700;font-size:16px}
    .logo span{color:#3b82f6}
    .ip{font-size:11px;color:#4a5068;margin-left:auto}
    .list{max-width:500px;margin:12px auto;padding:0 12px}
    .item{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #1e2130}
    .fname{font-weight:500;font-size:15px;word-break:break-all}
    .fsize{font-size:12px;color:#4a5068;margin-top:3px}
    .dl-btn{background:#3b82f6;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;white-space:nowrap;margin-left:12px;flex-shrink:0}
    .dl-btn:active{background:#2563eb}
    .empty{text-align:center;color:#4a5068;padding:60px 20px;font-size:15px}
    .refresh-note{text-align:center;font-size:11px;color:#2a2f40;padding:12px}
  </style>
</head>
<body>
  <header>
    <div class="logo">Screen<span>Mirror</span> &nbsp;Lokal Aktarım</div>
    <div class="ip">${esc(ips)}</div>
  </header>
  <div class="list">${items}</div>
  <div class="refresh-note">Sayfa otomatik yenilenir</div>
  <script>setTimeout(()=>location.reload(),4000)</script>
</body>
</html>`);
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtBytes(b: number): string {
  if (b < 1024)       return `${b} B`;
  if (b < 1024 ** 2)  return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)  return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
