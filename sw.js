// 离线可用 + 不被旧缓存钉死。两条规则互相拉扯，所以这里写得很少但每条都有理由：
//
// 1. **同源全部走"网络优先，失败退缓存"**。手工 VERSION 号配 cache-first 是鬼状态的配方：
//    出了新 HTML 却仍从缓存里拿旧 js，玩家看到的是一半新一半旧的界面，而且刷新不掉。
//    所以这里没有"预缓存清单"这回事——清单永远比代码旧。
// 2. **缓存名带版本号**，activate 时把其它版本整个删掉。它只在"改了这份 sw 自身"时才需要动，
//    因为业务 js/css 的更新由第 1 条负责，不靠换 cache 名。
//
// file:// 下这段根本不会被加载：注册方（js/pwa-register.js）在协议不是 http/https 时直接返回。
const VERSION = 'battleship-v1';
const FALLBACK = './';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  let netError = null;
  try {
    const res = await fetch(req, { cache: 'reload' });
    if (res && res.ok && new URL(res.url).protocol.startsWith('http')) {
      const copy = res.clone();
      // 回填失败不能影响这次响应：断网边缘情况下 quota 满了也要能把内容给出去。
      try {
        const cache = await caches.open(VERSION);
        await cache.put(req, copy);
      } catch {}
      return res;
    }
    // 404/500 不是"网络可用"，也不该被存起来——那会让一个坏路径永久坏下去。
  } catch (e) {
    netError = e;
  }
  const cached = await caches.match(req);
  if (cached) return cached;
  if (req.mode === 'navigate') {
    const shell = await caches.match(FALLBACK);
    if (shell) return shell;
  }
  throw netError || new Error('offline: ' + req.url);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // 跨源不碰：本仓运行时零依赖、零外链，出现跨源请求就说明有人往这里加了第三方。
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;
  e.respondWith(networkFirst(req));
});
