export async function onRequest(context) {
    const url = new URL(context.request.url);
    // 【关键改动】将路径前缀从 /proxy/ 改为 /p2/
    const targetUrl = decodeURIComponent(url.pathname.replace(/^\/p2\//, ''));
    
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

        const buffer = await response.arrayBuffer();
        
        const debugInfo = {
            targetUrl: targetUrl,
            status: response.status,
            contentType: response.headers.get('Content-Type'),
            contentLength: buffer.byteLength,
            firstBytesHex: Array.from(new Uint8Array(buffer.slice(0, 16))).map(b => b.toString(16).padStart(2, '0')).join(' '),
            firstBytesText: new TextDecoder().decode(buffer.slice(0, 100))
        };

        return new Response(JSON.stringify(debugInfo, null, 2), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
            }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
