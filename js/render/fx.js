// 盘面上的"活"的那部分：一条声呐扫掠、一次提示的余辉、胜利时推开的一圈波。
//
// 为什么单独一个文件，而不是散在 main.js 里：这一小块是**仿真**，它必须能被"喂固定的
// 虚拟时长"复现。三档帧率（30/60/120Hz）喂同样多的秒数，每个字段读数必须一样——这条
// 性质只有当状态全部由 `x += v*dt` 与 `age` 的解析式决定时才成立。写进 main.js 就没人
// 会去对拍它，也就一定会退化回 `*= 0.92` 那种只在 60Hz 成立的写法。
//
// 两条刻意的选择：
//   · 衰减一律写成"年龄的解析式"（exp(-k*age)），而不是"每帧乘一个系数"。前者对任意
//     帧率同解，后者换个刷新率就是另一局游戏。
//   · 概率一律不出现。这里没有任何 Math.random()：扫掠的相位、波的半径都是确定函数，
//     所以"同一虚拟时长 ⇒ 同一状态"不是概率性的"差不多"，而是逐位相等。

// 扫掠角速度：弧度/秒。一圈 2π 要 7.5 秒——比一次读盘久，比一局短，所以它是背景而不是节目。
const SWEEP_RATE = Math.PI * 2 / 7.5;
// 提示余辉的寿命与衰减常数：150ms 内基本满亮度，之后按指数落下去。
const PULSE_LIFE = 0.9;
const PULSE_DECAY = 3.4;
// 胜利波纹：每秒推开的像素数（相对格子边长的倍数，所以手机上和桌面上一样快）。
const RIPPLE_SPEED = 2.15;
const RIPPLE_LIFE = 1.25;

export const FX = {
  clock: 0,
  sweep: 0,
  pulseAge: -1,
  pulseCells: [],
  pulseKind: 'ship',
  ripples: [],
  enabled: true,

  reset() {
    // 换一局：所有会自己动的东西归零。sweep 不归零而是留在原地——它是这块海的物理属性，
    // 不是这一局的进度；但 clock 必须归零，否则余辉的年龄会跨局延续（上一局的提示还在淡出，
    // 新一局第一笔就叠在一个错误的 alpha 上）。
    this.clock = 0;
    this.ripples = [];
    this.clear();
  },

  // 只撤掉提示的余辉，不动别的：撤销一步、重开一笔，都不该把背景扫掠拨回原点。
  clear() {
    this.pulseAge = -1;
    this.pulseCells = [];
    this.pulseKind = 'ship';
  },

  // 提示点名：把余辉的年龄清零，而不是记一个"开始时间戳"——年龄和 dt 积分同阶，
  // 拿 Date.now() 就会让这段动画跟着墙钟跑，暂停时它还在淡。
  //
  // 减弱动效时它**不是**被关掉，而是退化成一张静图：亮着、不淡出，等下一个动作换掉它。
  // 余辉在这里承担的是信息（"这一批格子是这条点名的"），把动画拿掉不该把信息也拿掉。
  flash(cells, kind) {
    this.pulseCells = cells || [];
    this.pulseKind = kind || 'ship';
    this.pulseAge = this.enabled ? 0 : -1;
  },

  ripple() {
    if (!this.enabled) return;
    this.ripples.push({ age: 0 });
  },

  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) {
      // 关掉的是"自己动"的东西：扫掠停在原地、波纹撤掉、余辉不再淡出（见 flash）。
      this.pulseAge = -1;
      this.ripples = [];
    }
  },

  update(dt) {
    if (!this.enabled) return;
    if (!(dt > 0)) return;
    this.clock += dt;
    this.sweep += SWEEP_RATE * dt;
    if (this.sweep > Math.PI * 2) this.sweep -= Math.PI * 2;
    if (this.pulseAge >= 0) {
      this.pulseAge += dt;
      if (this.pulseAge > PULSE_LIFE) {
        this.pulseAge = -1;
        this.pulseCells = [];
      }
    }
    for (const r of this.ripples) r.age += dt;
    if (this.ripples.length) this.ripples = this.ripples.filter((r) => r.age < RIPPLE_LIFE);
  },

  // 以下三个都是纯函数：读状态不需要跑仿真，所以 harness 可以在任意时刻取值。
  pulseAlpha() {
    if (this.pulseAge >= 0) return Math.exp(-PULSE_DECAY * Math.max(0, this.pulseAge - 0.15));
    // 年龄没在走而格子还在：只可能是减弱动效的那张静图。
    return this.pulseCells.length ? 1 : 0;
  },

  pulseDone() {
    return this.pulseAge < 0;
  },

  rippleRings() {
    // 半径按格子边长度量，所以同一个 age 在 28px 的盘和 64px 的盘上推开的"格数"一样。
    return this.ripples.map((r) => ({ cells: r.age * RIPPLE_SPEED, t: r.age / RIPPLE_LIFE }));
  },

  state() {
    return {
      clock: this.clock,
      sweep: this.sweep,
      pulseAge: this.pulseAge,
      pulseAlpha: this.pulseAlpha(),
      pulseCells: this.pulseCells.length,
      ripples: this.ripples.length,
      rippleAges: this.ripples.map((r) => r.age),
      enabled: this.enabled,
    };
  },
};

export const FX_TIMING = { SWEEP_RATE, PULSE_LIFE, PULSE_DECAY, RIPPLE_SPEED, RIPPLE_LIFE };
