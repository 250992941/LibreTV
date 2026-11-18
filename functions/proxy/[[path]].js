// functions/proxy/[[path]].js

// --- 常量定义 ---
const MEDIA_REGEX = /\.(mp4|webm|mkv|avi|mov|wmv|flv|f4v|m4v|3gp|3g2|ts|mts|m2ts|mp3|wav|ogg|aac|m4a|flac|wma|alac|aiff|opus|jpg|jpeg|png|gif|webp|bmp|tiff|svg|avif|heic)(\?.*)?$/i;

/**
 * 主要的 Pages Function 处理函数
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    // 1. 解析目标 URL
    const targetUrl = getTargetUrlFromPath(url.pathname);
    if (!targetUrl) {
        return createResponse("无效的代理请求", 400, {}, request);
    }

    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');
    
    // 2. 准备 User-Agents
    let USER_AGENTS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'];
    try {
        if (env.USER_AGENTS_JSON) USER_AGENTS = JSON.parse(env.USER_AGENTS_JSON);
    } catch (e) {}

    // 3. 鉴权判断
    // 使用正则表达式进行更强大的媒体文件识别
    const isMedia = MEDIA_REGEX.test(targetUrl);

    if (!isMedia) {
        const isValidAuth = await validateAuth(request, env);
        if (!isValidAuth) {
            return createResponse(JSON.stringify({ success: false, error: 'Unauthorized' }), 401, { 'Content-Type': 'application/json' }, request);
        }
    }

    // 4. 缓存与请求逻辑
    const cacheKey = `proxy_raw:${targetUrl}`;
    let kvNamespace = env.LIBRETV_PROXY_KV;

    // 尝试从 KV 读取
    if (kvNamespace) {
        try {
            const cached = await kvNamespace.get(cacheKey);
            if (cached) {
                const data = JSON.parse(cached);
                if (isM3u8Content(data.body, data.contentType)) {
                    const processed = await processM3u8Content(targetUrl, data.body, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
                    return createM3u8Response(processed, CACHE_TTL, request);
                }
                return createResponse(data.body, 200, data.headers, request);
            }
        } catch (e) {}
    }

    // 5. 发起实际请求
    try {
        const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        const fetchHeaders = new Headers({
            'User-Agent': ua,
            'Accept': '*/*',
            'Referer': new URL(targetUrl).origin,
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9'
        });

        const response = await fetch(targetUrl, { headers: fetchHeaders, redirect: 'follow' });

        // 【关键改进】如果目标返回 418 或其他非 200 状态，直接透传给前端，方便调试
        if (!response.ok) {
            return createResponse(`Origin Error: ${response.status}`, response.status, {}, request);
        }

        const content = await response.text();
        const contentType = response.headers.get('Content-Type') || '';

        // 写入缓存
        if (kvNamespace) {
            const headerObj = {};
            response.headers.forEach((v, k) => headerObj[k.toLowerCase()] = v);
            const cacheData = JSON.stringify({ body: content, headers: JSON.stringify(headerObj), contentType });
            waitUntil(kvNamespace.put(cacheKey, cacheData, { expirationTtl: CACHE_TTL }));
        }

        // 6. 返回响应
        if (isM3u8Content(content, contentType)) {
            const processed = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
            return createM3u8Response(processed, CACHE_TTL, request);
        } else {
            const finalHeaders = new Headers(response.headers);
            finalHeaders.set('Access-Control-Allow-Origin', '*');
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            return new Response(content, { status: 200, headers: finalHeaders });
        }

    } catch (error) {
        return createResponse(`Proxy Error: ${error.message}`, 500, {}, request);
    }
}

// --- 辅助函数 (保持逻辑完整) ---

async function validateAuth(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const serverPassword = env.PASSWORD;
    if (!serverPassword || !authHash) return false;
    try {
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(serverPassword));
        const serverPasswordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        return authHash === serverPasswordHash;
    } catch (e) { return false; }
}

function getTargetUrlFromPath(pathname) {
    const encodedUrl = pathname.replace(/^\/proxy\//, '');
    if (!encodedUrl) return null;
    try {
        let decoded = decodeURIComponent(encodedUrl);
        return decoded.match(/^https?:\/\//i) ? decoded : null;
    } catch (e) { return null; }
}

function createResponse(body, status, headers, request) {
    const h = new Headers(headers);
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(body, { status, headers: h });
}

function createM3u8Response(content, ttl, request) {
    return new Response(content, {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": `public, max-age=${ttl}`,
            "Access-Control-Allow-Origin": "*"
        }
    });
}

function isM3u8Content(content, contentType) {
    return (contentType && contentType.includes('mpegurl')) || (content && content.trim().startsWith('#EXTM3U'));
}

// --- M3U8 处理逻辑 ---

async function processM3u8Content(targetUrl, content, recursionDepth, env, cacheTtl, maxRecursion, userAgents, kvNamespace, waitUntil, debugEnabled) {
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        return await processMasterPlaylist(targetUrl, content, recursionDepth, env, cacheTtl, maxRecursion, userAgents, kvNamespace, waitUntil, debugEnabled);
    }
    return processMediaPlaylist(targetUrl, content, rewriteUrlToProxy);
}

function processMediaPlaylist(url, content, rewriteFn) {
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    const output = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { output.push(line); continue; }

        if (line.startsWith('#EXT-X-KEY')) {
            output.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteFn(resolveUrl(baseUrl, uri))}"`));
            continue;
        }
        if (line.startsWith('#EXT-X-MAP')) {
            output.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteFn(resolveUrl(baseUrl, uri))}"`));
            continue;
        }
        if (line.startsWith('#EXTINF')) {
            output.push(line);
            continue;
        }
        if (!line.startsWith('#')) {
            output.push(rewriteFn(resolveUrl(baseUrl, line)));
            continue;
        }
        output.push(line);
    }
    return output.join('\n');
}

async function processMasterPlaylist(url, content, recursionDepth, env, cacheTtl, maxRecursion, userAgents, kvNamespace, waitUntil, debugEnabled) {
    if (recursionDepth > maxRecursion) throw new Error(`Recursion limit reached: ${url}`);

    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    let bestVariantUrl = '';

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            let variantUriLine = '';
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (line && !line.startsWith('#')) {
                    variantUriLine = line;
                    i = j;
                    break;
                }
            }
            if (variantUriLine) {
                bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
                break;
            }
        }
    }

    if (!bestVariantUrl) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#') && (line.endsWith('.m3u8') || line.includes('.m3u8?'))) {
                bestVariantUrl = resolveUrl(baseUrl, line);
                break;
            }
        }
    }

    if (!bestVariantUrl) return processMediaPlaylist(url, content, rewriteUrlToProxy);

    const cacheKey = `m3u8_processed:${bestVariantUrl}`;
    if (kvNamespace) {
        const cached = await kvNamespace.get(cacheKey);
        if (cached) return cached;
    }

    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, userAgents, { headers: new Headers({ 'Referer': new URL(bestVariantUrl).origin }) });
    
    const processed = await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1, env, cacheTtl, maxRecursion, userAgents, kvNamespace, waitUntil, debugEnabled);

    if (kvNamespace) {
        waitUntil(kvNamespace.put(cacheKey, processed, { expirationTtl: cacheTtl }));
    }

    return processed;
}

