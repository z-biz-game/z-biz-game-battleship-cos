// 服务工作者注册。它刻意**不**是 js/main.js 的一部分：SW 要越早开始接管越好，而 main.js
// 是一整条 ESM 依赖图（引擎 + 渲染 + 存档），任何一处抛错都不该连累"离线还能打开"。
//
// 三条边界，每一条都对应一种真实会炸的场景：
//   file:// —— Electron 的打包形态和"直接双击 index.html"都走这里。那个协议下
//     navigator.serviceWorker 是 undefined，而且注册会抛 SecurityError；不判就是白屏控制台。
//   本地 http 但非安全上下文 —— http://127.0.0.1 是安全上下文（tools/verify.sh 靠它跑浏览器闸），
//     而 http://<局域网IP> 不是：那种情况下干脆不注册，也别把异常抛出去。
//   任何一步失败 —— 静默。PWA 是增益，不是玩法的前提。
(function () {
  'use strict';
  try {
    var proto = location.protocol;
    if (proto !== 'http:' && proto !== 'https:') return;
    if (!window.isSecureContext) return;
    if (!('serviceWorker' in navigator)) return;
    // './sw.js' 而不是 '/sw.js'：Pages 把这个仓发在 /z-biz-game-battleship-cos/ 之下，
    // 绝对路径会去站点根目录要一个不存在的 sw.js（同组织已经因此红过一次）。
    var url = new URL('sw.js', document.baseURI).href;
    navigator.serviceWorker.register(url, { scope: new URL('./', document.baseURI).pathname }).catch(function () {});
  } catch (e) {
    /* 见上：注册失败不影响这一局能不能玩 */
  }
})();
