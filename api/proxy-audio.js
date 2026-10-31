// Proxy audio streaming (Node function Vercel) - support Range/206 biar bisa seek.
const { Readable } = require('stream');
const G = require('./_guard.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36';

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

module.exports = async (req, res) => {
    if (!G.check(req, res, { max: parseInt(process.env.RATE_MAX, 10) || 120 })) return;
    const targetUrl = (req.query && req.query.url) || '';
    if (!targetUrl) { res.status(400).send('Missing url parameter'); return; }
    if (G.badTarget(targetUrl)) { res.status(400).send('Target tidak diizinkan'); return; }

    const host = (() => { try { return new URL(targetUrl).host; } catch (e) { return ''; } })();
    const mkHeaders = (withRange) => {
        const h = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' };
        if (/savetube\./i.test(host)) { h['Referer'] = 'https://yt.savetube.me/'; h['Origin'] = 'https://yt.savetube.me'; }
        if (withRange && req.headers.range) h['Range'] = req.headers.range;
        return h;
    };

    // putus koneksi ke CDN kalau pendengar menutup (ganti lagu / app ditutup)
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

    const isHtml = (r) => /^(text\/|application\/(json|xml|javascript))/.test((r.headers.get('content-type') || '').toLowerCase());
    let upstream;
    try {
        upstream = await fetchUpstream(targetUrl, mkHeaders(true), ctrl.signal);
        // sumber kadang balas halaman web (HTML) kalau ada Range -> coba sekali lagi tanpa Range
        if (isHtml(upstream) && req.headers.range) {
            try { await upstream.body?.cancel(); } catch (e) {}
            upstream = await fetchUpstream(targetUrl, mkHeaders(false), ctrl.signal);
        }
    } catch (err) { console.log('[AUDIO] fetch gagal: ' + err.message); if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message); return; }

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    try { console.log('[AUDIO] upstream status=' + upstream.status + ' host=' + host + ' ct=' + ct + ' range=' + (req.headers.range || '-')); } catch (e) {}
    if (isHtml(upstream)) {
        let snippet = '';
        try { snippet = (await upstream.text()).replace(/\s+/g, ' ').slice(0, 300); } catch (e) {}
        console.log('[AUDIO] sumber balas halaman web, isi: ' + snippet);
        res.status(502).send('Sumber audio menolak (balas halaman web)');
        return;
    }

    ['content-type', 'content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified'].forEach((h) => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
    });
    if (!upstream.headers.get('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'private, no-store');
    res.statusCode = upstream.status;

    if (!upstream.body) { res.end(); return; }
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => { try { res.end(); } catch (e) {} });
    stream.pipe(res);
};
