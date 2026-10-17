/**
 * Abyss CDN Proxy — Node.js version for Render.com
 *
 * Uses child_process.execSync('curl ...') to fetch URLs. This is critical
 * because Node's native fetch (undici) and https.request have different
 * TLS fingerprints (JA3) than curl. Cloudflare's bot detection on
 * abysscdn.com accepts curl's TLS fingerprint but blocks Node's.
 *
 * WHY THIS EXISTS:
 *   Cloudflare workers.dev edge blocks the Roku's TLS fingerprint with a
 *   "Just a moment..." managed challenge page (HTTP 403). Render.com doesn't
 *   have this edge protection, so the Roku can reach this server directly.
 *   But this server still needs to fetch abysscdn.com — and abysscdn.com is
 *   also behind Cloudflare, which fingerprints the FETCHING client's TLS.
 *   So this server uses curl (not Node's fetch) to call abysscdn.com.
 *
 * ENDPOINTS:
 *   GET  /                                — health check
 *   GET  /fetch?url=<URL>                 — CORS proxy (fetches URL via curl)
 *   GET  /?seg0=<URL>&seg1=<URL>&frag=N&total=M
 *                                        — video range stitching (concatenates
 *                                           two segments for >512MB playback)
 *   GET  /debug?seg0=<URL>&frag=N&total=M — test origin connectivity
 *   GET  /logs                            — recent request log (last 30)
 *
 * DEPLOY ON RENDER.COM:
 *   1. Push these files to a GitHub repo (public or private)
 *   2. Go to https://dashboard.render.com → New → Web Service
 *   3. Connect your GitHub repo
 *   4. Settings:
 *        - Runtime: Node
 *        - Build Command: npm install  (no deps needed; curl is pre-installed)
 *        - Start Command: npm start
 *        - Instance Type: Free
 *   5. Click "Create Web Service"
 *   6. Wait ~1-2 min for build & deploy
 *   7. Test: curl https://your-service.onrender.com/
 *      Should return: "Abyss CDN Proxy v1-render OK"
 *   8. Test the CORS proxy:
 *      curl "https://your-service.onrender.com/fetch?url=https%3A%2F%2Fabysscdn.com%2F%3Fv%3D01gE05Adb"
 *      Should return 200 + HTML containing "const datas"
 *
 * THEN IN THE ROKU APP (components/FetchTask.brs):
 *   1. Find the line near the top of tryAbyssExtraction():
 *        ABYSS_PAGE_WORKER_BASE_URL = "https://abyss-proxy.ognoses.workers.dev"
 *      Replace with:
 *        ABYSS_PAGE_WORKER_BASE_URL = "https://your-service.onrender.com"
 *   2. Find WORKER_PROXY_URL (for video range stitching):
 *        WORKER_PROXY_URL = "https://abyss-proxy.ognoses.workers.dev/"
 *      Replace with:
 *        WORKER_PROXY_URL = "https://your-service.onrender.com/"
 *   3. Rezip and side-load
 *
 * TROUBLESHOOTING:
 *   - If /fetch returns 500 with "curl not found": make sure Render's runtime
 *     is "Node" (which uses a Linux container with curl pre-installed)
 *   - If /fetch returns 403 from abysscdn.com: the curl command might be
 *     missing headers. Check /logs to see what's being requested
 */

const http = require('http');
const { execFileSync, execSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

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
 * Use curl to fetch a URL — curl's TLS fingerprint is accepted by Cloudflare
 * (Node's fetch/https.request are NOT, because of JA3 fingerprinting).
 *
 * Returns: { status, contentType, body }
 */
function curlFetch(targetUrl, { referer = 'https://embedplayabyss.top/' } = {}) {
    // Build the curl command args
    const args = [
        '-s',                          // silent
        '-o', '-',                     // output to stdout
        '-w', '\n---HTTP_STATUS:%{http_code}---\n---CONTENT_TYPE:%{content_type}---\n',  // append status
        '--compressed',                // auto-decompress
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        '-H', 'Accept-Language: pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        '-H', `Referer: ${referer}`,
        '--max-time', '30',            // 30s timeout
        '-L',                          // follow redirects (max 5 by default)
        '--max-redirs', '5',
        targetUrl,
    ];

    let output;
    try {
        output = execFileSync('curl', args, {
            maxBuffer: 200 * 1024 * 1024,  // 200MB max (for video segments)
            timeout: 35000,
        }).toString('utf-8');
    } catch (err) {
        // curl failed — return error
        return {
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'curl exec failed', message: String(err.message || err) }),
        };
    }

    // Parse out the status/content-type we appended
    const statusMatch = output.match(/---HTTP_STATUS:(\d+)---\n---CONTENT_TYPE:([^-\n]*)---\n?$/);
    if (!statusMatch) {
        // Couldn't parse — return raw output as 200
        return { status: 200, contentType: 'text/html', body: output };
    }

    const status = parseInt(statusMatch[1], 10);
    const contentType = statusMatch[2].trim();
    const body = output.slice(0, statusMatch.index);

    return { status, contentType, body };
}

/**
 * Use curl to fetch binary data (for video segments) — returns Buffer.
 */
function curlFetchBuffer(targetUrl, { referer = 'https://embedplayabyss.top/' } = {}) {
    const args = [
        '-s',
        '-o', '-',                     // binary output to stdout
        '-w', '\n---HTTP_STATUS:%{http_code}---\n---CONTENT_TYPE:%{content_type}---\n',
        '--compressed',
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-H', 'Accept: */*',
        '-H', `Referer: ${referer}`,
        '--max-time', '60',
        '-L',
        '--max-redirs', '5',
        targetUrl,
    ];

    let output;
    try {
        output = execFileSync('curl', args, {
            maxBuffer: 500 * 1024 * 1024,  // 500MB max for video segments
            timeout: 65000,
        });
    } catch (err) {
        return {
            status: 502,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ error: 'curl exec failed', message: String(err.message || err) })),
        };
    }

    // Find the boundary marker in the binary output
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
        res.end('Abyss CDN Proxy v1-render OK\n\nEndpoints:\n  /                                — health check\n  /fetch?url=<URL>                 — CORS proxy (via curl)\n  /?seg0=<URL>&seg1=<URL>&frag=N&total=M — video range stitching\n  /debug?seg0=<URL>&frag=N&total=M — test connectivity\n  /logs                            — recent request log\n');
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
    if (pathname === '/fetch') {
        const targetUrl = query.url;
        if (!targetUrl) {
            setCors(res);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        logRequest({ endpoint: '/fetch', url: targetUrl });
        const result = curlFetch(targetUrl);
        setCors(res);
        res.writeHead(result.status, {
            'Content-Type': result.contentType || 'text/html',
            'Access-Control-Expose-Headers': '*',
        });
        res.end(result.body);
        return;
    }

    // Video range stitching: /?seg0=<URL>&seg1=<URL>&frag=N&total=M
    if (pathname === '/' && query.seg0) {
        const seg0Url = query.seg0;
        const seg1Url = query.seg1;
        const frag = query.frag;
        const total = query.total;

        logRequest({ endpoint: '/range-stitch', seg0: seg0Url, seg1: seg1Url, frag, total });

        if (!seg1Url) {
            // Single segment — fetch and pass through as binary
            const result = curlFetchBuffer(seg0Url);
            setCors(res);
            res.writeHead(result.status, {
                'Content-Type': result.contentType || 'video/mp4',
                'Content-Length': String(result.body.length),
                'Access-Control-Expose-Headers': '*',
                'Cache-Control': 'no-store',
                'X-Frag-Index': String(frag || ''),
                'X-Total-Frags': String(total || ''),
            });
            res.end(result.body);
            return;
        }

        // Two segments — fetch both in parallel, concatenate, return as one response
        // Note: child_process.execFileSync is sync; for parallel we'd need execFile with callbacks
        // For simplicity, fetch sequentially here (perf hit but works correctly)
        const seg0Result = curlFetchBuffer(seg0Url);
        if (seg0Result.status !== 200) {
            setCors(res);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'seg0 fetch failed',
                seg0_status: seg0Result.status,
            }));
            return;
        }
        const seg1Result = curlFetchBuffer(seg1Url);
        if (seg1Result.status !== 200) {
            setCors(res);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'seg1 fetch failed',
                seg1_status: seg1Result.status,
            }));
            return;
        }

        const totalSize = seg0Result.body.length + seg1Result.body.length;
        setCors(res);
        res.writeHead(200, {
            'Content-Type': seg0Result.contentType || 'video/mp4',
            'Content-Length': String(totalSize),
            'Access-Control-Expose-Headers': '*',
            'Cache-Control': 'no-store',
            'X-Frag-Index': String(frag || ''),
            'X-Total-Frags': String(total || ''),
        });
        res.end(Buffer.concat([seg0Result.body, seg1Result.body]));
        return;
    }

    // Debug endpoint: test origin connectivity
    if (pathname === '/debug' && query.seg0) {
        logRequest({ endpoint: '/debug', url: query.seg0 });
        const result = curlFetch(query.seg0);
        setCors(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            url: query.seg0,
            status: result.status,
            content_type: result.contentType,
            body_length: result.body.length,
            first_200_chars: result.body.slice(0, 200),
        }, null, 2));
        return;
    }

    // Unknown endpoint
    setCors(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: pathname }));
});

server.listen(PORT, () => {
    console.log(`Abyss proxy listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/`);
    console.log(`CORS proxy:   http://localhost:${PORT}/fetch?url=<URL>`);
    // Verify curl is available
    try {
        const version = execSync('curl --version').toString().split('\n')[0];
        console.log(`curl available: ${version}`);
    } catch (e) {
        console.log('WARNING: curl not found! /fetch will not work');
    }
});
