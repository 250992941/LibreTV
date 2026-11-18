// functions/proxy/[[path]].js

// --- 常量定义 ---
// 使用正则表达式进行更强大的媒体文件识别，支持带参数的 URL (如 image.jpg?v=1)
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
        return createResponse("无效的代理请求。路径应为 /proxy/<经过编码的URL>", 400, {}, request);
    }

    // 2. 配置读取
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');
    
    let USER_AGENTS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'];
    try {
        if (env.USER_AGENTS_JSON) USER_AGENTS = JSON.parse(env.USER_AGENTS_JSON);
    } catch (e) {
        if (DEBUG_ENABLED) console.log(`[Proxy] 解析 USER_AGENTS_JSON 失败: ${e.message}`);
    }

    // 3. 核心逻辑：判断是否需要鉴权
    // 如果是图片、视频、音频等媒体文件，直接跳过鉴权
    const isMedia = MEDIA_REGEX.test(targetUrl);

    if (!isMedia) {
        const isValidAuth = await validateAuth(request, env);
        if (!isValidAuth) {
            return createResponse(JSON.stringify({
                success: false,
                error: '代理访问未授权：请检查密码配置或鉴权参数'
            }), 401, { 'Content-Type': 'application/json' }, request);
        }
    }

    // 4. 缓存检查 (KV)
    const cacheKey = `proxy_raw:${targetUrl}`;
    let kvNamespace = env.LIBRETV_PROXY_KV;

    if (kvNamespace) {
        try {
            const cachedDataJson = await kvNamespace.get(cacheKey);
            if (cachedDataJson) {
                const cachedData = JSON.parse(cachedDataJson);
                const content = cachedData.body;
                let headers = {};
                try { headers = JSON.parse(cachedData.headers); } catch(e){}
                const contentType = headers['content-type'] || headers['Content-Type'] || '';

                if (isM3u8Content(content, contentType)) {
                    // 缓存的是 M3U8 原始内容，需要重新通过 processM3u8Content 处理相对路径
                    const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
                    return createM3u8Response(processedM3u8, CACHE_TTL, request);
                } else {
                    return createResponse(content, 200, headers, request);
                }
            }
        } catch (kvError) {
            if (DEBUG_ENABLED) console.log(`[Proxy] KV 读取失败: ${kvError.message}`);
        }
    }

    // 5. 实际请求
    try {
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, USER_AGENTS, request);

        // 写入缓存
        if (kvNamespace) {
            try {
                const headersToCache = {};
                responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
                const cacheValue = { body: content, headers: JSON.stringify(headersToCache), contentType };
                waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
            } catch (kvError) {
                if (DEBUG_ENABLED) console.log(`[Proxy] 写入缓存失败: ${kvError.message}`);
            }
        }

        // 6. 处理响应
        if (isM3u8Content(content, contentType)) {
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
            return createM3u8Response(processedM3u8, CACHE_TTL, request);
        } else {
            const finalHeaders = new Headers(responseHeaders);
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            return createResponse(content, 200, finalHeaders, request);
        }

    } catch (error) {
        if (DEBUG_ENABLED) console.log(`[Proxy] 严重错误: ${error.message}`);
        return createResponse(`代理处理错误: ${error.message}`, 500, {}, request);
    }
}

/**
 * 处理 OPTIONS 预检请求
 */
export async function onOptions(context) {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        },
    });
}

// --- 辅助函数 ---

async function validateAuth(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const timestamp = url.searchParams.get('t');
    const serverPassword = env.PASSWORD;

    if (!serverPassword) return false;

    try {
        const encoder = new TextEncoder();
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(serverPassword));
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const serverPasswordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        if (!authHash || authHash !== serverPasswordHash) return false;

        if (timestamp) {
            const now = Date.now();
            if (now - parseInt(timestamp) > 10 * 60 * 1000) return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

function getTargetUrlFromPath(pathname) {
    const encodedUrl = pathname.replace(/^\/proxy\//, '');
    if (!encodedUrl) return null;
    try {
        let decodedUrl = decodeURIComponent(encodedUrl);
        return decodedUrl.match(/^https?:\/\//i) ? decodedUrl : null;
    } catch (e) {
        return null;
    }
}

function createResponse(body, status = 200, headers = {}, request) {
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    return new Response(body, { status, headers: responseHeaders });
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
    if (contentType && (contentType.includes('mpegurl') || contentType.includes('x-mpegurl'))) return true;
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

async function fetchContentWithType(targetUrl, userAgents, request) {
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    const targetUrlObj = new URL(targetUrl);
    
    // --- 核心伪装逻辑：针对豆瓣进行 Referer 伪装 ---
    let referer = request.headers.get('Referer') || targetUrlObj.origin;
    if (targetUrlObj.hostname.includes('douban.com')) {
        referer = 'https://movie.douban.com/';
    }

    const headers = new Headers({
        'User-Agent': ua,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': referer,
        'Connection': 'keep-alive'
    });

    const response = await fetch(targetUrl, { headers, redirect: 'follow' });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();
    const contentType = response.headers.get('Content-Type') || '';
    return { content, contentType, responseHeaders: response.headers };
}

// === 请在此处粘贴您原有的 M3U8 处理逻辑 ===
// (请从您的旧文件中找到 async function processM3u8Content 开始的所有代码并粘贴到这里)


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

