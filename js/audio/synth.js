// 合成反馈音，不带采样文件。解谜游戏的音效是一块*状态*读数——「写下了一格」「探过一片水」
// 「这一步和线索打架了」「整支舰队回港」，每一条都只是一小段包络，所以用合成器既保得住
// 产物体积，也保得住词汇的诚实。
//
// 这套的声音形象是声呐：除了一对刻意失谐的锯齿（conflict 只负责刺耳），所有声音都是正弦
// 或三角的短促回声，衰减比音高更值得讲究——玩家一局要点上百次，任何一种声音只要稍微刺耳，
// 就会被当成噪声而不是信息。

let ctx = null;
let master = null;
let enabled = true;
// 两个计数器只为了一句可读的话："静音的时候一个节点都没建"。没有读数，这条只能靠
// 眼睛看代码——而"看代码觉得没问题"正是这条判据要防的东西。
let ctxCreated = 0;
let oscCreated = 0;

function audio() {
  // 静音在**建上下文之前**就拦掉：只让 tone() 早退的话，AudioContext 照样被 new 出来、
  // 照样在后台跑（耗电，而且在 iOS 上它还会占用唯一的音频会话，把"静音"变成"憋着"）。
  if (!enabled) return null;
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      ctxCreated += 1;
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 一个振荡器：两点滑音加一段指数衰减。下面所有声音都是对它的一次调用；
// 另起一种声部形状，就是一个游戏开始长出「不属于同一件乐器」的声音的方式。
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  oscCreated += 1;
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  // 静音做的是上下文级的 suspend()，不是"把音量调成 0 然后继续建节点"：前者让音频线程
  // 真的停下来（省电，也释放在 iOS 上那个独占的音频会话），后者只是听不见。
  setEnabled(v) {
    enabled = !!v;
    if (!ctx) return;
    try {
      if (!enabled && ctx.state === 'running') ctx.suspend().catch(() => {});
      else if (enabled && ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch {
      /* 老 WebKit 上这两个方法可能缺席：那也只是 suspend 没发生，声音仍被 tone() 拦住 */
    }
  },
  enabled: () => enabled,

  // 给闸读的一组数。stats().oscillators 在静音期间必须纹丝不动——这一条是"真静音"
  // 和"只是没响"的分界线，而它只能被量出来，不能被读代码读出来。
  stats: () => ({ enabled, context: ctx ? ctx.state : 'none', contexts: ctxCreated, oscillators: oscCreated }),

  // 写船格：一声往下的水滴。滑音向下是刻意的——落子在这盘上不是「敲上去」，
  // 是「投进去」。它和 erase 同方向，靠的是音区：一个在高频尽头，一个贴着低海床。
  paint() {
    tone({ f0: 1180, f1: 520, dur: 0.12, type: 'sine', gain: 0.15 });
  },
  // 一支船确认落位：比 paint 低、比 paint 长，纯五度两个声部。
  // 它是「对了」而不是「我点了」，所以不加任何高频毛刺。
  fleet() {
    tone({ f0: 494, f1: 740, dur: 0.18, type: 'sine', gain: 0.11 });
    tone({ f0: 740, dur: 0.14, type: 'sine', gain: 0.06, delay: 0.05 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // 两个失谐声部：故意难听，为的是「不用看屏幕也知道这一步和线索打架了」。
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  // 四音琶音：舰队一艘一艘回港。换成纯正弦，让尾巴听上去像回声而不是琴键。
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.3, type: 'sine', gain: 0.16, delay: i * 0.09 }));
  },
};
