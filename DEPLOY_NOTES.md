# Vercel Deploy Notları

## Mevcut Durum (2026-09-09 itibarıyla)

Projenin tüm özellikleri tamamlandı ve TypeScript derleme hatası yok.

### Tamamlanan özellikler
- Ekran paylaşımı / uzak destek (host + viewer + WebRTC)
- Dosya Aktarım Odası (3 panel, P2P binary transfer, SpeedLimiter, FSAA)
- Laser pointer, Annotation overlay, Clipboard sync (şifreli)
- Encrypted room links (AES-256-GCM, URL hash)
- In-browser dosya önizlemesi (image/video/text)
- Türkçe/İngilizce dil değiştirici (🇹🇷/🇬🇧, localStorage, data-i18n)
- Desktop Agent entegrasyonu (PIN, control token, audit log)
- Security hardening (RateLimiter, MessageValidator, AuditLogger)

---

## Deploy Mimarisi

Proje **iki ayrı parçadan** oluşuyor:

```
client/   → Vite SPA → Vercel'e statik olarak deploy
server/   → Node.js WebSocket + HTTP → AYRI bir platforma deploy (Railway / Render / Fly.io)
```

Vercel WebSocket sunucusunu **desteklemiyor** (uzun süreli bağlantı, serverless'a sığmaz).
Client Vercel'e gider, server ayrı bir yere.

---

## Adım Adım Deploy Planı

### 1. Server'ı Railway'e Deploy Et

Railway en kolayı (ücretsiz tier var):
1. https://railway.app → yeni proje → "Deploy from GitHub"
2. `server/` klasörünü root olarak seç (veya monorepo ayarı yap)
3. Ortam değişkenleri:
   - `PORT` → Railway otomatik atar
   - `AGENT_SECRET` → istediğin güçlü bir string
   - (varsa) diğer env var'lar
4. Deploy sonrası bir URL alacaksın, örn: `https://screenmirror-server.railway.app`

**Alternatifler:** Render.com, Fly.io (ikisi de WebSocket destekler)

---

### 2. Client'ı Vercel'e Deploy Et (Statik Site)

Önce `vercel.json` oluşturulmalı (henüz yok). İçeriği:

```json
{
  "buildCommand": "cd client && npm install && npm run build",
  "outputDirectory": "client/dist",
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

> Not: Çok sayfalı (MPA) yapı var (index.html, room.html, filetransfer.html),
> bu yüzden rewrite yerine her dosyaya route gerekebilir. Test et.

Ortam değişkeni olarak **server URL'ini** client'a enjekte et:
- `vite.config.ts`'de proxy'ler sadece local dev içindir.
- Production'da client'ın WebSocket URL'i doğrudan server'a bakmalı.
- `client/src/pages/room.ts` → `getWsUrl()` fonksiyonu şu an `location.host`'u kullanıyor.
  **Bunu production'da Railway URL'ine yönlendir:**
  ```ts
  function getWsUrl(): string {
    if (import.meta.env.PROD) {
      return import.meta.env.VITE_WS_URL ?? 'wss://screenmirror-server.railway.app';
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  ```
- `client/src/pages/filetransfer.ts` → `WS_URL` sabiti de aynı şekilde düzeltilmeli.
- Vercel'e `VITE_WS_URL=wss://...railway.app` ortam değişkeni ekle.

---

### 3. Vercel'de Yapılacaklar (sırayla)

1. `vercel.json` oluştur (yukarıdaki içerik)
2. `client/src/pages/room.ts` → `getWsUrl()` production branch ekle
3. `client/src/pages/filetransfer.ts` → `WS_URL` production branch ekle
4. `.gitignore`'u kontrol et — `node_modules/`, `client/dist/`, `server/dist/` olmalı
5. GitHub'a push yap
6. Vercel'de repo'yu bağla, `VITE_WS_URL` env var'ını gir
7. Deploy et

---

## Dikkat Edilecekler

- **CORS:** Railway'deki server `client/` Vercel URL'inden gelen isteklere izin vermeli.
  `server/src/index.ts` (veya benzeri) → `cors` ayarını güncelle.
- **HTTPS/WSS:** Vercel HTTPS kullanır → server da HTTPS/WSS olmalı (Railway otomatik TLS verir).
- **Desktop Agent:** Yalnızca local çalışır (localhost:9001), deploy'dan etkilenmez.
- **File Transfer:** Tamamen P2P (WebRTC DataChannel), server sadece signaling yapar.

---

## Şu An Eksik Olan Dosyalar

- [ ] `vercel.json` (oluşturulacak)
- [ ] `client/src/pages/room.ts` → `getWsUrl()` production branch
- [ ] `client/src/pages/filetransfer.ts` → `WS_URL` production branch
- [ ] Server CORS ayarı production origin için
