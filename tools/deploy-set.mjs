#!/usr/bin/env node
// 部署集闸：按 pages.yml 用的那份清单真拷一遍产物，然后要求"页面会去要的东西"都在产物里。
//
// 这里防的是一整类本地看不见、CI 也不红的坏法：仓里没有构建步骤，index.html 直读仓库根，
// 所以本地永远自洽；上线的站点却是 tools/assemble-site.sh 拷出来的那一份。清单落后于页面
// （加了 manifest/图标/SW 却忘了加进 cp），线上就是 404，而引擎测试、浏览器闸全都跑的是
// 仓库根，一条都不会红。这个闸跑的是**产物**。
//
// 四类断言，各管一种真实的坏法：
//   A 清单与页面同源：assemble 脚本存在且被 workflow 引用（否则 CI 拷的是另一份清单，
//     本闸验的就不是上线的那份）
//   B 引用可达：从 index.html 出发，沿着**页面自己声明的取径**走一遍——href/src、它 link
//     的每份 CSS 里的 url()、manifest 的 icons/screenshots/shortcuts、它请的每个 script
//     背后的整条 import 图，以及每一站里的运行时路径（new URL / serviceWorker.register /
//     scope / './' 打头的字面量）。逐个必须在产物里存在且非 0 字节。
//   C 不许绝对路径：'/sw.js' 在 Pages 的 /<repo>/ 前缀下会跳出项目站点（同组织已因此红过）
//   D 位图不许说谎：manifest 声明的 sizes 必须等于 PNG IHDR 的真实宽高
//
// 防自己空转：条数钉在 EXPECT_CHECKS，解析不到引用（而不是引用都齐）也是红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSEMBLE = 'tools/assemble-site.sh';
// B 段实际检查的路径条数。改页面/清单会改变它——那正是要它变的时候；没改页面却掉了，
// 说明引用解析不出来的那部分被悄悄放过了。对着 DEPLOY_SET_DUMP=1 的出处表能逐条核。
const EXPECT_CHECKS = 42;
// 全绿时这个闸实际跑的断言条数（A/B/D 三段之和）。钉住它，"少一条断言"就不可能是绿的：
// 删掉 manifest 里的一张图标会同时少一条 B8 与那张的 D1/D2 两行（实测 42/66 → 41/63，见
// 刀架日志的 S7）：那条路径缺文件本来就该红，但 rows 能漂就是闸在缩水的信号，所以两个数
// 一起钉。落差是量出来的，不是推的。
const EXPECT_ROWS = 66;

let rows = 0;
const fails = [];
const ok = (cond, label, detail) => {
  rows += 1;
  if (!cond) fails.push(`${label}${detail ? '  ' + detail : ''}`);
};

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// ---- A：清单与页面同源 ----
const wf = readIf(path.join(ROOT, '.github/workflows/pages.yml'));
ok(wf !== null, 'A1 workflow/pages.yml 读得到', wf === null ? '文件不存在' : '');
if (wf !== null) {
  ok(wf.includes(ASSEMBLE), 'A2 pages.yml 用的是 tools/assemble-site.sh 这份清单',
    'workflow 里没有 ' + ASSEMBLE + '，CI 拷的是另一份清单，本闸验的不是上线那份');
}

// ---- 产物：默认用同一支脚本拷到临时目录；给了目录参数就查那个目录 ----
// CI 传的就是它即将上传的那个 _site——查一份自己重新拷的副本，等于没查上线那份。
const given = process.argv[2];
let site;
let cleanup = false;
if (given) {
  site = path.resolve(given);
  if (!fs.existsSync(path.join(site, 'index.html'))) {
    console.log('FATAL 传进来的产物目录里没有 index.html：' + site);
    console.log('rows: 0');
    process.exit(1);
  }
} else {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'battleship-deploy-set-'));
  cleanup = true;
  try {
    execFileSync('bash', [path.join(ROOT, ASSEMBLE), site], { stdio: 'pipe' });
  } catch (e) {
    console.log('FATAL assemble 失败：' + (e.stderr || e.message).toString().trim());
    console.log('rows: 0');
    process.exit(1);
  }
}

const rel = (p) => p.replace(/^\.\//, '').split('?')[0].split('#')[0];
const present = (r) => {
  const f = path.join(site, r);
  return fs.existsSync(f) && fs.statSync(f).size > 0;
};

// ---- B：引用可达 ----
// 引用不靠手打名单。这一版之前手打过一次（只扫 js/pwa-register.js 与 js/main.js），于是三样
// 浏览器真的会去要的东西全在闸的视野外：js/sw-register.js 注册的 sw.js、js/render/board.js
// 按 import.meta.url 拼的两张纹理、css/game.css 里的 url()。名单漏扫的时侯本闸照样绿——而
// "清单漏拷"正是它要防的那件事。现在只有一个入口：index.html 声明的取径；走多远由取径自己
// 决定——每条引用解析出来是个 .js/.css 就把它也当作一站，模块图于是自己把整条链交出来。
const html = readIf(path.join(ROOT, 'index.html')) || '';
const refs = []; // [出处, 声明串, 这串依附的目录（相对仓根；'' = 文档根，也就是 index.html 所在处）]
const push = (from, spec, at) => {
  const s = String(spec).trim();
  if (s) refs.push([from, s, at || '']);
};

const SKIP = ['data:', 'mailto:', 'blob:', '#', 'http:', 'https:'];
const external = (s) => SKIP.some((p) => s.startsWith(p));

// './x'、'../../assets/x.png' 这种自相对字面量：模块图的边、loadAsset 的纹理名都是这个形状。
// 只在**去掉注释之后**的代码上匹配。上一版在这里多算出一条引用，出处是 js/pwa-register.js
// 的一行注释（// './sw.js' 而不是 '/sw.js'）——散文不是引用：把它算进来，改一句注释就能把
// 钉住的条数顶歪，而下一次顶歪的人看见的 FAIL 跟自己的改动毫无关系。
const SELF_REL = /['"](\.{1,2}\/[^'"\n]+)['"]/g;
// 剩下的是"不带 ./ 的裸文件名"，只能靠调用点认。document.baseURI / serviceWorker.register /
// scope 都以文档为基，所以那几条形成的引用依附在仓根；new URL(x, import.meta.url) 以**本文件**
// 为基（board.js 的注释专门数过相对层数），这一条必须跟着文件走，跟着仓根走就查错了路径。
const CALL_SITES = [
  [/new URL\(\s*['"]([^'"]+)['"]\s*,\s*document\.baseURI/g, false],
  [/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g, true],
  [/navigator\.serviceWorker\.register\(\s*['"]([^'"]+)['"]/g, false],
  [/\bscope:\s*['"]([^'"]+)['"]/g, false],
];

// JS 去行注释与块注释（字符串内部不动，'https://' 里那两个斜杠不是注释）；CSS 只去块注释，
// 因为 url(//host/x) 那种协议相对写法在 CSS 里合法，按 JS 的规则切会把整行吃掉。
const stripComments = (src, blocksOnly) => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (!blocksOnly && c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (!blocksOnly && (c === '"' || c === "'" || c === '`')) {
      const q = c;
      out += c; i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
};

const dirOf = (r) => {
  const d = path.posix.dirname(r);
  return d === '.' ? '' : d;
};
// 目录或纯片段（'./'、'./#resume'）浏览器要的是那份文档本身。以前 rel() 把它们削成 ''，
// present('') 去 stat 产物目录——目录永远在、size 永远 > 0，那两条是假绿，一条也没验。
// 只认"文档根"这一种目录：'foo/' 不许跟着塌成 index.html，S5 那一刀测的就是这里——把
// shortcut 指到一个不存在的子目录时，浏览器要的是 foo/index.html，那就必须去查它。
const resolveSpec = (specRaw, at) => {
  const s = String(specRaw).split('?')[0].split('#')[0];
  if (s === '' || s === '.' || s === './') return 'index.html';
  const joined = at ? path.posix.normalize(path.posix.join(at, s)) : s.replace(/^\.\//, '');
  return joined.endsWith('/') ? joined + 'index.html' : joined;
};

for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) push('index.html', m[1], '');

const mfText = readIf(path.join(ROOT, 'manifest.webmanifest'));
ok(mfText !== null, 'B1 manifest.webmanifest 在仓库根', '');
let mf = null;
if (mfText !== null) {
  try { mf = JSON.parse(mfText); } catch (e) { ok(false, 'B2 manifest 解析得了', String(e.message)); }
}
// manifest 里"带 src 的条目"只有一个收集口径：icons、screenshots、每条 shortcut 自己的
// icons。以前这里手写死了 ['icons','screenshots']，于是 shortcuts 里那两张 96x96 的声明
// 既不查可达也不查尺寸——"扫的名单靠手打"这个坏法在 B 段修了一遍，不该在 manifest 里留着。
const entries = []; // [{from, src, sizes}]
if (mf) {
  for (const k of ['icons', 'screenshots']) {
    for (const i of mf[k] || []) {
      if (!i.src) continue;
      entries.push({ from: 'manifest.' + k, src: String(i.src).trim(), sizes: i.sizes });
    }
  }
  (mf.shortcuts || []).forEach((s, n) => {
    if (s.url) entries.push({ from: `manifest.shortcuts[${n}].url`, src: String(s.url).trim() });
    for (const i of s.icons || []) {
      if (!i.src) continue;
      entries.push({ from: `manifest.shortcuts[${n}].icons`, src: String(i.src).trim(), sizes: i.sizes });
    }
  });
  for (const e of entries) push(e.from, e.src, '');
  // 装不装得上取决于这几个字段在不在，以及 start_url/scope 是不是相对
  const missing = ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color',
    'background_color'].filter((k) => !mf[k]);
  ok(missing.length === 0, 'B3 manifest 七个必填字段都在', '缺 ' + missing.join(','));
  for (const k of ['start_url', 'scope']) {
    if (mf[k]) ok(!String(mf[k]).startsWith('/'), `B4 manifest.${k} 不能是绝对路径`,
      `${k}=${mf[k]} 在 Pages 的 /<repo>/ 前缀下会跳出项目站点`);
  }
  const big = (mf.icons || []).filter((i) => parseInt(String(i.sizes || '0x0'), 10) >= 512);
  ok(big.length > 0, 'B5 manifest 有 >=512 的图标（Chrome 否则不给安装提示）', '');
  // index.html 的注释写着 og:image「与 manifest.webmanifest 里的截图同源」。注释不是闸：
  // 这一条把那句话变成断言，两张图分家的时候就得红，而不是留一句过期的解释在源码里。
  const shots = entries.filter((e) => e.from === 'manifest.screenshots').map((e) => rel(e.src));
  const og = html.match(/property="og:image"\s+content="([^"]+)"/);
  ok(og !== null, 'B11 index.html 里有 og:image', '');
  if (og && shots.length) {
    const v = og[1].trim();
    ok(v.startsWith('https://') && shots.some((p) => v.endsWith('/' + p)),
      'B12 og:image 绝对 URL 且指的就是 manifest 那张截图',
      `og:image=${v}，manifest 截图=${shots.join('/')}`);
  }
}

// 沿取径走：refs 边走边长，所以用下标扫而不是快照。
const scanned = new Set();
for (let k = 0; k < refs.length; k += 1) {
  const [from, spec, at] = refs[k];
  if (external(spec) || spec.startsWith('/')) continue; // 外链跳过；绝对路径由 B7 点名
  const r = resolveSpec(spec, at);
  if (!/\.(js|css)$/.test(r) || scanned.has(r)) continue;
  scanned.add(r);
  const text = readIf(path.join(ROOT, r));
  if (text === null) {
    ok(false, `B6 取径上的 ${r} 在仓库根读不到（读不到=这一站根本没扫）`, '出处 ' + from);
    continue;
  }
  if (r.endsWith('.css')) {
    for (const m of stripComments(text, true).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      push(r, m[1], dirOf(r));
    }
    continue;
  }
  const code = stripComments(text, false);
  for (const m of code.matchAll(SELF_REL)) push(r, m[1], dirOf(r));
  for (const [re, perFile] of CALL_SITES) {
    for (const m of code.matchAll(re)) push(r, m[1], perFile ? dirOf(r) : '');
  }
}

// 钉住的条数要有人能对着源码核：DEPLOY_SET_DUMP=1 把每一条引用连同出处与解析结果打出来。
// 只打不计数，所以开着它跑，rows 与 EXPECT_ROWS 的关系不变。
if (process.env.DEPLOY_SET_DUMP) {
  for (const [from, spec, at] of refs) {
    console.log('ref\t' + from + '\t' + spec + (at ? '\t@' + at : '') + '\t=> ' +
      (external(spec) || spec.startsWith('/') ? '(不查：外链或绝对)' : resolveSpec(spec, at)));
  }
}

let checks = 0;
const counted = new Set();
for (const [from, spec, at] of refs) {
  if (external(spec)) continue;
  if (spec.startsWith('/')) {
    ok(false, `B7 绝对路径 ${spec} 会在 Pages 前缀下跳出站点`, '出处 ' + from);
    continue;
  }
  const r = resolveSpec(spec, at);
  const key = from + ' ' + spec + ' ' + r;
  if (counted.has(key)) continue; // 同一条字面量被两种形式认到（SELF_REL 与调用点），只查一次
  counted.add(key);
  checks += 1;
  ok(present(r), `B8 ${spec} 在部署产物里且非 0 字节`, '出处 ' + from + '，产物缺 ' + r);
}
// 解析不到引用就是闸空转，不是通过
ok(checks > 0, 'B9 至少解析出一条引用（0 条=引用没被读到，不是全都齐）', '实际 ' + checks + ' 条');
ok(checks === EXPECT_CHECKS, `B10 引用条数等于钉在文件里的 EXPECT_CHECKS（${EXPECT_CHECKS}）`,
  '实际 ' + checks + ' 条：改了页面就把 EXPECT_CHECKS 一起改，别让它默默变少');

// ---- D：位图不许说谎 ----
// 口径与 B 段同一份 entries：凡是 manifest 里声明了 sizes 的 PNG，声明值必须等于 IHDR 真实宽高。
// 同一张图被两处声明成同一个尺寸时只核一次（shortcuts 两条都用 icon-96），但缺文件的那条
// 由 B 段点名，这里跳过不重复报。
let bitmaps = 0;
const sized = new Set();
for (const e of entries) {
  if (!e.sizes) continue;
  const r = rel(e.src);
  if (!/\.png$/i.test(r)) continue;
  const key = r + '@' + String(e.sizes);
  if (sized.has(key)) continue;
  sized.add(key);
  bitmaps += 1;
  const f = path.join(site, r);
  if (!fs.existsSync(f)) continue; // B 段已经报过缺文件
  const head = fs.readFileSync(f).subarray(0, 24);
  const isPng = head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  ok(isPng, `D1 ${r} 是真 PNG 容器`, '不是 PNG 签名');
  if (!isPng) continue;
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  const [dw, dh] = String(e.sizes).split('x').map(Number);
  if (dw) ok(w === dw && h === dh, `D2 ${r} 实际 ${w}x${h} 等于声明的 ${e.sizes}`, '出处 ' + e.from);
}

if (cleanup) fs.rmSync(site, { recursive: true, force: true });

// 自计数：闸缩水必须先自己红。比较发生在计数之前，所以这里比的是"含这一条"的总数。
ok(rows + 1 === EXPECT_ROWS, `E1 这一次跑出的断言条数（含这一条）等于钉在文件里的 EXPECT_ROWS（${EXPECT_ROWS}）`,
  '实际 ' + (rows + 1) + ' 条');

for (const f of fails) console.log('  FAIL ' + f);
console.log(`部署集：${checks} 条引用（含 ${bitmaps} 张位图尺寸核对），失败 ${fails.length} 项`);
console.log(`rows: ${rows} fail: ${fails.length}`);
process.exit(fails.length === 0 && rows > 0 ? 0 : 1);
