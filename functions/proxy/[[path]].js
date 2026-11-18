// functions/proxy/[[path]].js

// --- 配置说明 ---
// 请确保在 Cloudflare Pages 设置 -> 函数 -> 环境变量绑定 中设置以下变量:
// CACHE_TTL (例如 86400)
// MAX_RECURSION (例如 5)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字符串数组
// DEBUG (例如 false 或 true)
// PASSWORD (例如 "your_password") - 鉴权密码
// LIBRETV_PROXY_KV - 绑定的 KV 命名空间

// --- 常量定义 ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];

/**
 * 主要的 Pages Function 处理函数
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    // 1. 从路径中提取目标 URL
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
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            }
        }
    } catch (e) {
        logDebug(DEBUG_ENABLED, `解析 USER_AGENTS_JSON 失败: ${e.message}`);
    }

    // 3. 核心逻辑：判断是否需要鉴权
    // 判断是否为媒体/图片文件 (通过扩展名判断，忽略 URL 参数)
    const isMedia = MEDIA_FILE_EXTENSIONS.some(ext => 
        targetUrl.split('?')[0].toLowerCase().endsWith(ext)
    );

    if (!isMedia) {
        // 只有非媒体文件（如 M3U8 列表）才执行鉴权
        const isValidAuth = await validateAuth(request, env);
        if (!isValidAuth) {
            logDebug(DEBUG_ENABLED, `鉴权失败: ${targetUrl}`);
            return createResponse(JSON.stringify({
                success: false,
                error: '代理访问未授权：请检查密码配置或鉴权参数'
            }), 401, { 'Content-Type': 'application/json' }, request);
        }
    } else {
        logDebug(DEBUG_ENABLED, `检测到媒体/图片请求，跳过鉴权: ${targetUrl}`);
    }

    // 4. 缓存检查 (KV)
    const cacheKey = `proxy_raw:${targetUrl}`;
    let kvNamespace = null;
    try {
        kvNamespace = env.LIBRETV_PROXY_KV;
    } catch (e) {
        logDebug(DEBUG_ENABLED, `KV 命名空间访问出错: ${e.message}`);
    }

    if (kvNamespace) {
        try {
            const cachedDataJson = await kvNamespace.get(cacheKey);
            if (cachedDataJson) {
                logDebug(DEBUG_ENABLED, `[缓存命中] 原始内容: ${targetUrl}`);
                const cachedData = JSON.parse(cachedDataJson);
                const content = cachedData.body;
                let headers = {};
                try { headers = JSON.parse(cachedData.headers); } catch(e){}
                const contentType = headers['content-type'] || headers['Content-Type'] || '';

                if (isM3u8Content(content, contentType)) {
                    logDebug(DEBUG_ENABLED, `缓存内容是 M3U8，重新处理: ${targetUrl}`);
                    const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
                    return createM3u8Response(processedM3u8, CACHE_TTL, request);
                } else {
                    return createResponse(content, 200, headers, request);
                }
            }
        } catch (kvError) {
            logDebug(DEBUG_ENABLED, `KV 读取失败: ${kvError.message}`);
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
                const cacheValue = { body: content, headers: JSON.stringify(headersToCache) };
                waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
            } catch (kvError) {
                logDebug(DEBUG_ENABLED, `写入缓存失败: ${kvError.message}`);
            }
        }

        // 6. 处理响应
        if (isM3u8Content(content, contentType)) {
            logDebug(DEBUG_ENABLED, `内容是 M3U8，开始处理: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
            return createM3u8Response(processedM3u8, CACHE_TTL, request);
        } else {
            logDebug(DEBUG_ENABLED, `内容直接返回: ${targetUrl}`);
            const finalHeaders = new Headers(responseHeaders);
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            return createResponse(content, 200, finalHeaders, request);
        }

    } catch (error) {
        logDebug(DEBUG_ENABLED, `严重错误: ${error.message}`);
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

// --- 辅助函数 (使用 function 关键字以确保提升) ---

async function validateAuth(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const timestamp = url.searchParams.get('t');
    const serverPassword = env.PASSWORD;

    if (!serverPassword) return false;

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(serverPassword);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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
        if (!decodedUrl.match(/^https?:\/\//i)) {
            if (encodedUrl.match(/^https?:\/\//i)) decodedUrl = encodedUrl;
            else return null;
        }
        return decodedUrl;
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
    const headers = {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": `public, max-age=${ttl}`,
        "Access-Control-Allow-Origin": "*"
    };
    return new Response(content, { status: 200, headers });
}

function logDebug(enabled, message) {
    if (enabled) console.log(`[Proxy Func] ${message}`);
}

async function fetchContentWithType(targetUrl, userAgents, request) {
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    const headers = new Headers({
        'User-Agent': ua,
        'Accept': '*/*',
        'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': request.headers.get('Referer') || new URL(targetUrl).origin
    });

    const response = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const content = await response.text();
    const contentType = response.headers.get('Content-Type') || '';
    return { content, contentType, responseHeaders: response.headers };
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl'))) return true;
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function getBaseUrl(urlStr) {
    try {
        const parsedUrl = new URL(urlStr);
        const pathParts = parsedUrl.pathname.split('/');
        pathParts.pop();
        return `${parsedUrl.origin}${pathParts.join('/')}/`;
    } catch (e) {
        const lastSlashIndex = urlStr.lastIndexOf('/');
        return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (relativeUrl.match(/^https?:\/\//i)) return relativeUrl;
    try {
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        if (relativeUrl.startsWith('/')) {
            const urlObj = new URL(baseUrl);
            return `${urlObj.origin}${relativeUrl}`;
        }
        return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`;
    }
}

function rewriteUrlToProxy(targetUrl) {
    return `/proxy/${encodeURIComponent(targetUrl)}`;
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

