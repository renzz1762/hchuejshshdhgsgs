// Proxy gambar same-origin (Edge Runtime Vercel) supaya canvas bisa baca warna cover.
export const config = { runtime: 'edge' };


// ---------- GUARD (anti-abuse) ----------
// Env opsional: ALLOWED_HOSTS (domain tambahan, pisah koma), RATE_MAX (default 120/menit/IP)
const BOT_UA = /(curl|wget|python|requests|aiohttp|httpx|axios|node-fetch|undici|got\/|go-http|java\/|scrapy|httpclient|libwww|postman|insomnia|bot\b|crawler|spider|headless)/i;
const PRIVATE_HOST = /^(localhost|.*\.(local|internal|localhost)|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|\[.*\])$/i;
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch (e) { return ''; } }
function guardFail(request) {
    const h = request.headers;
    const ua = h.get('user-agent') || '';
    if (!ua || BOT_UA.test(ua)) return new Response('Akses ditolak', { status: 403 });
    const allowed = new Set([new URL(request.url).host.toLowerCase()]);
    ((typeof process !== 'undefined' && process.env && process.env.ALLOWED_HOSTS) || '').split(',')
        .map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((s) => allowed.add(s));
    const sfs = (h.get('sec-fetch-site') || '').toLowerCase();
    const o = h.get('origin'), r = h.get('referer');
    const ok = sfs === 'same-origin' || (o && allowed.has(hostOf(o))) || (r && allowed.has(hostOf(r)));
    if (!ok) return new Response('Akses ditolak', { status: 403 });
    return null;
}
function badTarget(parsed) {
    return parsed.protocol !== 'https:' || PRIVATE_HOST.test(parsed.hostname) || parsed.username || parsed.password;
}

const rateHits = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = (typeof process !== 'undefined' && process.env && parseInt(process.env.RATE_MAX, 10)) || 120;

function isRateLimited(request) {
    const ip = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const rec = rateHits.get(ip);
    if (!rec || now > rec.resetAt) {
        rateHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return false;
    }
    rec.count++;
    return rec.count > RATE_MAX;
}

export default async function handler(request) {
    const denied = guardFail(request);
    if (denied) return denied;
    if (isRateLimited(request)) {
        return new Response('Terlalu banyak request, coba lagi sebentar', { status: 429 });
    }
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return new Response('Missing url parameter', { status: 400 });

    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) {
        return new Response('Invalid url parameter', { status: 400 });
    }
    if (badTarget(parsed)) {
        return new Response('Target tidak diizinkan', { status: 400 });
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36' },
            redirect: 'follow'
        });
    } catch (err) {
        return new Response('Proxy error: ' + err.message, { status: 502 });
    }
    if (!upstream.ok) return new Response('Upstream error', { status: upstream.status });
    if (!(upstream.headers.get('content-type') || '').toLowerCase().startsWith('image/')) {
        try { await upstream.body?.cancel(); } catch (e) {}
        return new Response('Bukan gambar', { status: 415 });
    }

    const respHeaders = new Headers();
    const ct = upstream.headers.get('content-type');
    respHeaders.set('content-type', ct);
    respHeaders.set('cache-control', 'public, max-age=86400');
    return new Response(upstream.body, { status: 200, headers: respHeaders });
}
