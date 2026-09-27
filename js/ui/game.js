// 一局海战推演的状态机。这里只管三件事：把玩家的手势变成引擎里的墨、记下这局花了多少、
// 以及在合适的时候问引擎"赢了吗"。
//
// 一条硬规矩：判胜一律走 verify(board, cells)，本文件自己不算胜负。出题那侧的推理机
// (nextDeduction)、独立计数器 (countSolutions) 和这里的 UI 是三份互不信任的实现——
// UI 说"你赢了"而盘面不合法，是这个品类里最糟的 bug，所以它必须由第三个函数说。
//
// 擦格子要记一步。反悔不许白反悔：撤销会把这一步退掉，但提示永远不退（见 undo），
// 否则"连点提示再撤销"就能刷出零提示的最好成绩。

import {
  UNKNOWN,
  SHIP,
  WATER,
  createState,
  setCell,
  cycle,
  markLine,
  undo as undoState,
  nextDeduction,
  applyDeduction,
  diagnose,
  verify,
  remainingFleet,
  dockedShips,
  solveWithRules,
  cellName,
} from '../engine/ships.js';

export const MODES = { ship: SHIP, water: WATER, cycle: UNKNOWN };

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = this.board.w;
    this.h = this.board.h;
    this.st = createState(this.board);
    this.mode = 'ship';
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.lastHint = null;
    this.recompute();
  }

  recompute() {
    this.diag = diagnose(this.st);
    this.rf = remainingFleet(this.board, this.st.cells);
    this.docked = dockedShips(this.board, this.st.cells).ships;
  }

  valueAt(t) {
    return t >= 0 && t < this.board.size ? this.st.cells[t] : -1;
  }

  cellAt(x, y) {
    return this.st.cells[y * this.w + x];
  }

  record(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else if (kind !== 'prune') this.moves++;
  }

  // 一个手势 = 引擎里最多一份快照。空手势（比如把已经全是船的线再刷一遍船）必须既不记步、
  // 也不留快照——而且**只许退掉自己刚推的那一份**：markLine 在没改动时自己会把快照丢掉，
  // 这时再 pop 一次就会把上一个手势的撤销点吃掉，所以这里拿 history 的深度差来判断。
  gesture(kind, { cells, write }) {
    const depth = this.st.history.length;
    const ink0 = inkCount(this.st);
    const res = write(this.st);
    const pushed = this.st.history.length > depth;
    if (inkCount(this.st) === ink0) {
      if (pushed) undoState(this.st);
      return null;
    }
    this.recompute();
    this.checkWin();
    this.record(kind, { cells });
    return { kind, cells, changed: res && res.changed, conflict: this.diag.conflicts > 0, won: this.status === 'won' };
  }

  tap(t) {
    if (t < 0) return null;
    if (this.mode === 'cycle') {
      return this.gesture('cycle', { cells: [t], write: (st) => cycle(st, t) });
    }
    const want = MODES[this.mode];
    // 同一个模式再点一次是擦除：铅笔在纸上点两下，第二下就是把墨去掉。
    const val = this.st.cells[t] === want ? UNKNOWN : want;
    return this.gesture(val === UNKNOWN ? 'erase' : 'paint', { cells: [t], write: (st) => setCell(st, t, val) });
  }

  // 拖过一条线：把手指经过的格子一次性刷成当前模式的墨。
  paint(cells) {
    const list = [...new Set(cells.filter((t) => t >= 0 && t < this.board.size))];
    if (!list.length) return null;
    const want = this.mode === 'cycle' ? SHIP : MODES[this.mode];
    return this.gesture(list.length > 1 ? 'stroke' : 'paint', { cells: list, write: (st) => ({ changed: markLine(st, list, want) }) });
  }

  erase(cells) {
    const list = [...new Set(cells.filter((t) => t >= 0 && t < this.board.size))];
    if (!list.length) return null;
    return this.gesture('erase', { cells: list, write: (st) => ({ changed: markLine(st, list, UNKNOWN) }) });
  }

  // 读档：整盘墨一次灌进来。这里重建状态而不是逐格 setCell——逐格写会把撤销栈灌满，
  // 于是"撤销"能一路退回到存档之前，玩家按一次 undo 就退回空白盘。
  load(cells) {
    this.st = createState(this.board, { cells });
    this.steps = [];
    this.recompute();
    this.checkWin();
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    this.checkWin();
    return step;
  }

  hint() {
    const d = nextDeduction(this.st);
    if (!d) {
      const v = verify(this.board, this.st.cells);
      return { done: v.ok, text: v.ok ? '舰队已经全部落位' : '本地规则推不动了，剩下的要靠更长的线索链' };
    }
    if (d.stalled) {
      return { conflict: true, cells: d.cells, text: d.why };
    }
    applyDeduction(this.st, d);
    this.recompute();
    this.checkWin();
    this.lastHint = { cells: d.cells, rule: d.rule, why: d.why };
    this.record('hint', { cells: d.cells });
    return { cells: d.cells, rule: d.rule, why: d.why, charged: true };
  }

  // 只用规则把这一局推到底：harness 用它对照"推理机能不能独立赢下这局"。
  solveWithLogic({ cap = 4000 } = {}) {
    const st = createState(this.board, { cells: this.st.cells });
    return solveWithRules(st, { cap });
  }

  checkWin() {
    if (verify(this.board, this.st.cells).ok) this.status = 'won';
    else this.status = 'playing';
    return this.status === 'won';
  }

  conflictLine() {
    if (!this.diag.conflicts) return '';
    if (!this.rf.ok) return this.rf.reason;
    const bad = [...this.diag.badCells];
    if (!bad.length) return '有行列的船格数对不上题面';
    return `${bad.slice(0, 3).map((t) => cellName(this.board, t)).join('、')}${bad.length > 3 ? ` 等 ${bad.length} 处` : ''}：${this.diag.badClues.size ? '船格数和题面不符' : '船碰到了船，或船不是直线'}`;
  }

  state() {
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      size: `${this.w}×${this.h}`,
      fleet: this.board.fleet.join('/'),
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      ships: this.diag.ships,
      total: this.board.total,
      water: this.diag.water,
      unknown: this.diag.unknown,
      docked: this.docked.length,
      remaining: this.rf.ok ? this.rf.remaining.slice() : null,
      conflicts: this.diag.conflicts,
      clues: this.diag.clues,
      score: this.puzzle.score,
      drawn: this.puzzle.drawn,
      steps: this.steps.length,
      mode: this.mode,
    };
  }
}

// 墨的总量。空手势的判据就是它没变——比"数改了几个格"稳，因为刷一条已经全是船的线
// 一个格都不会改。
function inkCount(st) {
  let n = 0;
  for (let t = 0; t < st.board.size; t++) if (st.cells[t] !== UNKNOWN) n++;
  return n;
}

export { UNKNOWN, SHIP, WATER };
