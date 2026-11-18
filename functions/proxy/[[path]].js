

// --- 常量定义 ---
const MEDIA_REGEX = /\.(mp4|webm|mkv|avi|mov|wmv|flv|f4v|m4v|3gp|3g2|ts|mts|m2ts|mp3|wav|ogg|aac|m4a|flac|wma|alac|aiff|opus|jpg|jpeg|png|gif|webp|bmp|tiff|svg|avif|heic)(\?.*)?$/i;

/**
 * 主要的 Pages Function 处理函数
 */
export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);

    // 1. 解析目标 URL (匹配 /p2/ 路径)
    const targetUrl = getTargetUrlFromPath(url.pathname);
    if (!targetUrl) {
        return createResponse("无效的代理请求", 400, {}, request);
    }

    // 2. 配置读取
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');
    
    let USER_AGENTS = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'];
    try {
        if (env.USER_AGENTS_JSON) USER_AGENTS = JSON.parse(env.USER_AGENTS_JSON);
    } catch (e) {}

    // 3. 鉴权判断 (媒体文件自动跳过)
    const isMedia = MEDIA_REGEX.test(targetUrl);
    if (!isMedia) {
        const isValidAuth = await validateAuth(request, env);
        if (!isValidAuth) {
            return createResponse(JSON.stringify({ success: false, error: 'Unauthorized' }), 401, { 'Content-Type': 'application/json' }, request);
        }
    }

    // 4. 缓存检查 (仅针对文本/M3U8)
    const cacheKey = `proxy_v2:${targetUrl}`; 
    let kvNamespace = env.LIBRETV_PROXY_KV;

    if (kvNamespace) {
        try {
            const cachedDataJson = await kvNamespace.get(cacheKey);
            if (cachedDataJson) {
                const cachedData = JSON.parse(cachedDataJson);
                const contentType = cachedData.contentType || '';
                if (isM3u8Content(cachedData.body, contentType)) {
                    const processedM3u8 = await processM3u8Content(targetUrl, cachedData.body, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
                    return createM3u8Response(processedM3u8, CACHE_TTL, request);
                } else {
                    return createResponse(cachedData.body, 200, cachedData.headers, request);
                }
            }
        } catch (e) {}
    }

    // 5. 发起请求
    try {
        const { response, contentType } = await fetchWithSmartHandling(targetUrl, USER_AGENTS, request);

        // 6. 根据内容类型进行处理
        if (isMedia || contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
            // --- 情况 A: 图片/视频二进制内容 (核心修复：绝对不使用 .text()) ---
            const finalHeaders = new Headers(response.headers);
            finalHeaders.set('Access-Control-Allow-Origin', '*');
            // 强制不缓存，防止旧的坏数据再次中毒
            finalHeaders.set('Cache-Control', 'no-store, max-age=0');

            return new Response(response.body, {
                status: 200,
                headers: finalHeaders
            });
        } else {
            // --- 情况 B: M3U8 文本内容 ---
            const content = await response.text();

            if (kvNamespace) {
                try {
                    const headersToCache = {};
                    response.headers.forEach((v, k) => { headersToCache[k.toLowerCase()] = v; });
                    const cacheValue = JSON.stringify({ body: content, headers: JSON.stringify(headersToCache), contentType });
                    waitUntil(kvNamespace.put(cacheKey, cacheValue, { expirationTtl: CACHE_TTL }));
                } catch (e) {}
            }

            if (isM3u8Content(content, contentType)) {
                const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env, CACHE_TTL, MAX_RECURSION, USER_AGENTS, kvNamespace, waitUntil, DEBUG_ENABLED);
                return createM3u8Response(processedM3u8, CACHE_TTL, request);
            } else {
                return createResponse(content, 200, response.headers, request);
            }
        }

    } catch (error) {
        return createResponse(`Proxy Error: ${error.message}`, 500, {}, request);
    }
}

/**
 * 智能 Fetch (包含豆瓣伪装)
 */
async function fetchWithSmartHandling(targetUrl, userAgents, request) {
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    const targetUrlObj = new URL(targetUrl);
    
    let referer = request.headers.get('Referer') || targetUrlObj.origin;
    if (targetUrlObj.hostname.includes('douban.com')) {
        referer = 'https://movie.douban.com/';
    }

    const headers = new Headers({
        'User-Agent': ua,
        'Accept': '*/*',
        'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': referer,
    });

    const response = await fetch(targetUrl, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return { 
        response, 
        contentType: response.headers.get('content-type') || '' 
    };
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
        if (timestamp && (Date.now() - parseInt(timestamp) > 600000)) return false;
        return true;
    } catch (e) { return false; }
}

function getTargetUrlFromPath(pathname) {
    const encodedUrl = pathname.replace(/^\/p2\//, '');
    if (!encodedUrl) return null;
    try {
        let decoded = decodeURIComponent(encodedUrl);
        return decoded.match(/^https?:\/\//i) ? decoded : null;
    } catch (e) { return null; }
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

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    // 判断是主列表还是媒体列表
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`检测到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return await processMasterPlaylist(targetUrl, content, recursionDepth);
    }
    logDebug(`检测到媒体播放列表: ${targetUrl} (深度: ${recursionDepth})`);
    return processMediaPlaylist(targetUrl, content);
}

async function processMasterPlaylist(url, content, recursionDepth) {
    // 检查递归深度
    if (recursionDepth > MAX_RECURSION) {
        throw new Error(`处理主播放列表时，递归深度超过最大限制 (${MAX_RECURSION}): ${url}`);
    }
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    let highestBandwidth = -1;
    let bestVariantUrl = '';

    // 查找最高带宽的流
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
            const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            let variantUriLine = '';
            // 找到下一行的 URI
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (line && !line.startsWith('#')) { variantUriLine = line; i = j; break; }
            }
            if (variantUriLine && currentBandwidth >= highestBandwidth) {
                highestBandwidth = currentBandwidth;
                bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
            }
        }
    }
    // 如果没有找到带宽信息，尝试查找第一个 .m3u8 链接
    if (!bestVariantUrl) {
        logDebug(`主播放列表中未找到 BANDWIDTH 信息，尝试查找第一个 URI: ${url}`);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
             // 更可靠地匹配 .m3u8 链接
            if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) {
                bestVariantUrl = resolveUrl(baseUrl, line);
                logDebug(`备选方案: 找到第一个子播放列表 URI: ${bestVariantUrl}`);
                break;
            }
        }
    }
    // 如果仍然没有找到子列表 URL
    if (!bestVariantUrl) {
        logDebug(`在主播放列表 ${url} 中未找到有效的子列表 URI，将其作为媒体列表处理。`);
        return processMediaPlaylist(url, content);
    }

    logDebug(`选择的子播放列表 (带宽: ${highestBandwidth}): ${bestVariantUrl}`);
    // 请求选定的子播放列表内容 (注意：这里传递 {} 作为请求头，不传递客户端的原始请求头)
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});

    // 检查获取的内容是否是 M3U8
    if (!isM3u8Content(variantContent, variantContentType)) {
        logDebug(`获取的子播放列表 ${bestVariantUrl} 不是 M3U8 (类型: ${variantContentType})，将其作为媒体列表处理。`);
        return processMediaPlaylist(bestVariantUrl, variantContent);
    }

    // 递归处理获取到的子 M3U8 内容
    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

/**
 * 验证代理请求的鉴权
 */
async function validateAuth(req) {
    const authHash = req.query.auth;
    const timestamp = req.query.t;
    
    // 获取服务器端密码哈希
    const serverPassword = process.env.PASSWORD;
    if (!serverPassword) {
        console.error('服务器未设置 PASSWORD 环境变量，代理访问被拒绝');
        return false;
    }
    
    // 使用 crypto 模块计算 SHA-256 哈希
    const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
    
    if (!authHash || authHash !== serverPasswordHash) {
        console.warn('代理请求鉴权失败：密码哈希不匹配');
        return false;
    }
    
    // 验证时间戳（10分钟有效期）
    if (timestamp) {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000; // 10分钟
        if (now - parseInt(timestamp) > maxAge) {
            console.warn('代理请求鉴权失败：时间戳过期');
            return false;
        }
    }
    
    return true;
}

// --- Vercel Handler 函数 ---
export default async function handler(req, res) {
    // --- 记录请求开始 ---
    console.info('--- Vercel 代理请求开始 ---');
    console.info('时间:', new Date().toISOString());
    console.info('方法:', req.method);
    console.info('URL:', req.url); // 原始请求 URL (例如 /proxy/...)
    console.info('查询参数:', JSON.stringify(req.query)); // Vercel 解析的查询参数

    // --- 提前设置 CORS 头 ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*'); // 允许所有请求头

    // --- 处理 OPTIONS 预检请求 ---
    if (req.method === 'OPTIONS') {
        console.info("处理 OPTIONS 预检请求");
        res.status(204).setHeader('Access-Control-Max-Age', '86400').end(); // 缓存预检结果 24 小时
        return;
    }

    let targetUrl = null; // 初始化目标 URL

    try { // ---- 开始主处理逻辑的 try 块 ----

        // --- 验证鉴权 ---
        const isAuthorized = await validateAuth(req);
        if (!isAuthorized) {
            console.warn('代理请求鉴权失败');
            res.status(401).json({
                success: false,
                error: '代理访问未授权：请检查密码配置或鉴权参数'
            });
            return;
        }

        // --- 提取目标 URL (主要依赖 req.query["...path"]) ---
        // Vercel 将 :path* 捕获的内容（可能包含斜杠）放入 req.query["...path"] 数组
        const pathData = req.query["...path"]; // 使用正确的键名
        let encodedUrlPath = '';

        if (pathData) {
            if (Array.isArray(pathData)) {
                encodedUrlPath = pathData.join('/'); // 重新组合
                console.info(`从 req.query["...path"] (数组) 组合的编码路径: ${encodedUrlPath}`);
            } else if (typeof pathData === 'string') {
                encodedUrlPath = pathData; // 也处理 Vercel 可能只返回字符串的情况
                console.info(`从 req.query["...path"] (字符串) 获取的编码路径: ${encodedUrlPath}`);
            } else {
                console.warn(`[代理警告] req.query["...path"] 类型未知: ${typeof pathData}`);
            }
        } else {
            console.warn(`[代理警告] req.query["...path"] 为空或未定义。`);
            // 备选：尝试从 req.url 提取（如果需要）
            if (req.url && req.url.startsWith('/proxy/')) {
                encodedUrlPath = req.url.substring('/proxy/'.length);
                console.info(`使用备选方法从 req.url 提取的编码路径: ${encodedUrlPath}`);
            }
        }

        // 如果仍然为空，则无法继续
        if (!encodedUrlPath) {
             throw new Error("无法从请求中确定编码后的目标路径。");
        }

        // 解析目标 URL
        targetUrl = getTargetUrlFromPath(encodedUrlPath);
        console.info(`解析出的目标 URL: ${targetUrl || 'null'}`); // 记录解析结果

        // 检查目标 URL 是否有效
        if (!targetUrl) {
            // 抛出包含更多上下文的错误
            throw new Error(`无效的代理请求路径。无法从组合路径 "${encodedUrlPath}" 中提取有效的目标 URL。`);
        }

        console.info(`开始处理目标 URL 的代理请求: ${targetUrl}`);

        // --- 获取并处理目标内容 ---
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers);

        // --- 如果是 M3U8，处理并返回 ---
        if (isM3u8Content(content, contentType)) {
            console.info(`正在处理 M3U8 内容: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content);

            console.info(`成功处理 M3U8: ${targetUrl}`);
            // 发送处理后的 M3U8 响应
            res.status(200)
                .setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8')
                .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
                // 移除可能导致问题的原始响应头
                .removeHeader('content-encoding') // 很重要！node-fetch 已解压
                .removeHeader('content-length')   // 长度已改变
                .send(processedM3u8); // 发送 M3U8 文本

        } else {
            // --- 如果不是 M3U8，直接返回原始内容 ---
            console.info(`直接返回非 M3U8 内容: ${targetUrl}, 类型: ${contentType}`);

            // 设置原始响应头，但排除有问题的头和 CORS 头（已设置）
            responseHeaders.forEach((value, key) => {
                 const lowerKey = key.toLowerCase();
                 if (!lowerKey.startsWith('access-control-') &&
                     lowerKey !== 'content-encoding' && // 很重要！
                     lowerKey !== 'content-length') {   // 很重要！
                     res.setHeader(key, value); // 设置其他原始头
                 }
             });
            // 设置我们自己的缓存策略
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);

            // 发送原始（已解压）内容
            res.status(200).send(content);
        }

    // ---- 结束主处理逻辑的 try 块 ----
    } catch (error) { // ---- 捕获处理过程中的任何错误 ----
        // **检查这个错误是否是 "Assignment to constant variable"**
        console.error(`[代理错误处理 V3] 捕获错误！目标: ${targetUrl || '解析失败'} | 错误类型: ${error.constructor.name} | 错误消息: ${error.message}`);
        console.error(`[代理错误堆栈 V3] ${error.stack}`); // 记录完整的错误堆栈信息

        // 特别标记 "Assignment to constant variable" 错误
        if (error instanceof TypeError && error.message.includes("Assignment to constant variable")) {
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
             console.error("捕获到 'Assignment to constant variable' 错误!");
             console.error("请再次检查函数代码及所有辅助函数中，是否有 const 声明的变量被重新赋值。");
             console.error("错误堆栈指向:", error.stack);
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        }

        // 尝试从错误对象获取状态码，否则默认为 500
        const statusCode = error.status || 500;

        // 确保在发送错误响应前没有发送过响应头
        if (!res.headersSent) {
             res.setHeader('Content-Type', 'application/json');
             // CORS 头应该已经在前面设置好了
             res.status(statusCode).json({
                success: false,
                error: `代理处理错误: ${error.message}`, // 返回错误消息给前端
                targetUrl: targetUrl // 包含目标 URL 以便调试
            });
        } else {
            // 如果响应头已发送，无法再发送 JSON 错误
            console.error("[代理错误处理 V3] 响应头已发送，无法发送 JSON 错误响应。");
            // 尝试结束响应
             if (!res.writableEnded) {
                 res.end();
             }
        }
    } finally {
         // 记录请求处理结束
         console.info('--- Vercel 代理请求结束 ---');
    }
}

// --- [确保所有辅助函数定义都在这里] ---
// getTargetUrlFromPath, getBaseUrl, resolveUrl, rewriteUrlToProxy, getRandomUserAgent,
// fetchContentWithType, isM3u8Content, processKeyLine, processMapLine,
// processMediaPlaylist, processM3u8Content, processMasterPlaylist




