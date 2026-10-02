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
//   B 引用可达：index.html 的 href/src、manifest 的 icons/screenshots/shortcuts、js 里
//     new URL('sw.js', document.baseURI) 那类运行时路径，逐个必须在产物里存在且非 0 字节
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
// 说明引用解析不出来的那部分被悄悄放过了。
const EXPECT_CHECKS = 18;
// 全绿时这个闸实际跑的断言条数（A/B/D 三段之和）。钉住它，"少一条断言"就不可能是绿的：
// 阴性对照里删掉一张图标会让 D 段跳过那张的尺寸核对，rows 从 35 掉到 33——那条路径缺文件
// 本来就该红，但 rows 能漂就是闸在缩水的信号，所以两个数一起钉。
const EXPECT_ROWS = 36;

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
const html = readIf(path.join(ROOT, 'index.html')) || '';
const refs = [];
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) refs.push(['index.html', m[1]]);

const mfText = readIf(path.join(ROOT, 'manifest.webmanifest'));
ok(mfText !== null, 'B1 manifest.webmanifest 在仓库根', '');
let mf = null;
if (mfText !== null) {
  try { mf = JSON.parse(mfText); } catch (e) { ok(false, 'B2 manifest 解析得了', String(e.message)); }
}
if (mf) {
  for (const k of ['icons', 'screenshots']) {
    for (const i of mf[k] || []) if (i.src) refs.push(['manifest.' + k, i.src]);
  }
  for (const s of mf.shortcuts || []) if (s.url) refs.push(['manifest.shortcuts', s.url]);
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
}

// 运行时才拼出来的路径：SW 是 js/pwa-register.js 用 new URL('sw.js', document.baseURI) 注册的，
// HTML 里搜不到它——上一轮线上 404 的就是这一个，只盯 href/src 的检查看不见。
for (const f of ['js/pwa-register.js', 'js/main.js']) {
  const src = readIf(path.join(ROOT, f));
  if (src === null) { ok(false, `B6 ${f} 读得到`, ''); continue; }
  for (const m of src.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,/g)) refs.push([f, m[1]]);
  for (const m of src.matchAll(/['"](\.\/sw\.js)['"]/g)) refs.push([f, m[1]]);
}

let checks = 0;
for (const [from, specRaw] of refs) {
  const spec = specRaw.trim();
  if (!spec || ['data:', 'mailto:', 'blob:', '#', 'http:', 'https:'].some((p) => spec.startsWith(p))) continue;
  checks += 1;
  if (spec.startsWith('/')) {
    ok(false, `B7 绝对路径 ${spec} 会在 Pages 前缀下跳出站点`, '出处 ' + from);
    continue;
  }
  ok(present(rel(spec)), `B8 ${spec} 在部署产物里且非 0 字节`, '出处 ' + from + '，产物缺 ' + rel(spec));
}
// 解析不到引用就是闸空转，不是通过
ok(checks > 0, 'B9 至少解析出一条引用（0 条=引用没被读到，不是全都齐）', '实际 ' + checks + ' 条');
ok(checks === EXPECT_CHECKS, `B10 引用条数等于钉在文件里的 EXPECT_CHECKS（${EXPECT_CHECKS}）`,
  '实际 ' + checks + ' 条：改了页面就把 EXPECT_CHECKS 一起改，别让它默默变少');

// ---- D：位图不许说谎 ----
let bitmaps = 0;
if (mf) {
  for (const i of mf.icons || []) {
    if (!i.src) continue;
    const r = rel(i.src);
    if (!/\.(png)$/.test(r)) continue;
    bitmaps += 1;
    const f = path.join(site, r);
    if (!fs.existsSync(f)) continue; // B 段已经报过缺文件
    const head = fs.readFileSync(f).subarray(0, 24);
    const isPng = head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    ok(isPng, `D1 ${r} 是真 PNG 容器`, '不是 PNG 签名');
    if (!isPng) continue;
    const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
    const [dw, dh] = String(i.sizes || '').split('x').map(Number);
    if (dw) ok(w === dw && h === dh, `D2 ${r} 实际 ${w}x${h} 等于 manifest 声明的 ${i.sizes}`, '');
  }
}

if (cleanup) fs.rmSync(site, { recursive: true, force: true });

// 自计数：闸缩水必须先自己红。比较发生在计数之前，所以这里比的是"含这一条"的总数。
ok(rows + 1 === EXPECT_ROWS, `E1 这一次跑出的断言条数（含这一条）等于钉在文件里的 EXPECT_ROWS（${EXPECT_ROWS}）`,
  '实际 ' + (rows + 1) + ' 条');

for (const f of fails) console.log('  FAIL ' + f);
console.log(`部署集：${checks} 条引用（含 ${bitmaps} 张位图尺寸核对），失败 ${fails.length} 项`);
console.log(`rows: ${rows} fail: ${fails.length}`);
process.exit(fails.length === 0 && rows > 0 ? 0 : 1);
