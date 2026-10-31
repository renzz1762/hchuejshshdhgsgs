// Proxy audio streaming (Edge Runtime Vercel) - support Range/206 biar bisa seek.
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

// Ambil dari upstream, retry 1x kalau error jaringan / 5xx. `signal` = putus kalau pendengar menutup koneksi
// (biar koneksi ke CDN nggak nyangkut & numpuk kalau user ganti lagu / app ditutup).
async function fetchUpstream(targetUrl, headers, signal) {
    let lastErr;
    for (let i = 0; i < 2; i++) {
        try {
            const r = await fetch(targetUrl, { headers, redirect: 'follow', signal });
            if (r.status >= 500 && i === 0) { try { await r.body?.cancel(); } catch (e) {} continue; }
            return r;
        } catch (e) {
            lastErr = e;
            if (signal && signal.aborted) throw e;
        }
    }
    throw lastErr || new Error('upstream gagal');
}

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

    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36'
    };
    const range = request.headers.get('range');
    if (range) upstreamHeaders['Range'] = range;

    let upstream;
    try {
        upstream = await fetchUpstream(targetUrl, upstreamHeaders, request.signal);
    } catch (err) {
        return new Response('Proxy error: ' + err.message, { status: 502 });
    }

    // hanya file audio/stream, bukan halaman web / JSON (cegah dipakai jadi proxy umum)
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    if (/^(text\/|application\/(json|xml|javascript))/.test(ct)) {
        try { await upstream.body?.cancel(); } catch (e) {}
        return new Response('Tipe konten tidak diizinkan', { status: 415 });
    }

    const respHeaders = new Headers();
    ['content-type', 'content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified'].forEach((h) => {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
    });
    if (!respHeaders.has('accept-ranges')) respHeaders.set('accept-ranges', 'bytes');
    respHeaders.set('cache-control', 'private, no-store');   // jangan ditumpuk di cache CDN/SW

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
