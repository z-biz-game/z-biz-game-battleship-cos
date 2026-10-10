#!/usr/bin/env python3
"""海战推演的视觉母题工厂：一条命令重画出本仓全部位图资产。

母题 = **夜海声呐**。玩法是"声呐扫过夜海，把确认过的东西画出来"，所以图形语汇直接照它抄：
深度渐变的黑海、一圈圈衰减的声呐环、一道转过去的扫掠扇形、落在推理格上的俯视舰体剪影。
不取外部素材、不联网、不留 SVG 中间态——PIL 只做绘制与重采样，每个形状都由参数算出来。

三件不该由写手手画的事：

1. **颜色不是编的**。每个色值都从 js/theme.js 的 Palette 按 key 读出（缺的先补进 Palette，
   见 ensure_theme）。改了主题色就重跑本脚本，图标和纹理跟着换；assets/art-manifest.json
   里存着本次用到的 palette 指纹，tools/art-check.py 拿它和 theme.js 对账。
2. **纹理可平铺**。sea-depth 的高度场是若干个"波数整除边长"的正弦之和，所以任何一边平移
   一格都接得上——CSS 的 repeat 和画布的 createPattern 才敢直接拿它当无缝底。
3. **每条边都算出来**。母图按 SS=2 超采样绘制再 LANCZOS 降回目标尺寸，所以 16px 的
   favicon 里声呐环与舰体轮廓仍是"一条船"，而不是一坨抗锯齿噪声。

用法:  python3 assets/gen/make_art.py          # 重画全部资产
       python3 assets/gen/make_art.py --check  # 只校验盘上资产与 art-manifest.json 一致
"""
import io
import json
import math
import os
import random
import re
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
THEME_PATH = os.path.join(ROOT, 'js', 'theme.js')

MASTER = 1024
SS = 2
ICON_SIZES = [1024, 512, 192, 180, 96, 64, 48, 32, 16]
MASKABLE_SIZES = [512, 192]
TEX = 512
OG = (1200, 630)
BANNER = (1200, 320)

# 资产要用、而界面暂时用不到的三个端点：纯黑海沟、浪花白、亮钢。
# 它们必须先成为主题的一部分，才能成为资产的一部分（见 ensure_theme）。
REQUIRED = [
    ('artDeep', '#03060D', '海沟：图标与纹理里比 bgTop 更暗的那一端，船影的落影也用它'),
    ('artFoam', '#D9F5EE', '浪花白：确认水格上那个点的颜色，比 ink 更冷一点'),
    ('artSteel', '#7FA8C9', '亮钢：上层建筑的高光，比 hullEdge 暗、比 hull 亮'),
]


def read_theme():
    src = open(THEME_PATH, encoding='utf-8').read()
    body = src[src.index('export const Palette'):]
    # Palette 里既有 '#RRGGBB' 也有 'rgba(...)'：两种都是颜色，资产两种都要用（见 to_rgb）。
    # tints 那一行的值前面是 `[` 而不是引号，所以这条正则不会把它当成一个 token 收进来。
    return {k: v for k, v in re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']+)'", body, re.M)}


def ensure_theme():
    """把资产需要的色补进 theme.js 的 Palette。幂等：已存在就一个字都不改。"""
    src = open(THEME_PATH, encoding='utf-8').read()
    have = read_theme()
    add = [(k, v, note) for k, v, note in REQUIRED if k not in have]
    if not add:
        return False
    anchor = "  tintBad: 'rgba(255,92,122,0.30)',\n"
    if anchor not in src:
        raise SystemExit('theme.js 的结构变了（找不到 tintBad 这一行），先看清 Palette 再补色')
    block = ('\n  // 下面几个只服务于 assets/gen/make_art.py 画出来的位图资产：它们要的是比界面\n'
             '  // 更极端的端点（海沟与浪花），界面里没人引用。由资产生成脚本补进 Palette，是为了\n'
             '  // 让「美术用的颜色代码里没有」这件事不可能发生。\n')
    for k, v, note in add:
        block += "  %s: '%s', // %s\n" % (k, v, note)
    src = src.replace(anchor, anchor + block)
    open(THEME_PATH, 'w', encoding='utf-8').write(src)
    return True


def rgb(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgba(h, a):
    """两种写法都收：见 to_rgb。资产里凡是引用 theme token 的地方都不该知道它是哪种格式。"""
    return to_rgb(h) + (max(0, min(255, int(round(a * 255)))),)


def to_rgb(h):
    """theme.js 里一半 token 是十六进制、一半是 rgba() 字符串。资产只认前者能表达的
    那部分颜色，所以这里把两种写法统一成 (r,g,b)——alpha 由调用方给。"""
    h = h.strip()
    if h.startswith('#'):
        return rgb(h)
    m = re.match(r'rgba?\(([^)]+)\)', h)
    if not m:
        raise SystemExit('theme.js 里看不懂的颜色值: %r' % h)
    parts = m.group(1).split(',')
    return (int(parts[0]), int(parts[1]), int(parts[2]))


def col(pal, key, a=1.0):
    return to_rgb(pal[key]) + (max(0, min(255, int(round(a * 255)))),)


def mixc(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


def scale(px, w, h):
    """笔画宽度按图的短边取，这样超采样画布和最终画布上的线一样粗。"""
    return max(1, int(round(px * min(w, h))))


# ---- 底：夜海深度场 ---------------------------------------------------------------------

def soft_disc(w, h, cx, cy, radius, blur=0.28):
    """一张 L 模式软边圆蒙版：中心实心、向外高斯衰减。逐像素算要几秒，这个只要几毫秒。"""
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    r = radius * (1 + blur)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(radius * blur))
    return m


def vertical_ramp(w, h, stops):
    """分段竖向渐变：stops = [(位置, (r,g,b)), ...]。按行算一次再拉伸，不走逐像素。"""
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if t <= p1:
                k = 0 if p1 == p0 else max(0.0, min(1.0, (t - p0) / (p1 - p0)))
                px[0, y] = tuple(int(round(mixc(c0, c1, k)[i2])) for i2 in range(3))
                break
        else:
            px[0, y] = tuple(int(round(v)) for v in stops[-1][1])
    return strip.resize((w, h), Image.BILINEAR).convert('RGBA')


def fog(w, h, seed, power=0.055, cells=7):
    """低频海雾：一个小尺寸随机图放大到目标尺寸。同 seed 必然同一张图。"""
    rr = random.Random(seed)
    n = max(2, cells)
    tiny = Image.new('L', (n, n))
    tiny.putdata([int(rr.random() * 255) for _ in range(n * n)])
    big = tiny.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(min(w, h) / n * 0.6))
    return big.point(lambda v: int(128 + (v - 128) * (power * 255 / 40)))


def depth_field(w, h, pal, seed):
    base = vertical_ramp(w, h, [(0.0, rgb(pal['bgTop'])),
                                (0.55, rgb(pal['bgBottom'])),
                                (1.0, rgb(pal['artDeep']))])
    glow = soft_disc(w, h, w * 0.30, h * 0.74, min(w, h) * 0.85, blur=0.45)
    lift = vertical_ramp(w, h, [(0.0, rgb(pal['bgBottom'])), (1.0, rgb(pal['surfaceLift']))])
    out = Image.composite(lift, base, glow.point(lambda v: int(v * 0.45)))
    return Image.composite(fog_tint(pal, w, h, seed), out, fog(w, h, seed)).convert('RGBA')


def fog_tint(pal, w, h, seed):
    """雾不是灰：把它染成极淡的靛蓝，避免整幅画在暗部发灰。"""
    c = rgb(pal['surface'])
    im = Image.new('RGB', (w, h), c)
    return im.convert('RGBA')


# ---- 母题层 -----------------------------------------------------------------------------

def contours(w, h, pal, cx, cy, seed, rings=9):
    """等深线：被两组正弦扰动的同心闭合曲线。它是"海图"这件事最省字的说法。"""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = min(w, h)
    rr = random.Random(seed + 11)
    for k in range(rings):
        r0 = s * (0.11 + 0.105 * k)
        amp = s * 0.020 * (1 + k * 0.22)
        ph = rr.uniform(0, math.tau)
        pts = []
        for i in range(160):
            a = i / 160 * math.tau
            r = r0 + amp * (0.7 * math.sin(a * 3 + ph) + 0.4 * math.sin(a * 5 - ph * 1.7))
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a) * 0.86))
        d.line(pts + [pts[0]], fill=rgba(pal['line'], max(0.08, 0.46 - k * 0.042)),
               width=max(1, int(s * 0.0022)), joint='curve')
    return im


def sonar_rings(w, h, pal, cx, cy, radii):
    """声呐环：等间隔、越外越淡，最里面那圈最亮——那声"叮"就是从这儿发出去的。"""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = min(w, h)
    n = len(radii)
    for i, r in enumerate(radii):
        t = i / max(1, n - 1)
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  outline=rgba(pal['accent'], 0.60 * (1 - t) ** 1.5 + 0.05),
                  width=max(1, int(s * (0.0055 - 0.0030 * t))))
    p = s * 0.013
    d.ellipse([cx - p, cy - p, cx + p, cy + p], fill=rgba(pal['accentEdge'], 0.92))
    return im


def sonar_sweep(w, h, pal, cx, cy, r_max, heading, spread, alpha_peak=0.30):
    """扫掠扇形：从 heading 往回拖一条越来越淡的尾巴，前沿是一条亮线。"""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = min(w, h)
    steps = 150
    for i in range(steps):
        t = i / steps
        a = heading - spread * (1 - t)
        d.line([cx, cy, cx + r_max * math.cos(a), cy + r_max * math.sin(a)],
               fill=rgba(pal['accent'], alpha_peak * t ** 2.2),
               width=max(1, int(s * (0.004 + 0.016 * t))))
    d.line([cx, cy, cx + r_max * math.cos(heading), cy + r_max * math.sin(heading)],
           fill=rgba(pal['accentEdge'], 0.80), width=max(2, int(s * 0.007)))
    return im


def grid_plate(w, h, pal, box, cols, rows):
    """推理格：一块压在夜海上的浅盘。它必须是方的——游戏盘就是方的，斜的读不出"第几格"。"""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = min(w, h)
    x0, y0, x1, y1 = box
    gw, gh = x1 - x0, y1 - y0
    d.rounded_rectangle([x0, y0, x1, y1], radius=s * 0.020,
                        fill=rgba(pal['surface'], 0.66),
                        outline=rgba(pal['lineHeavy'], 0.95), width=max(2, int(s * 0.005)))
    for i in range(cols + 1):
        x = x0 + gw * i / cols
        d.line([x, y0, x, y1], fill=rgba(pal['line'], 0.9), width=max(1, int(s * 0.0020)))
    for j in range(rows + 1):
        y = y0 + gh * j / rows
        d.line([x0, y, x1, y], fill=rgba(pal['line'], 0.9), width=max(1, int(s * 0.0020)))
    return im


def hull_polygon(w, h, pal, cx, cy, length, beam, angle, cells=4):
    """俯视舰体：尖艏、平行中段、收拢的艉，加两座上层建筑。

    只画一条船的轮廓是没用的——这盘上要读的是"一条船占了哪几格"，所以沿船长切出分段线。
    那几道刻痕是整个母题里唯一一句解释玩法的话。
    """
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    s = min(w, h)
    L, B = length, beam
    bow, stern = 0.30 * L, 0.18 * L
    body = [(-L / 2 + stern, -B / 2), (L / 2 - bow, -B / 2), (L / 2, 0),
            (L / 2 - bow, B / 2), (-L / 2 + stern, B / 2), (-L / 2, B * 0.24), (-L / 2, -B * 0.24)]
    ca, sa = math.cos(angle), math.sin(angle)

    def rot(p):
        return (cx + p[0] * ca - p[1] * sa, cy + p[0] * sa + p[1] * ca)

    # 吃水线：船体外面垫一圈更暗的钢并往下压一点，船才"压"在海面上而不是一张贴纸
    d.polygon([rot((p[0] * 1.03, p[1] + B * 0.16)) for p in body], fill=rgba(pal['artDeep'], 0.62))
    d.polygon([rot(p) for p in body], fill=rgba(pal['hull'], 1.0), outline=rgba(pal['hullEdge'], 0.95))
    deck = [rot((-L / 2 + stern, -B * 0.17)), rot((L / 2 - bow * 0.8, -B * 0.17)),
            rot((L / 2 - bow * 0.8, B * 0.17)), rot((-L / 2 + stern, B * 0.17))]
    d.polygon(deck, fill=rgba(pal['hullDeep'], 0.9))
    for ox, oy, sw, sh in [(L * 0.15, 0, B * 0.46, B * 0.60), (-L * 0.13, 0, B * 0.32, B * 0.38)]:
        x, y = rot((ox, oy))
        d.rounded_rectangle([x - sw / 2, y - sh / 2, x + sw / 2, y + sh / 2],
                            radius=min(sw, sh) * 0.28, fill=rgba(pal['artSteel'], 0.9),
                            outline=rgba(pal['ink'], 0.30), width=max(1, int(s * 0.0016)))
    seg0, seg1 = -L / 2 + stern, L / 2 - bow
    for i in range(1, cells):
        x = seg0 + (seg1 - seg0) * i / cells
        d.line([rot((x, -B * 0.46)), rot((x, B * 0.46))], fill=rgba(pal['ink'], 0.38),
               width=max(1, int(s * 0.0030)))
    bx, by = rot((L / 2 - bow * 0.45, 0))
    p = B * 0.11
    d.ellipse([bx - p, by - p, bx + p, by + p], fill=rgba(pal['accent'], 0.95))
    return im


def water_marks(w, h, pal, cell, ox, oy, cols, marks):
    """已确认为水的格子：一个压得很低的点——"扫过了，什么都没有"是一句结论不是一道边界。"""
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for t in marks:
        r, c = divmod(t, cols)
        x, y = ox + c * cell + cell / 2, oy + r * cell + cell / 2
        p = cell * 0.075
        d.ellipse([x - p, y - p, x + p, y + p], fill=rgba(pal['artFoam'], 0.34))
    return im


def sheen(w, h, pal, seed, strength=0.085):
    """一道斜向玻璃反光 + 四周压暗：让图标像一块面板，而不是一张纯色贴纸。"""
    rr = random.Random(seed + 3)
    band = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(band)
    for x in range(w):
        v = int(255 * math.exp(-((x - w * 0.30) / (w * 0.17)) ** 2))
        d.line([x, 0, x, h], fill=v)
    band = band.rotate(rr.uniform(-16, 16), resample=Image.BICUBIC)
    hi = Image.new('RGBA', (w, h), rgb(pal['ink']) + (0,))
    hi.putalpha(band.point(lambda v: int(v * strength)))
    vig = soft_disc(w, h, w / 2, h / 2, min(w, h) * 0.80, blur=0.55).point(lambda v: 255 - v)
    dark = Image.new('RGBA', (w, h), rgb(pal['artDeep']) + (255,))
    dark.putalpha(vig.point(lambda v: int(v * 0.42)))
    return Image.alpha_composite(hi, dark)


def squircle_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


# ---- 图标母图 ---------------------------------------------------------------------------

def compose_icon(size, pal, seed, maskable=False):
    """构图：一块 5×5 的推理盘占满画面，船严格落在格子里，声呐场在盘子底下透出来。

    第一版把船画在盘子外面、扫掠线横穿整张图，结果 512px 下像两片树叶压在一条斜线上——
    图标要的是"一眼读出这是摆船解谜"，所以船必须和格子对齐（船头正好抵着格线），
    而扫掠只能待在盘子下面：它是背景，不是主角。
    """
    ss = size * SS
    art = depth_field(ss, ss, pal, seed)
    cx = cy = ss / 2
    art = Image.alpha_composite(art, contours(ss, ss, pal, ss * 0.30, ss * 0.78, seed, rings=7))
    art = Image.alpha_composite(art, sonar_sweep(ss, ss, pal, cx, cy, ss * 0.62,
                                                 math.radians(-38), math.radians(70), 0.15))
    art = Image.alpha_composite(art, sonar_rings(ss, ss, pal, cx, cy,
                                                 [ss * (0.155 + 0.115 * k) for k in range(7)]))
    # 盘子：0.17–0.83，五格。船按格摆放，所以 cell 是整套构图唯一的度量单位。
    cell = ss * 0.132
    x0 = y0 = (ss - cell * 5) / 2
    art = Image.alpha_composite(art, grid_plate(ss, ss, pal, (x0, y0, x0 + cell * 5, y0 + cell * 5), 5, 5))
    art = Image.alpha_composite(art, hull_polygon(ss, ss, pal, x0 + cell * 2.5, y0 + cell * 1.5,
                                                  cell * 3.86, cell * 0.66, 0.0, cells=4))
    art = Image.alpha_composite(art, hull_polygon(ss, ss, pal, x0 + cell * 4.0, y0 + cell * 3.5,
                                                  cell * 1.86, cell * 0.62, math.radians(90), cells=2))
    art = Image.alpha_composite(art, water_marks(ss, ss, pal, cell, x0, y0, 5,
                                                 [0, 4, 10, 14, 20, 5, 22]))
    art = Image.alpha_composite(art, sheen(ss, ss, pal, seed))
    if maskable:
        # maskable 的安全区是 80%：主体缩小后垫在纯色底盘上，系统怎么裁都裁不到船
        inner = art.resize((int(ss * 0.78), int(ss * 0.78)), Image.LANCZOS)
        blank = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
        blank.paste(inner, ((ss - inner.size[0]) // 2, (ss - inner.size[1]) // 2), inner)
        out = Image.new('RGBA', (ss, ss), rgb(pal['bgTop']) + (255,))
        art = Image.alpha_composite(out, blank)
        radius = 0
    else:
        radius = ss * 0.215
    if radius:
        final = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
        final.paste(art, (0, 0), squircle_mask(ss, radius))
        art = final
    return art.resize((size, size), Image.LANCZOS)


# ---- 纹理与位图 -------------------------------------------------------------------------

def sea_texture(size, pal, seed):
    """无缝海底纹理：高度场 = 波数整除 size 的正弦之和，所以横竖两个方向平移一格都接得上。

    刻意**不**把竖向渐变烤进纹理：页面和画布各自已经有深度渐变了，纹理只负责"海的质地"。
    一旦这里放进 j 相关的项，它在 Y 方向就接不上，CSS 平铺会露出一条横向亮带（第一版就是
    这样，四张拼起来中间一道台阶）。tools/art-check.py 拿 wrap 差值守着这一条。
    """
    base = rgb(pal['bgTop'])
    lift, deep = rgb(pal['surfaceLift']), rgb(pal['artDeep'])
    accent = rgb(pal['accent'])
    rr = random.Random(seed + 5)
    waves = []
    for _ in range(8):
        nx = rr.choice([-3, -2, -1, 1, 2, 3])
        ny = rr.choice([-3, -2, -1, 1, 2, 3])
        if rr.random() < 0.4:
            nx, ny = ny, -nx
        waves.append((nx, ny, rr.uniform(0.6, 1.6), rr.uniform(0, math.tau)))
    norm = 0.5 / sum(a for _, _, a, _ in waves)
    tau_over = math.tau / size
    out = bytearray(size * size * 4)
    # 每行预存竖向相位，内层循环只剩一次二维正弦求和
    rows = [[(nx, ny * yy + ph, amp) for (nx, ny, amp, ph) in waves] for yy in
            (j * tau_over for j in range(size))]
    for j in range(size):
        off_row = j * size * 4
        rj = rows[j]
        for i in range(size):
            xi = i * tau_over
            hsum = 0.0
            for (nx, phase, amp) in rj:
                hsum += amp * math.sin(nx * xi + phase)
            h = hsum * norm + 0.5
            band = (h * 11) % 1.0
            edge = max(0.0, 1.0 - abs(band - 0.5) * 14) ** 2 * 0.28
            nz = (((i * 2654435761) ^ (j * 40503)) & 0xFFFF) / 65535 - 0.5
            c = mixc(mixc(base, deep, (1 - h) * 0.55), lift, h * 0.62)
            c = mixc(c, accent, edge * 0.30)
            o = off_row + i * 4
            for k in range(3):
                out[o + k] = max(0, min(255, int(c[k] + nz * (6 + k * 1.5))))
            out[o + 3] = 255
    return Image.frombytes('RGBA', (size, size), bytes(out))


def sweep_sprite(size, pal, seed):
    """声呐扫掠贴图：一张 88° 的亮带扇形，中心透明。画的时候整张旋转就行。"""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size / 2
    r = size / 2 - 2
    steps, span = 210, math.radians(88)
    for i in range(steps):
        t = i / steps
        a = -span * (1 - t)
        d.line([c, c, c + r * math.cos(a), c + r * math.sin(a)],
               fill=rgba(pal['accent'], 0.52 * t ** 2.6),
               width=max(1, int(size * (0.004 + 0.020 * t))))
    d.line([c, c, c + r, c], fill=rgba(pal['accentEdge'], 0.80), width=max(2, int(size * 0.008)))
    for k in (0.34, 0.62, 0.90):
        d.ellipse([c - size * k / 2, c - size * k / 2, c + size * k / 2, c + size * k / 2],
                  outline=rgba(pal['accent'], 0.14), width=max(1, int(size * 0.004)))
    return im


def load_font(size, bold=False):
    cands = (['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
              '/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Supplemental/PingFang.ttc']
             if bold else
             ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Light.ttc',
              '/System/Library/Fonts/HelveticaNeue.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf'])
    for p in cands:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()


MINI = {(1, 0): 'ship', (2, 0): 'ship', (3, 0): 'ship', (0, 0): 'water', (4, 0): 'water',
        (0, 1): 'water', (1, 1): 'water', (2, 1): 'water', (3, 1): 'water', (4, 1): 'water'}


def og_card(pal, seed):
    """社交卡 1200×630：左边是母题本尊，右边给标题、玩法一句话和一条迷你推理盘。"""
    W, H = OG
    ss = 2
    art = depth_field(W * ss, H * ss, pal, seed)
    ox, oy = W * ss * 0.20, H * ss * 0.70
    art = Image.alpha_composite(art, contours(W * ss, H * ss, pal, ox, oy, seed, rings=6))
    art = Image.alpha_composite(art, sonar_sweep(W * ss, H * ss, pal, ox, oy, H * ss * 1.3,
                                                 math.radians(-26), math.radians(66), 0.26))
    art = Image.alpha_composite(art, sonar_rings(W * ss, H * ss, pal, ox, oy,
                                                 [H * ss * (0.18 + 0.16 * k) for k in range(5)]))
    art = Image.alpha_composite(art, hull_polygon(W * ss, H * ss, pal, W * ss * 0.24, H * ss * 0.40,
                                                  H * ss * 0.30, H * ss * 0.075, math.radians(-18), cells=4))
    art = art.resize((W, H), Image.LANCZOS).convert('RGBA')
    art = Image.alpha_composite(art, sheen(W, H, pal, seed, strength=0.05))
    d = ImageDraw.Draw(art)
    ink, dim = rgb(pal['ink']), col(pal, 'inkDim', 0.94)
    x0, y0 = 640, 128
    d.text((x0, y0), 'ZERO-GUESS FLEET DEDUCTION', font=load_font(19, True), fill=rgba(pal['accent'], 1))
    d.text((x0, y0 + 40), '海战推演', font=load_font(70, True), fill=ink)
    d.text((x0, y0 + 138), 'Battleship Solitaire', font=load_font(26), fill=dim)
    d.text((x0, y0 + 190), '行与列的船格数已经给出，舰队长度已经给出。', font=load_font(23), fill=dim)
    d.text((x0, y0 + 226), '船与船连对角都不许碰——剩下的全是推理。', font=load_font(23), fill=dim)
    d.text((x0, y0 + 286), '每一局唯一解 · 难度是量出来的', font=load_font(21, True), fill=rgba(pal['info'], 1))
    cell = 38
    gx, gy = 700, 486
    for (i, j), v in MINI.items():
        rect = [gx + i * cell, gy + j * cell, gx + (i + 1) * cell - 3, gy + (j + 1) * cell - 3]
        fillc = rgba(pal['hull'], 1) if v == 'ship' else rgba(pal['water'], 1) if v == 'water' else rgba(pal['unlit'], 1)
        d.rounded_rectangle(rect, radius=4, fill=fillc, outline=rgba(pal['line'], 1), width=1)
        if v == 'water':
            cx, cy = gx + i * cell + cell / 2, gy + j * cell + cell / 2
            d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=rgba(pal['ripple'], 1))
    d.text((gx - 34, gy + 12), '3', font=load_font(24, True), fill=ink)
    d.text((gx + 40, gy - 34), '1  0  3  0  1', font=load_font(17), fill=dim)
    return art


def menu_banner(pal, seed):
    """菜单页那条 1200×320 的海平线：远端一条船压在声呐场下。"""
    W, H = BANNER
    ss = 2
    art = depth_field(W * ss, H * ss, pal, seed)
    d = ImageDraw.Draw(art)
    horizon = H * ss * 0.60
    for k in range(4):
        y = horizon + k * H * ss * 0.10
        pts = [(x, y + H * ss * 0.022 * math.sin(x / (W * ss) * math.tau * 3 + k * 1.3))
               for x in range(0, W * ss, 16)]
        d.line(pts, fill=rgba(pal['line'], max(0.12, 0.42 - k * 0.09)), width=max(1, int(W * ss * 0.0007)))
    art = Image.alpha_composite(art, sonar_rings(W * ss, H * ss, pal, W * ss * 0.15, horizon,
                                                 [W * ss * (0.020 + 0.022 * k) for k in range(9)]))
    art = Image.alpha_composite(art, hull_polygon(W * ss, H * ss, pal, W * ss * 0.72, horizon - H * ss * 0.03,
                                                  W * ss * 0.115, W * ss * 0.024, math.radians(-5), cells=4))
    art = Image.alpha_composite(art, hull_polygon(W * ss, H * ss, pal, W * ss * 0.34, horizon + H * ss * 0.16,
                                                  W * ss * 0.19, W * ss * 0.038, math.radians(4), cells=5))
    return art.resize((W, H), Image.LANCZOS).convert('RGBA')


# ---- 落盘 -----------------------------------------------------------------------------

SPEC = {}


def save(img, rel):
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p, 'PNG', optimize=True)
    SPEC[rel] = {'w': img.size[0], 'h': img.size[1], 'bytes': os.path.getsize(p)}


def write_ico(sizes, master):
    """真 favicon.ico：PNG 形式的 ico 容器，一张里装 16/32/48。"""
    rel = 'assets/icons/favicon.ico'
    p = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    hdr = struct.pack('<HHH', 0, 1, len(sizes))
    dir_, body = b'', b''
    for s in sizes:
        buf = io.BytesIO()
        master.resize((s, s), Image.LANCZOS).save(buf, 'PNG')
        raw = buf.getvalue()
        dir_ += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(raw),
                            6 + 16 * len(sizes) + len(body))
        body += raw
    open(p, 'wb').write(hdr + dir_ + body)
    SPEC[rel] = {'w': sizes[-1], 'h': sizes[-1], 'bytes': os.path.getsize(p), 'entries': sizes}


def build():
    before = set(read_theme())
    ensure_theme()
    pal = read_theme()
    added = sorted(set(pal) - before)
    if added:
        print('theme.js Palette 补进资产端点: %s' % ' '.join(added))
    seed = sum(ord(c) for c in 'night-sea-sonar')
    master = compose_icon(MASTER, pal, seed)
    for s in ICON_SIZES:
        save(master if s == 1024 else master.resize((s, s), Image.LANCZOS), 'assets/icons/icon-%d.png' % s)
    save(master.resize((180, 180), Image.LANCZOS), 'assets/icons/apple-touch-icon.png')
    maskable = compose_icon(MASTER, pal, seed, maskable=True)
    for s in MASKABLE_SIZES:
        save(maskable.resize((s, s), Image.LANCZOS), 'assets/icons/icon-maskable-%d.png' % s)
    write_ico([16, 32, 48], master)
    save(sea_texture(TEX, pal, seed), 'assets/textures/sea-depth.png')
    save(sea_texture(256, pal, seed), 'assets/textures/sea-depth-256.png')
    save(sweep_sprite(TEX, pal, seed), 'assets/textures/sonar-sweep.png')
    save(og_card(pal, seed), 'assets/img/og-cover.png')
    save(menu_banner(pal, seed), 'assets/img/menu-hero.png')
    manifest = {
        'generated_by': 'assets/gen/make_art.py',
        'motif': 'night-sea-sonar',
        'palette_source': 'js/theme.js:Palette',
        'palette': {k: v for k, v in sorted(pal.items())},
        'files': {k: SPEC[k] for k in sorted(SPEC)},
    }
    with open(os.path.join(ROOT, 'assets', 'art-manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False, sort_keys=True)
        f.write('\n')
    return manifest


def check():
    mf = os.path.join(ROOT, 'assets', 'art-manifest.json')
    if not os.path.exists(mf):
        print('NO MANIFEST — 先跑 python3 assets/gen/make_art.py')
        return 1
    spec = json.load(open(mf, encoding='utf-8'))['files']
    bad = []
    for rel, want in sorted(spec.items()):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            bad.append('%s 不在盘上' % rel)
            continue
        size = os.path.getsize(p)
        if size == 0:
            bad.append('%s 是 0 字节' % rel)
            continue
        with open(p, 'rb') as f:
            head = f.read(33)
        if rel.endswith('.png'):
            if head[:8] != b'\x89PNG\r\n\x1a\n':
                bad.append('%s 不是 PNG' % rel)
                continue
            w, hh = struct.unpack('>II', head[16:24])
            if (w, hh) != (want['w'], want['h']):
                bad.append('%s IHDR %dx%d != 规格 %dx%d' % (rel, w, hh, want['w'], want['h']))
            kind = 'PNG %dx%d' % (w, hh)
        elif rel.endswith('.ico'):
            if head[:4] != b'\x00\x00\x01\x00':
                bad.append('%s 不是 ICO' % rel)
            kind = 'ICO %d entries' % struct.unpack('<H', head[4:6])[0]
        else:
            kind = '?'
        print('  ok  %-44s %-16s %dKB' % (rel, kind, round(size / 1024)))
    for b in bad:
        print('  BAD ' + b)
    return 1 if bad else 0


if __name__ == '__main__':
    if '--check' in sys.argv:
        raise SystemExit(check())
    m = build()
    print('motif=%s  palette=%d 色  文件=%d' % (m['motif'], len(m['palette']), len(m['files'])))
    for rel, v in sorted(m['files'].items()):
        print('  %-44s %sx%-5s %dKB' % (rel, v['w'], v['h'], round(v['bytes'] / 1024)))
