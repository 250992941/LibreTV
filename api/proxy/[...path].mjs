export async function onRequest(context) {
    const url = new URL(context.request.url);
    const targetUrl = decodeURIComponent(url.pathname.replace(/^\/proxy\//, ''));
    
    if (!targetUrl.startsWith('http')) {
        return new Response('Bad URL', { status: 400 });
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://movie.douban.com/'
            }
        });

        // 读取响应体为 ArrayBuffer 以获取详细信息
        const buffer = await response.arrayBuffer();
        
        // 提取诊断信息
        const debugInfo = {
            targetUrl: targetUrl,
            status: response.status,
            contentType: response.headers.get('Content-Type'),
            contentLength: buffer.byteLength,
            // 显示前16个字节的十六进制值（用于判断文件头）
            firstBytesHex: Array.from(new Uint8Array(buffer.slice(0, 16))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            // 尝试将前100个字节解码为文本（如果是错误页面，这里会显示HTML）
            firstBytesText: new TextDecoder().decode(buffer.slice(0, 100))
        };

        // 返回 JSON 格式的诊断信息
        return new Response(JSON.stringify(debugInfo, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
            }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}







