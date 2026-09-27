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
    return { ...base, ...got, settings: { ...base.settings, ...(got.settings || {}) }, totals: { ...base.totals, ...(got.totals || {}) } };
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
  let t = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const v = list[i];
    const n = list[i + 1];
    for (let k = 0; k < n && t < size; k++) cells[t++] = v;
  }
  return cells;
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
    return this.data.resume;
  },

  resumeCells(r) {
    return r ? decodeInk(r.ink, r.cells) : null;
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
