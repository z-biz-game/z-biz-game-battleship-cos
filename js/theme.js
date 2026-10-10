// 颜色、间距、动效的唯一出处。样式表通过 applyThemeVars 把它们读成 CSS 自定义属性，
// 画布直接读同一批对象——所以改一个 token 不可能只改到一边（那是「一片水一种颜色」
// 会长出四十种颜色的原因）。
//
// 这套色板是一块夜海：盘面不是「白纸上画了黑格」，而是「声呐打到黑的地方慢慢回出一点光」。
// 所以底色一路压到接近纯黑，靠亮度分层而不是靠色相分层——玩家盯的是几十格之间哪一格
// 有钢、哪一格确认过没钢，颜色只要抢过一次注意力，后面每一局都要重新学一遍读盘。

export const Palette = {
  bgTop: '#060B16',
  bgBottom: '#0B1A2B',
  surface: '#0D1B2A',
  surfaceLift: '#132639',
  line: '#1E3A52',
  lineHeavy: '#2E5573',
  ink: '#EEF6FB',
  inkDim: 'rgba(238,246,251,0.62)',
  inkFaint: 'rgba(238,246,251,0.34)',

  // 海沫青 = 玩家自己的手：刚点下的那一格、提示点名的那一格、胜利横幅都用它。
  // 它是这块夜海里唯一会「发光」的颜色，所以「这是你正在做的事」在屏幕上只有一种读法。
  accent: '#5FE3C8',
  accentEdge: '#A9F5E4',
  accentSoft: 'rgba(95,227,200,0.14)',

  // 一格只有三种身份，亮度必须能排序：确认过没船的水 < 还没探到的未定格 < 船体钢。
  // 这样即便不靠色相（乃至色盲、乃至手机在阳光下）盘也读得出来。水比未定更暗是刻意的：
  // 没写的格子本来就算水（玩家不必把 49 格都点满），所以画上去的水是一句「断言」——
  // 声呐扫过、确认什么都没有，那是一块吸光的洞，不是留白。
  // 三种底色各配一圈描边、船体再多一个暗面（hullDeep）：它们只负责把格子的边界还给格子，
  // 不承担语义。ripple 是「整片已确认为水」时那圈压低的波纹，比铅笔那笔更实——
  // 它说的是结论，不是想法。
  unlit: '#122437',
  water: '#0A1A24',
  waterEdge: 'rgba(95,227,200,0.18)',
  hull: '#44688C',
  hullEdge: '#A9CBE4',
  hullDeep: '#1C314A',
  ripple: 'rgba(169,203,228,0.55)',

  // 铅笔就是那一笔水波：它盖在任何底色之上（未定格上也要写得出水），所以只用半透明的浅冷色，
  // 比墨水暗、绝不跟 accent 抢亮度——一个记号不该比正在落的子更显眼。
  pencil: 'rgba(210,232,244,0.32)',

  // 状态三色和那支蓝（info/hint/focus）逐字节沿用整条 puzzle 线的固定值：
  // 一格坏了、一行满了、一次提示点名——在哪个仓里都该是同一个颜色：主题可以换，语义不能换。
  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  info: '#7BB8FF',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 档位底色：五档五种，按「海况变差」排——浅湖青 → 深水蓝 → 暮色靛 → 信号紫 → 浮标锈。
  // 色相彼此分得开、亮度留在同一条带上，所以菜单卡片并排时顺序感来自颜色本身，
  // 不用把「初学/大师」那两个字读完。索引固定按档位，同一张盘永远同一套颜色，
  // 浏览器 harness 才敢拿像素当断言。
  tints: ['#1F5D63', '#2A5A7D', '#4A4F80', '#7A4E6B', '#8A4A38'],
  // 一支船全部落位后那一档被抬向白色的量。抬亮度而不换颜色：换成一个铺平的固定色，
  // 五档会在胜利页变成同一种灰，「按颜色记自己卡在哪个难度」这件事当场失效。
  // 图例里那块抬过的样本就是 `tint-0` 套同一个抬升量。
  tintLift: 0.1,
  tintDone: '#4E7F92',
  tintEdge: 'rgba(238,246,251,0.86)',
  tintBad: 'rgba(255,92,122,0.30)',

  // 下面几个只服务于 assets/gen/make_art.py 画出来的位图资产：它们要的是比界面
  // 更极端的端点（海沟与浪花），界面里没人引用。由资产生成脚本补进 Palette，是为了
  // 让「美术用的颜色代码里没有」这件事不可能发生。
  artDeep: '#03060D', // 海沟：图标与纹理里比 bgTop 更暗的那一端，船影的落影也用它
  artFoam: '#D9F5EE', // 浪花白：确认水格上那个点的颜色，比 ink 更冷一点
  artSteel: '#7FA8C9', // 亮钢：上层建筑的高光，比 hullEdge 暗、比 hull 亮
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// 时长守在 150–350ms：比这长的动画会挡住下一步操作。声呐那类「扫一遍」的效果
// 也不能自己动，只能在玩家落下一步之后响一次。
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 一格的像素尺寸区间：盘面最宽 7 格，max 要能在手机宽度上把整排线索数字留得住；
// 船比矩形薄，所以 clueScale 比留白多的游戏收一点，把数字让给水兵的读盘视线。
export const Cell = {
  min: 28,
  max: 64,
  clueScale: 0.42, // 行列线索数字相对一格的边长
  cutScale: 0.3, // 水波标记只跨半格，它是一句话不是一道边界
  noteScale: 0.16,
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    // 数组在下面单独循环，一项一条属性。
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  // 档位色板是数组，所以一档一条属性：图例色块和画布读的是同一个值，而不是各自目测。
  Palette.tints.forEach((c, i) => root.setProperty('--tint-' + i, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// 系统偏好是地板，游戏内的开关只能往上加不能往下减——
// 一个把系统设成「减弱动效」的玩家不该被游戏覆盖掉。
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
