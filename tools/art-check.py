#!/usr/bin/env python3
"""资产闸：盘上的位图必须仍然等于生成脚本说它等于的东西。

为什么值得单独有一个脚本，而不是"看一眼就好"：资产是这个仓里唯一**没有编译期**的部分。
js 改坏了 node --check 会红，而把 icon-192 换成一张 0 字节文件、或者改了 theme.js 的
accent 却没重画图标，浏览器里都不会报错——它只会安静地变丑，或者在 iOS 上装不上。
这里五条各管一种"安静地坏掉"：

  1 清单：art-manifest.json 里每一项都在盘上、不是 0 字节、PNG IHDR 与规格逐字相符。
  2 包装：favicon.ico 是真 ICO 容器且每张内嵌图仍是 PNG（不是把 .png 改名成 .ico）。
  3 漂移：manifest 里记下的 palette 指纹必须仍等于 js/theme.js 的 Palette 现值。
  4 接缝：两张可平铺纹理的 wrap 台阶不得明显大于图内部的相邻台阶（平铺会露亮带）。
  5 引用：index.html / manifest.webmanifest 里指向 assets/ 的每个路径都必须真的存在。

用法: python3 tools/art-check.py            # 只读校验
      python3 tools/art-check.py --require-pwa   # 并且要求 PWA 三件套齐备
退出码 0 = 全绿。CI 里跑它。
"""
import json
import os
import re
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MANIFEST = os.path.join(ROOT, 'assets', 'art-manifest.json')
THEME = os.path.join(ROOT, 'js', 'theme.js')
SEAM_SLACK = 1.6   # wrap 台阶允许比内部最大台阶大出的倍数
SEAM_EPS = 6       # 再加一点绝对余量（8bit 上的噪声底）

fails = []
oks = []


def bad(msg):
    fails.append(msg)


def ok(msg):
    oks.append(msg)


def png_ihdr(path):
    with open(path, 'rb') as f:
        head = f.read(33)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', head[16:24])


def check_manifest(spec):
    for rel, want in sorted(spec.items()):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            bad('%s 不在盘上' % rel)
            continue
        size = os.path.getsize(p)
        if size == 0:
            bad('%s 是 0 字节占位' % rel)
            continue
        if rel.endswith('.png'):
            dim = png_ihdr(p)
            if dim is None:
                bad('%s 不是 PNG（签名不对，可能是 SVG 冒充）' % rel)
                continue
            if dim != (want['w'], want['h']):
                bad('%s IHDR %dx%d != 规格 %dx%d' % (rel, dim[0], dim[1], want['w'], want['h']))
                continue
        elif rel.endswith('.ico'):
            with open(p, 'rb') as f:
                head = f.read(22)
            if head[:4] != b'\x00\x00\x01\x00':
                bad('%s 不是 ICO 容器' % rel)
                continue
            n = struct.unpack('<H', head[4:6])[0]
            if n != len(want.get('entries', [])):
                bad('%s 有 %d 张内嵌图，规格说 %d 张' % (rel, n, len(want['entries'])))
                continue
            # 内嵌项必须是 PNG（每个 entry 的宽高与规格一致，且载荷是 PNG 签名）
            for i, s in enumerate(want['entries']):
                with open(p, 'rb') as f:
                    f.seek(6 + 16 * i)
                    e = struct.unpack('<BBBBHHII', f.read(16))
                    if e[0] % 256 != s or e[1] % 256 != s:
                        bad('%s 第 %d 项 %dx%d != %d' % (rel, i, e[0], e[1], s))
                        continue
                    # ICO 目录项：w,h,colors,reserved,planes,bitcount,size,offset 共 16 字节
                    f.seek(e[7])
                    sig = f.read(8)
                    if sig != b'\x89PNG\r\n\x1a\n':
                        bad('%s 第 %d 项不是 PNG 载荷' % (rel, i))
                    elif e[6] < 33:
                        bad('%s 第 %d 项载荷只有 %d 字节' % (rel, i, e[6]))
            ok('%s: ICO 容器 %d 张内嵌 PNG' % (rel, n))
            continue
        ok('%s: %dx%d %dKB' % (rel, want['w'], want['h'], round(size / 1024)))


def theme_palette():
    src = open(THEME, encoding='utf-8').read()
    body = src[src.index('export const Palette'):]
    return {k: v for k, v in re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']+)'", body, re.M)}


def check_palette(recorded):
    now = theme_palette()
    drift = {k: (v, now.get(k)) for k, v in recorded.items() if now.get(k) != v}
    if drift:
        for k, (was, nowv) in sorted(drift.items()):
            bad('theme.js 的 %s 已从 %s 变成 %s，资产没重画（跑 make_art.py）' % (k, was, nowv))
    else:
        ok('palette 指纹 %d 色与 theme.js 一致' % len(recorded))
    # 资产里用到的每个 token 都必须还在主题里
    missing = [k for k in recorded if k not in now]
    for k in missing:
        bad('资产用了主题里已经不存在的颜色 token: %s' % k)


def check_seam(rel):
    from PIL import Image, ImageChops
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return
    a = Image.open(p).convert('RGB')
    w, h = a.size
    def maxdiff(x, y):
        return max(ImageChops.difference(x, y).getextrema()[i][1] for i in range(3))
    wrap_x = maxdiff(a.crop((0, 0, 1, h)), a.crop((w - 1, 0, w, h)))
    wrap_y = maxdiff(a.crop((0, 0, w, 1)), a.crop((0, h - 1, w, h)))
    inner_x = maxdiff(a.crop((w // 2, h // 4, 1 + w // 2, 3 * h // 4)),
                      a.crop((1 + w // 2, h // 4, 2 + w // 2, 3 * h // 4)))
    inner_y = maxdiff(a.crop((w // 4, h // 2, 3 * w // 4, 1 + h // 2)),
                      a.crop((w // 4, 1 + h // 2, 3 * w // 4, 2 + h // 2)))
    limit_x, limit_y = inner_x * SEAM_SLACK + SEAM_EPS, inner_y * SEAM_SLACK + SEAM_EPS
    if wrap_x > limit_x:
        bad('%s 横向接缝露带：wrap=%d > 内部台阶 %d 的上限 %d' % (rel, wrap_x, inner_x, int(limit_x)))
    if wrap_y > limit_y:
        bad('%s 纵向接缝露带：wrap=%d > 内部台阶 %d 的上限 %d' % (rel, wrap_y, inner_y, int(limit_y)))
    ok('%s 平铺接缝 wrap=(%d,%d) 内部台阶=(%d,%d)' % (rel, wrap_x, wrap_y, inner_x, inner_y))


def check_refs(require_pwa):
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    refs = re.findall(r'(?:href|src|content)="([^"]*assets/[^"]+)"', html)
    mf_path = os.path.join(ROOT, 'manifest.webmanifest')
    if os.path.exists(mf_path):
        mf = json.load(open(mf_path, encoding='utf-8'))
        refs += [i.get('src', '') for i in mf.get('icons', [])]
        for field in ('name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color'):
            if not mf.get(field):
                bad('manifest.webmanifest 缺字段 %s' % field)
        bigs = [i for i in mf.get('icons', []) if i.get('sizes', '').startswith(('192', '512'))]
        if len(bigs) < 2:
            bad('manifest 的 icons 里没有 192 与 512 两档')
    elif require_pwa:
        bad('manifest.webmanifest 不存在')
    if require_pwa and not os.path.exists(os.path.join(ROOT, 'sw.js')):
        bad('sw.js 不存在：可安装是空壳')
    if not re.search(r'rel=["\"][^"\"]*apple-touch-icon', html):
        bad('index.html 没有 apple-touch-icon 引用')
    if not re.search(r'rel=["\"][^"\"]*icon["\"][^>]*\.png', html):
        bad('index.html 的 favicon 仍不是真 PNG 引用')
    seen = set()
    for r in refs:
        r = r.split('?')[0]
        if not r or r in seen:
            continue
        seen.add(r)
        rel = r.lstrip('/').replace('./', '')
        if rel.startswith('assets/'):
            if not os.path.exists(os.path.join(ROOT, rel)):
                bad('页面引用了 %s，但盘上没有' % rel)
    ok('引用的 %d 个资产路径全部落在盘上' % len(seen))


def main():
    require_pwa = '--require-pwa' in sys.argv
    if not os.path.exists(MANIFEST):
        print('FAIL: 没有 assets/art-manifest.json，先跑 python3 assets/gen/make_art.py')
        return 1
    m = json.load(open(MANIFEST, encoding='utf-8'))
    check_manifest(m['files'])
    check_palette(m.get('palette', {}))
    for rel in m['files']:
        if rel.startswith('assets/textures/sea-depth'):
            check_seam(rel)
    check_refs(require_pwa)
    for line in oks:
        print('  ok  ' + line)
    for line in fails:
        print('  BAD ' + line)
    print('art-check: %d 项通过, %d 项失败' % (len(oks), len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
