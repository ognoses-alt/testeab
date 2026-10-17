/**
 * Abyss CDN Proxy — Node.js version for Render.com (v2 — uses upstream v13 worker)
 *
 * ARCHITECTURE:
 *   roku ──→  Render worker  ──→  abyss-proxy.ognoses.workers.dev  ──→  abysscdn.com
 *   (TLS roku)   (regular curl)        (Cloudflare internal)         (CF accepts CF)
 *
 * The Render worker delegates /fetch to the user's existing v13 Cloudflare Worker
 * (abyss-proxy.ognoses.workers.dev) instead of calling abysscdn.com directly.
 *
 * WHY THIS CHAIN WORKS:
 *   - roku → Render: Render.com edge doesn't block roku's TLS fingerprint
 *   - Render → v13 worker: workers.dev edge doesn't block regular curl from Render
 *   - v13 worker → abysscdn.com: CF Workers fetch from CF's internal network,
 *     which abysscdn.com (also on CF) accepts without challenge
 *
 * If we tried: roku → abyss-proxy.ognoses.workers.dev directly, the workers.dev
 * edge would block roku's TLS fingerprint (returns "Just a moment..." 403).
 *
 * If we tried: roku → Render → abysscdn.com directly, abysscdn.com's CF would
 * challenge Render's datacenter IP (also returns "Just a moment...").
 *
 * The 2-hop chain bypasses both edge blocks.
 *
 * CONFIG:
 *   Set UPSTREAM_WORKER env var on Render.com to your v13 worker URL
 *   (defaults to https://abyss-proxy.ognoses.workers.dev)
 *
 * ENDPOINTS:
 *   GET  /                                — health check
 *   GET  /fetch?url=<URL>                 — fetch via upstream v13 worker
 *   GET  /?seg0=<URL>&seg1=<URL>&frag=N&total=M
 *                                        — video range stitching (via upstream)
 *   GET  /debug?url=<URL>                 — test what upstream returns for a URL
 *   GET  /logs                            — recent request log (last 30)
 *
 * DEPLOY ON RENDER.COM:
 *   1. Push server.js + package.json to your GitHub repo (overwrite existing files)
 *   2. Render auto-redeploys on push (or manually click "Manual Deploy" →
 *      "Clear build cache & deploy" in dashboard)
 *   3. Wait ~1-2 min for redeploy
 *   4. Test: curl https://your-service.onrender.com/fetch?url=https%3A%2F%2Fabysscdn.com%2F%3Fv%3D01gE05Adb
 *      Should now return 200 + HTML containing "const datas" (NOT "Just a moment...")
 *
 * NO APP ROKO MUDANÇA NENHUMA:
 *   As constantes ABYSS_PAGE_WORKER_BASE_URL e WORKER_PROXY_URL continuam
 *   apontando para https://abyss-proxy-xmxx.onrender.com — o Render worker
 *   agora internamente delega para o v13 worker sem você precisar mudar nada.
 */

const http = require('http');
const { execFileSync, execSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Upstream v13 worker URL — change via env var if you deploy the v13 worker
// on a different domain. Default is the user's existing v13 worker.
const UPSTREAM_WORKER = (process.env.UPSTREAM_WORKER || 'https://abyss-proxy.ognoses.workers.dev').replace(/\/+$/, '');

// In-memory log of recent requests (for /logs endpoint)
const requestLog = [];
const MAX_LOG_ENTRIES = 30;

function logRequest(entry) {
    requestLog.push({ ...entry, timestamp: new Date().toISOString() });
    if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift();
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,Keep-Alive,User-Agent,Referer,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type');
    res.setHeader('Access-Control-Expose-Headers', '*');
}

/**
 * Use curl to fetch a URL — curl's TLS fingerprint is accepted by the
 * workers.dev edge (Node's fetch/https.request are NOT, due to JA3 fingerprinting).
 *
 * Returns: { status, contentType, body }
 */
function curlFetch(targetUrl, { referer = '', maxTime = '30' } = {}) {
    const args = [
        '-s',
        '-o', '-',
        '-w', '\n---HTTP_STATUS:%{http_code}---\n---CONTENT_TYPE:%{content_type}---\n',
        '--compressed',
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        '-H', 'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        '--max-time', maxTime,
        '-L',
        '--max-redirs', '5',
    ];
    if (referer) {
        args.push('-H', `Referer: ${referer}`);
    }
    args.push(targetUrl);

    let output;
    try {
        output = execFileSync('curl', args, {
            maxBuffer: 200 * 1024 * 1024,
            timeout: parseInt(maxTime, 10) * 1000 + 5000,
        }).toString('utf-8');
    } catch (err) {
        return {
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'curl exec failed', message: String(err.message || err) }),
        };
    }

    const statusMatch = output.match(/---HTTP_STATUS:(\d+)---\n---CONTENT_TYPE:([^-\n]*)---\n?$/);
    if (!statusMatch) {
        return { status: 200, contentType: 'text/html', body: output };
    }

    const status = parseInt(statusMatch[1], 10);
    const contentType = statusMatch[2].trim();
    const body = output.slice(0, statusMatch.index);

    return { status, contentType, body };
}

/**
 * Use curl to fetch binary data — returns Buffer (for video segments).
 */
function curlFetchBuffer(targetUrl, { referer = '', maxTime = '60' } = {}) {
    const args = [
        '-s',
        '-o', '-',
        '-w', '\n---HTTP_STATUS:%{http_code}---\n---CONTENT_TYPE:%{content_type}---\n',
        '--compressed',
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H', 'Accept: */*',
        '--max-time', maxTime,
        '-L',
        '--max-redirs', '5',
    ];
    if (referer) {
        args.push('-H', `Referer: ${referer}`);
    }
    args.push(targetUrl);

    let output;
    try {
        output = execFileSync('curl', args, {
            maxBuffer: 500 * 1024 * 1024,
            timeout: parseInt(maxTime, 10) * 1000 + 5000,
        });
    } catch (err) {
        return {
            status: 502,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ error: 'curl exec failed', message: String(err.message || err) })),
        };
    }

    const marker = '\n---HTTP_STATUS:';
    const markerIdx = output.lastIndexOf(marker, output.length - 100);
    if (markerIdx === -1) {
        return { status: 200, contentType: 'application/octet-stream', body: output };
    }

    const body = output.slice(0, markerIdx);
    const tail = output.slice(markerIdx).toString('utf-8');
    const statusMatch = tail.match(/---HTTP_STATUS:(\d+)---\n---CONTENT_TYPE:([^-\n]*)---\n?$/);
    if (!statusMatch) {
        return { status: 200, contentType: 'application/octet-stream', body };
    }

    return {
        status: parseInt(statusMatch[1], 10),
        contentType: statusMatch[2].trim(),
        body,
    };
}

const server = http.createServer((req, res) => {
    let parsedUrl;
    try {
        parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    } catch (e) {
        res.writeHead(400);
        res.end('Bad URL');
        return;
    }
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // CORS preflight
    if (req.method === 'OPTIONS') {
        setCors(res);
        res.writeHead(200);
        res.end();
        return;
    }

    // Health check
    if (pathname === '/' && !query.url && !query.seg0) {
        setCors(res);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Abyss CDN Proxy v2-render OK (upstream: ${UPSTREAM_WORKER})

Endpoints:
  /                                — health check
  /fetch?url=<URL>                 — fetch via upstream v13 worker
  /?seg0=<URL>&seg1=<URL>&frag=N&total=M — video range stitching
  /debug?url=<URL>                 — test what upstream returns
  /logs                            — recent request log

Architecture: roku -> this Render worker -> upstream v13 worker -> abysscdn.com
The upstream worker is on Cloudflare's network, so it can fetch abysscdn.com
without Cloudflare's "Just a moment..." managed challenge.`);
        return;
    }

    // Recent request log
    if (pathname === '/logs') {
        setCors(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requestLog, null, 2));
        return;
    }

    // CORS proxy: /fetch?url=<URL>
    // v2: Delegate to the upstream v13 worker instead of fetching directly.
    // The upstream worker is on Cloudflare's network and can fetch abysscdn.com
    // without being challenged. We just need to call it via curl (which the
    // workers.dev edge accepts, unlike the roku's TLS).
    if (pathname === '/fetch') {
        const targetUrl = query.url;
        if (!targetUrl) {
            setCors(res);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        // Build the upstream URL: <UPSTREAM_WORKER>/fetch?url=<encoded targetUrl>
        const upstreamUrl = `${UPSTREAM_WORKER}/fetch?url=${encodeURIComponent(targetUrl)}`;
        logRequest({ endpoint: '/fetch', target: targetUrl, upstream: upstreamUrl });

        const result = curlFetch(upstreamUrl, { referer: 'https://embedplayabyss.top/' });
        setCors(res);
        res.writeHead(result.status, {
            'Content-Type': result.contentType || 'text/html',
            'Access-Control-Expose-Headers': '*',
            'X-Upstream-Worker': UPSTREAM_WORKER,
        });
        res.end(result.body);
        return;
    }

    // Video range stitching: /?seg0=<URL>&seg1=<URL>&frag=N&total=M
    // v2: Delegate to the upstream v13 worker's /?seg0=... endpoint.
    if (pathname === '/' && query.seg0) {
        const seg0Url = query.seg0;
        const seg1Url = query.seg1;
        const frag = query.frag;
        const total = query.total;

        // Build the upstream URL with the same query string
        const upstreamQuery = new URLSearchParams({
            seg0: seg0Url,
            ...(seg1Url ? { seg1: seg1Url } : {}),
            ...(frag ? { frag } : {}),
            ...(total ? { total } : {}),
        }).toString();
        const upstreamUrl = `${UPSTREAM_WORKER}/?${upstreamQuery}`;

        logRequest({
            endpoint: '/range-stitch',
            seg0: seg0Url,
            seg1: seg1Url,
            frag,
            total,
            upstream: upstreamUrl,
        });

        const result = curlFetchBuffer(upstreamUrl, { referer: 'https://embedplayabyss.top/', maxTime: '120' });
        setCors(res);
        res.writeHead(result.status, {
            'Content-Type': result.contentType || 'video/mp4',
            'Content-Length': String(result.body.length),
            'Access-Control-Expose-Headers': '*',
            'Cache-Control': 'no-store',
            'X-Frag-Index': String(frag || ''),
            'X-Total-Frags': String(total || ''),
            'X-Upstream-Worker': UPSTREAM_WORKER,
        });
        res.end(result.body);
        return;
    }

    // Debug endpoint: test what upstream returns for a URL
    if (pathname === '/debug' && query.url) {
        const targetUrl = query.url;
        const upstreamUrl = `${UPSTREAM_WORKER}/fetch?url=${encodeURIComponent(targetUrl)}`;
        logRequest({ endpoint: '/debug', target: targetUrl, upstream: upstreamUrl });

        const result = curlFetch(upstreamUrl, { referer: 'https://embedplayabyss.top/' });
        setCors(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            target_url: targetUrl,
            upstream_worker: UPSTREAM_WORKER,
            upstream_url_called: upstreamUrl,
            upstream_status: result.status,
            upstream_content_type: result.contentType,
            body_length: result.body.length,
            first_300_chars: result.body.slice(0, 300),
            looks_like_cf_challenge: result.body.includes('Just a moment') || result.body.includes('cloudflare'),
            has_datas_variable: result.body.includes('const datas') || result.body.includes('eyJzbHVn'),
        }, null, 2));
        return;
    }

    // Unknown endpoint
    setCors(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
});

server.listen(PORT, () => {
    console.log(`Abyss proxy v2 listening on port ${PORT}`);
    console.log(`Upstream worker: ${UPSTREAM_WORKER}`);
    console.log(`Health check: http://localhost:${PORT}/`);
    console.log(`CORS proxy:   http://localhost:${PORT}/fetch?url=<URL>`);
    try {
        const version = execSync('curl --version').toString().split('\n')[0];
        console.log(`curl available: ${version}`);
    } catch (e) {
        console.log('WARNING: curl not found! /fetch will not work');
    }
});
