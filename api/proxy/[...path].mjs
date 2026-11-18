export async function onRequest(context) {
    const url = new URL(context.request.url);
    const targetUrl = decodeURIComponent(url.pathname.replace(/^\/proxy\//, ''));
    
    if (!targetUrl.startsWith('http')) {
        return new Response('Bad URL', { status: 400 });
    }

    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://movie.douban.com/'
        }
    });

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    // 【关键修复】强制 Cloudflare 和浏览器不要缓存此响应
    headers.set('Cache-Control', 'no-store, max-age=0');
    
    return new Response(response.body, {
        status: response.status,
        headers: headers
    });
}






