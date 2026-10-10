// 存档。这里面刻意不存盘面：题面是 seed 抽出来的，只要攒下 seed + 档位，重新打开时
// makePuzzle 会画出**同一张**盘（generate.js 全程只用种子，不看 Date 也不看 Math.random）。
// 盘上存的只有三样东西：这一局走到哪（墨）、这一局花了多少（moves/hints/elapsedMs）、
// 以及历史最好成绩（best）。
//
// 花销必须原样存着。反悔不返还是这个品类的规矩：擦掉一格再重新画，是两笔花费而不是一笔，
// 否则"画错—擦掉—重画"可以无限刷步数。

const KEY = 'battleship.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false, showRipple: true },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const got = JSON.parse(raw);
    const base = defaults();
    const save = { ...base, ...got, settings: { ...base.settings, ...(got.settings || {}) }, totals: { ...base.totals, ...(got.totals || {}) } };
    // 第一段解码（JSON.parse）过了不代表内容可用：坏的那一条单独扔，其余原样留着。
    if (!validResume(save.resume)) save.resume = null;
    return save;
  } catch {
    return defaults();
  }
}

// 游程编码：一盘 49 格里绝大多数是"连续的同一种状态"，直存 JSON 数组会把 localStorage
// 当成日志本用。存成 [值, 次数] 的扁平序列，读的时候还原成 Uint8Array。
function encodeInk(cells) {
  const out = [];
  let run = cells[0];
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === run) n++;
    else {
      out.push(run, n);
      run = cells[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function decodeInk(list, size) {
  const cells = new Uint8Array(size);
  if (!Array.isArray(list)) return cells;
  let t = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const v = list[i];
    const n = list[i + 1];
    for (let k = 0; k < n && t < size; k++) cells[t++] = v;
  }
  return cells;
}

// 坏记录要能认出来，而且只能丢它那一条。localStorage 是玩家自己碰得到的地盘：手改一个数、
// 别的扩展写坏一次、上一版格式没写完——这几种情况下正确的行为都是"这一局恢复不了"，
// 而不是"整份存档清空"（成绩和设置是无辜的），更不是"begin() 抛异常"（那是白屏）。
// 所以这里查的是**结构**而不是取值范围之外的偏好：seed/tier 得是字符串、cells 得是
// 盘大小的整数、ink 得是成对的游程且总长刚好等于 cells、花费不能是负数。
function validResume(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (typeof r.seed !== 'string' || !r.seed) return false;
  if (typeof r.tier !== 'string' || !r.tier) return false;
  if (!Number.isInteger(r.cells) || r.cells <= 0 || r.cells > 4096) return false;
  if (!Array.isArray(r.ink) || r.ink.length % 2 !== 0) return false;
  let covered = 0;
  for (let i = 0; i < r.ink.length; i += 2) {
    const v = r.ink[i];
    const n = r.ink[i + 1];
    if (!Number.isInteger(v) || v < 0 || v > 255) return false;
    if (!Number.isInteger(n) || n <= 0) return false;
    covered += n;
    if (covered > r.cells) return false;
  }
  // 游程总长必须刚好铺满盘面：多了上面就拒了，少了说明这盘少了一截墨，
  // 恢复出来的是一张和 seed 对不上的图——那比"没有存档"坏得多。
  if (covered !== r.cells) return false;
  if (!Number.isInteger(r.moves) || r.moves < 0) return false;
  if (!Number.isInteger(r.hints) || r.hints < 0) return false;
  if (typeof r.elapsedMs !== 'number' || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) return false;
  return true;
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // 隐私模式或配额满了：这一局照样能玩，只是成绩留不下来。
    }
  },

  setting(name) {
    return this.data.settings[name];
  },

  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier];
  },

  // 排行先看提示数，再看步数，最后才是时间：这游戏奖励的是推理，不是手速。
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better = !cur || hints < cur.hints || (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    this.data.totals.solved += 1;
    this.data.totals.hints += hints;
    this.data.totals.ms += ms;
    this.save();
  },

  saveResume(puzzle, game, elapsedMs) {
    this.data.resume = {
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.board.size,
      ink: encodeInk(game.st.cells),
      moves: game.moves,
      hints: game.hints,
      mode: game.mode,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    return validResume(this.data.resume) ? this.data.resume : null;
  },

  // 解码前要再过一次结构检查：load() 那道是在模块求值时跑的，而在这之前谁也可能
  // 直接往 Store.data 里塞一条（测试就是这么构造坏记录的）。new Uint8Array(undefined)
  // 不抛错，它给一张 0 格的盘——那比抛错更难查。
  resumeCells(r) {
    return validResume(r) ? decodeInk(r.ink, r.cells) : null;
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 同上 */
    }
  },
};
