// ============================================================
// HC MUSIFY - GUARD (anti-scrape / anti-abuse), dipakai semua endpoint /api
// Lapisan yang dipasang:
//  1. Cuma terima request dari website sendiri (cek Sec-Fetch-Site / Origin / Referer)
//  2. Blok user-agent bot/script umum (curl, python, axios, dll)
//  3. Rate limit per IP (per instance server, best effort)
// Catatan jujur: ini bukan anti-scrape 100%. Scraper yang niat bisa memalsukan header.
// Lapisan paling kuat tetap Vercel Firewall (rate limit / Attack Challenge Mode) di dashboard.
//
// Env (opsional):
//   ALLOWED_HOSTS = domain tambahan yg boleh, pisah koma (mis. musik.kamu.my.id,www.kamu.my.id)
//   INTERNAL_KEY  = kunci rahasia buat panggilan server-ke-server (dipakai /api/og)
//   RATE_MAX      = batas request per menit per IP (default 90)
// ============================================================
const BOT_UA = /(curl|wget|python|requests|aiohttp|httpx|axios|node-fetch|undici|got\/|go-http|java\/|okhttp|scrapy|httpclient|libwww|postman|insomnia|bot\b|crawler|spider|headless)/i;
const hits = new Map();
const WINDOW_MS = 60 * 1000;

function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch (e) { return ''; } }
function first(v) { return String(v || '').split(',')[0].trim(); }
function ipOf(req) {
    const h = req.headers || {};
    return first(h['x-real-ip'] || h['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function allowedHosts(req) {
    const h = req.headers || {};
    const set = new Set();
    const self = first(h['x-forwarded-host'] || h.host).toLowerCase();
    if (self) set.add(self);
    String(process.env.ALLOWED_HOSTS || '').split(',').map(function (s) { return s.trim().toLowerCase(); })
        .filter(Boolean).forEach(function (s) { set.add(s); });
    return set;
}
function rateLimited(ip, max) {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now > rec.resetAt) {
        if (hits.size > 5000) { hits.forEach(function (v, k) { if (now > v.resetAt) hits.delete(k); }); }
        hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
        return false;
    }
    rec.count++;
    return rec.count > max;
}
function deny(res, code, msg) {
    res.status(code).json({ status: false, message: msg });
    return false;
}

// return true = lanjut, false = sudah ditolak (response sudah dikirim)
function check(req, res, opts) {
    opts = opts || {};
    if (req.method === 'OPTIONS') return true;
    const h = req.headers || {};

    // panggilan internal server-ke-server (mis. /api/og) pakai kunci rahasia
    const ik = process.env.INTERNAL_KEY;
    if (ik && h['x-hc-internal'] === ik) return true;

    const ua = String(h['user-agent'] || '');
    if (!ua || BOT_UA.test(ua)) return deny(res, 403, 'Akses ditolak');

    const allowed = allowedHosts(req);
    const sfs = String(h['sec-fetch-site'] || '').toLowerCase();
    const okOrigin = (h.origin && allowed.has(hostOf(h.origin))) || (h.referer && allowed.has(hostOf(h.referer)));
    if (!(sfs === 'same-origin' || okOrigin)) return deny(res, 403, 'Akses ditolak');

    const max = opts.max || parseInt(process.env.RATE_MAX, 10) || 90;
    if (rateLimited(ipOf(req), max)) { res.setHeader('Retry-After', '30'); return deny(res, 429, 'Terlalu banyak request, coba lagi sebentar'); }
    return true;
}

// bungkus handler (props tambahan seperti getLyrics1 ikut disalin)
function wrap(handler, opts) {
    const w = async function (req, res) {
        if (!check(req, res, opts)) return;
        return handler(req, res);
    };
    Object.keys(handler).forEach(function (k) { w[k] = handler[k]; });
    return w;
}

module.exports = { check, wrap };
