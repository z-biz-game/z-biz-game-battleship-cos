// 海战棋 Battleship 的规则内核。
//
// 盘是 w×h。舰队长度是给定的（例如 4,3,2,2,1），每艘船是一条**直线**的连续船格，横竖都行；
// 船与船之间连对角都不能碰。盘外的数字是"这一行/列里有几个船格"——注意它数的是**格子**，
// 不是船的数量，数船的是另一款玩法（Fleet/数连），这里刻意不混。
//
// 和摩天楼那类"往格里填数"的盘相比，这里的推理对象是"剩下的船还能摆在哪"。所以内核的主干是：
//   1. 从盘面回收已经落定的船（两端都被水或边界封死、四邻干净，才算一艘落好的船）；
//   2. 拿剩下的舰队长度去试所有合法摆法；
//   3. 摆法集直接给出最硬的两条铅笔规则——一格都盖不到的地方必是水，唯一摆法当场落子。
// 这三步都是玩家说得出话的推理，不是求解器私下的动作。
//
// `verify` 依然只用规则本身判胜（逐格数船格、拆船、查接触、比舰队多重集），不读候选、不读摆法表，
// 这样推理器写坏了也伪造不出一场胜利。

export const UNKNOWN = 0;
export const SHIP = 1;
export const WATER = 2;

export const CELL_NAME = { [UNKNOWN]: '未定', [SHIP]: '船格', [WATER]: '水格' };

const ORTHO = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const DIAG = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
const AHEAD = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export function createBoard({ w, h, fleet, rows, cols }) {
  if (!(w >= 4 && w <= 10) || !(h >= 4 && h <= 10)) throw new Error('盘面边长只能在 4..10');
  if (!Array.isArray(fleet) || !fleet.length) throw new Error('舰队是空的');
  const len = fleet.map((s) => {
    if (!Number.isInteger(s) || s < 1 || s > Math.max(w, h)) throw new Error(`船长 ${s} 放不下`);
    return s;
  });
  const total = len.reduce((a, s) => a + s, 0);
  if (total > w * h) throw new Error('舰队比盘还大');
  const normRows = Array.from({ length: h }, (_, i) => (rows && rows[i] != null ? rows[i] : -1));
  const normCols = Array.from({ length: w }, (_, i) => (cols && cols[i] != null ? cols[i] : -1));
  for (const [k, v] of normRows.entries()) if (v < -1 || v > w) throw new Error(`行线索 ${k} = ${v} 非法`);
  for (const [k, v] of normCols.entries()) if (v < -1 || v > h) throw new Error(`列线索 ${k} = ${v} 非法`);
  if (total > normRows.reduce((a, v) => a + (v >= 0 ? v : w), 0)) throw new Error('线索上限容不下舰队');
  return {
    w,
    h,
    size: w * h,
    fleet: len.slice().sort((a, b) => b - a),
    rows: normRows,
    cols: normCols,
    total,
  };
}

export const at = (board, r, c) => (r < 0 || c < 0 || r >= board.h || c >= board.w ? -1 : r * board.w + c);
export const inBoard = (board, r, c) => r >= 0 && c >= 0 && r < board.h && c < board.w;

export function createState(board, { cells = null } = {}) {
  return {
    board,
    cells: cells ? Uint8Array.from(cells) : new Uint8Array(board.size),
    history: [],
  };
}

export function snapshot(st) {
  st.history.push(Uint8Array.from(st.cells));
  if (st.history.length > 800) st.history.shift();
}

export function dropSnapshot(st) {
  st.history.pop();
}

export function undo(st) {
  const s = st.history.pop();
  if (!s) return false;
  st.cells = s;
  return true;
}

export function setCell(st, t, v) {
  if (t < 0 || t >= st.board.size) return { ok: false, reason: '不在盘上' };
  if (st.cells[t] === v) return { ok: true, changed: false, cell: t, value: v };
  snapshot(st);
  st.cells[t] = v;
  return { ok: true, changed: true, cell: t, value: v };
}

// 翻转一格：未定 → 船格 → 水格 → 未定。单击一次只走一步，玩家误触能一格一格退回来。
export function cycle(st, t) {
  if (t < 0 || t >= st.board.size) return { ok: false, reason: '不在盘上' };
  const next = (st.cells[t] + 1) % 3;
  return setCell(st, t, next);
}

export function markLine(st, cells, v) {
  let changed = 0;
  snapshot(st);
  for (const t of cells) {
    if (st.cells[t] !== v) {
      st.cells[t] = v;
      changed++;
    }
  }
  if (!changed) dropSnapshot(st);
  return changed;
}

// ---- 从盘面回收船只 ------------------------------------------------------------------
//
// 一段连续的船格只有在**轴向两端都被水或边界封死**、且垂直方向紧邻的格子都不是船格时，
// 才算已经落好的一艘船。没封死的段是"还可能在伸长"的，不能提前占用舰队名额——
// 提前占用会把剩下的摆法算少，然后整盘被误判成矛盾。

export function runsOf(board, cells) {
  const horizontal = [];
  const vertical = [];
  for (let r = 0; r < board.h; r++) {
    let c = 0;
    while (c < board.w) {
      if (cells[at(board, r, c)] !== SHIP) {
        c++;
        continue;
      }
      let e = c;
      while (e + 1 < board.w && cells[at(board, r, e + 1)] === SHIP) e++;
      horizontal.push({ r, c0: c, c1: e, len: e - c + 1 });
      c = e + 1;
    }
  }
  for (let c = 0; c < board.w; c++) {
    let r = 0;
    while (r < board.h) {
      if (cells[at(board, r, c)] !== SHIP) {
        r++;
        continue;
      }
      let e = r;
      while (e + 1 < board.h && cells[at(board, e + 1, c)] === SHIP) e++;
      vertical.push({ c, r0: r, r1: e, len: e - r + 1 });
      r = e + 1;
    }
  }
  return { horizontal, vertical };
}

// 把段摊平到每一格上，是为了让"这一格属于哪条船"能一眼查出来：横段长 ≥2 归横船，竖段长 ≥2
// 归竖船，两者都长 ≥2 就是十字交叉（非法），两边都只有它自己则是 1 号小艇。
export function shipMap(board, runs) {
  const hLen = new Int8Array(board.size);
  const vLen = new Int8Array(board.size);
  for (const s of runs.horizontal) for (let c = s.c0; c <= s.c1; c++) hLen[at(board, s.r, c)] = s.len;
  for (const s of runs.vertical) for (let r = s.r0; r <= s.r1; r++) vLen[at(board, r, s.c)] = s.len;

  const bad = new Set();
  for (let t = 0; t < board.size; t++) if (hLen[t] >= 2 && vLen[t] >= 2) bad.add(t);

  const ships = [];
  const singles = [];
  for (const s of runs.horizontal) {
    if (s.len === 1) {
      const t = at(board, s.r, s.c0);
      if (vLen[t] === 1 && !bad.has(t)) singles.push({ len: 1, axis: 'single', cells: [t] });
      continue;
    }
    if (bad.has(at(board, s.r, s.c0))) continue;
    ships.push({ len: s.len, axis: 'h', cells: Array.from({ length: s.len }, (_, k) => at(board, s.r, s.c0 + k)) });
  }
  for (const s of runs.vertical) {
    if (s.len === 1) continue;
    if (bad.has(at(board, s.r0, s.c))) continue;
    ships.push({ len: s.len, axis: 'v', cells: Array.from({ length: s.len }, (_, k) => at(board, s.r0 + k, s.c)) });
  }
  return { ships, singles, bad, hLen, vLen };
}

// 封死的段才占用舰队名额。
export function dockedShips(board, cells) {
  const runs = runsOf(board, cells);
  const blocked = (r, c) => !inBoard(board, r, c) || cells[at(board, r, c)] === WATER;
  const out = [];
  for (const s of runs.horizontal) {
    if (s.len === 1) continue;
    if (!(blocked(s.r, s.c0 - 1) && blocked(s.r, s.c1 + 1))) continue;
    let clean = true;
    for (let c = s.c0 - 1; c <= s.c1 + 1 && clean; c++) {
      for (const dr of [-1, 1]) if (inBoard(board, s.r + dr, c) && cells[at(board, s.r + dr, c)] === SHIP) clean = false;
    }
    if (clean) out.push({ len: s.len, axis: 'h', cells: Array.from({ length: s.len }, (_, k) => at(board, s.r, s.c0 + k)) });
  }
  for (const s of runs.vertical) {
    if (s.len === 1) continue;
    if (!(blocked(s.r0 - 1, s.c) && blocked(s.r1 + 1, s.c))) continue;
    let clean = true;
    for (let r = s.r0 - 1; r <= s.r1 + 1 && clean; r++) {
      for (const dc of [-1, 1]) if (inBoard(board, r, s.c + dc) && cells[at(board, r, s.c + dc)] === SHIP) clean = false;
    }
    if (clean) out.push({ len: s.len, axis: 'v', cells: Array.from({ length: s.len }, (_, k) => at(board, s.r0 + k, s.c)) });
  }
  // 1 号小艇：四个轴向邻格都被封死，它就再也长不大，名额可以扣了。
  for (const s of runs.horizontal) {
    if (s.len !== 1) continue;
    if (!(blocked(s.r, s.c0 - 1) && blocked(s.r, s.c0 + 1) && blocked(s.r - 1, s.c0) && blocked(s.r + 1, s.c0))) continue;
    out.push({ len: 1, axis: 'single', cells: [at(board, s.r, s.c0)] });
  }
  return { ships: out, runs };
}

// ---- 剩下的船还能摆在哪 --------------------------------------------------------------

export function remainingFleet(board, cells) {
  const { ships } = dockedShips(board, cells);
  const pool = board.fleet.slice();
  const leftover = [];
  for (const s of ships) {
    const k = pool.indexOf(s.len);
    if (k < 0) return { ok: false, reason: `盘上有一段 ${s.len} 格长的船，舰队里没有这个长度`, ships };
    pool.splice(k, 1);
  }
  const used = ships.reduce((a, s) => a + s.len, 0);
  const shipCells = cells.reduce((a, v) => a + (v === SHIP ? 1 : 0), 0);
  if (shipCells > used) {
    // 有段还没封死：它的格子已经占了盘面，但名额还没定，剩下的舰队必须至少够它继续长。
    const growing = shipCells - used;
    const room = pool.reduce((a, s) => a + s, 0);
    if (growing > room) return { ok: false, reason: '没封死的船段比剩下的舰队还长', ships };
  }
  return { ok: true, remaining: pool, ships, shipCells, used };
}

// 一根线上、给定剩余船长，所有合法的横放/竖放位置。约束一次写全：段内不能有船以外的水格、
// 段两端与垂直一侧都不能是船格（落子后这些位置都要变水）、行/列船格数不能超。
function placementsFor(board, cells, lengths) {
  const sizes = [...new Set(lengths)];
  const horizontal = [];
  const vertical = [];
  for (let r = 0; r < board.h; r++) {
    for (let c = 0; c < board.w; c++) {
      for (const s of sizes) {
        if (c + s > board.w) continue;
        if (fitsHorizontal(board, cells, r, c, s)) horizontal.push({ axis: 'h', len: s, r, c, cells: Array.from({ length: s }, (_, k) => at(board, r, c + k)) });
      }
    }
  }
  for (let c = 0; c < board.w; c++) {
    for (let r = 0; r < board.h; r++) {
      for (const s of sizes) {
        // 1 号船没有方向可言：只记横的那一个摆法，否则同一格被当成两个候选，
        // "唯一船位"就再也不成立了。
        if (s === 1) continue;
        if (r + s > board.h) continue;
        if (fitsVertical(board, cells, c, r, s)) vertical.push({ axis: 'v', len: s, c, r, cells: Array.from({ length: s }, (_, k) => at(board, r + k, c)) });
      }
    }
  }
  return [...horizontal, ...vertical];
}

// 一段船位合不合法。要点是**允许盖在已经写下的船格上**：一条船经常被前面的规则
// 先写出其中一格，如果摆法只认全空的段，那条船就"再也放不下了"，于是它剩下的格会被
// 无处落船判成水——把正解抹掉。所以段的格子里 SHIP 也算通过，只有 WATER 不行；
// 而线索那一头要按"这一段还会新增几格"来算，不能按段长算，否则双计又误杀。
// 两端和垂直一侧不许已有船格：这两条挡住的是"把两段不同的船粘成一条"。
function fitsHorizontal(board, cells, r, c, s) {
  const need = board.rows[r];
  let have = 0;
  for (let k = 0; k < board.w; k++) if (cells[at(board, r, k)] === SHIP) have++;
  let extra = 0;
  for (let k = 0; k < s; k++) {
    const v = cells[at(board, r, c + k)];
    if (v === WATER) return false;
    if (v === UNKNOWN) extra++;
  }
  if (need >= 0 && have + extra > need) return false;
  if (inBoard(board, r, c - 1) && cells[at(board, r, c - 1)] === SHIP) return false;
  if (inBoard(board, r, c + s) && cells[at(board, r, c + s)] === SHIP) return false;
  for (let k = c - 1; k <= c + s; k++) {
    for (const dr of [-1, 1]) {
      if (!inBoard(board, r + dr, k)) continue;
      if (cells[at(board, r + dr, k)] === SHIP) return false;
    }
  }
  for (let k = 0; k < s; k++) {
    const cc = c + k;
    const cn = board.cols[cc];
    if (cn < 0 || cells[at(board, r, cc)] === SHIP) continue;
    let colHave = 0;
    for (let rr = 0; rr < board.h; rr++) if (cells[at(board, rr, cc)] === SHIP) colHave++;
    if (colHave + 1 > cn) return false;
  }
  return true;
}

function fitsVertical(board, cells, c, r, s) {
  const need = board.cols[c];
  let have = 0;
  for (let k = 0; k < board.h; k++) if (cells[at(board, k, c)] === SHIP) have++;
  let extra = 0;
  for (let k = 0; k < s; k++) {
    const v = cells[at(board, r + k, c)];
    if (v === WATER) return false;
    if (v === UNKNOWN) extra++;
  }
  if (need >= 0 && have + extra > need) return false;
  if (inBoard(board, r - 1, c) && cells[at(board, r - 1, c)] === SHIP) return false;
  if (inBoard(board, r + s, c) && cells[at(board, r + s, c)] === SHIP) return false;
  for (let k = r - 1; k <= r + s; k++) {
    for (const dc of [-1, 1]) {
      if (!inBoard(board, k, c + dc)) continue;
      if (cells[at(board, k, c + dc)] === SHIP) return false;
    }
  }
  for (let k = 0; k < s; k++) {
    const rr = r + k;
    const rn = board.rows[rr];
    if (rn < 0 || cells[at(board, rr, c)] === SHIP) continue;
    let rowHave = 0;
    for (let cc = 0; cc < board.w; cc++) if (cells[at(board, rr, cc)] === SHIP) rowHave++;
    if (rowHave + 1 > rn) return false;
  }
  return true;
}

// ---- 规则 ----------------------------------------------------------------------------

export const RULES = {
  contact: { key: 'contact', name: '邻格即水', weight: 1.0, note: '船与船连对角都不能碰' },
  full: { key: 'full', name: '满额即水', weight: 1.2, note: '这一行/列的船格数已经数满了' },
  exact: { key: 'exact', name: '差额占满', weight: 1.8, note: '还差的船格恰好只剩这么多位置' },
  line: { key: 'line', name: '线内排法', weight: 2.2, note: '这一行剩下的船格只有这几种排法，取交集' },
  nowhere: { key: 'nowhere', name: '无处落船', weight: 2.8, note: '剩下的船没有一种摆法盖到这里' },
  sole: { key: 'sole', name: '唯一船位', weight: 3.8, note: '这艘船只剩一个地方放得下' },
  nishio: { key: 'nishio', name: '反证', weight: 6.0, note: '假设一下，剩下的舰队就摆不完' },
};

export const RULE_ORDER = ['contact', 'full', 'exact', 'line', 'nowhere', 'sole', 'nishio'];

// 一根线（行或列）上，题面要 k 个船格、还差 k 个、空格有 f 个：把这 k 个格子的所有放法枚举出来。
// 每种放法只过三条"真实解必然满足"的检验——正因为只是必要条件，放法集合是真实解的超集，
// 取交集落子才是安全的（这条规则写坏了会误杀，但不会误判出船）。
//   * 线内长度 >1 的船段，长度必须是舰队列里的一个长度：横躺在这条线上的船整条都在，
//     而竖着穿过这条线的船只会留下 1 格，所以长度 1 不设限；
//   * 同一长度出现的段数不能超过舰队里同长度的船数（一条船只能贡献一段）；
//   * 新落的船格在垂直方向（含斜角）上不能贴到已经落好的船。
// 放法太多（超过 cap）就整条规则跳过——宁可少推一步，不做近似判断。
export function lineStates(board, cells, axis, i, { cap = 2048 } = {}) {
  const need = axis === 'h' ? board.rows[i] : board.cols[i];
  if (need < 0) return null;
  const line = lineCells(board, axis, i);
  let have = 0;
  const free = [];
  for (const t of line) {
    if (cells[t] === SHIP) have++;
    else if (cells[t] === UNKNOWN) free.push(t);
  }
  const k = need - have;
  if (k <= 0 || k > free.length) return { states: [], free, need, have, axis, i, line };
  const combos = [];
  const pick = (from, chosen) => {
    if (combos.length > cap) return;
    if (chosen.length === k) {
      combos.push(chosen.slice());
      return;
    }
    for (let a = from; a < free.length; a++) {
      chosen.push(free[a]);
      pick(a + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  if (combos.length > cap) return null;

  const fleetCount = new Map();
  for (const s of board.fleet) fleetCount.set(s, (fleetCount.get(s) || 0) + 1);
  // 一个新增格能不能贴到线外的船上，取决于它在线里属于多长的一段：
  // 段长 >1 说明它就是躺在这条线上的船，正侧和斜角都不许有别的船；
  // 段长 =1 的格可能是**竖着穿过这条线**的船，它的正侧邻格就是同一条船，只有斜角才是禁区。
  const SIDE = axis === 'h' ? [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]] : [[-1, -1], [0, -1], [1, -1], [-1, 1], [0, 1], [1, 1]];
  const CORNER = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const states = [];
  for (const combo of combos) {
    const added = new Set(combo);
    const runs = [];
    let run = 0;
    let from = -1;
    for (let a = 0; a < line.length; a++) {
      const t = line[a];
      if (cells[t] === SHIP || added.has(t)) {
        if (!run) from = a;
        run++;
      } else {
        if (run) runs.push({ from, to: a - 1, len: run });
        run = 0;
      }
    }
    if (run) runs.push({ from, to: line.length - 1, len: run });

    let ok = true;
    const used = new Map();
    for (const g of runs) {
      if (g.len < 2) continue;
      used.set(g.len, (used.get(g.len) || 0) + 1);
      if (used.get(g.len) > (fleetCount.get(g.len) || 0)) ok = false;
    }
    if (!ok) continue;
    for (const g of runs) {
      for (let a = g.from; a <= g.to; a++) {
        const t = line[a];
        if (!added.has(t)) continue;
        const r = Math.floor(t / board.w);
        const c = t % board.w;
        for (const [dr, dc] of g.len > 1 ? SIDE : CORNER) {
          const n = at(board, r + dr, c + dc);
          if (n >= 0 && cells[n] === SHIP) ok = false;
        }
        if (!ok) break;
      }
      if (!ok) break;
    }
    if (ok) states.push(added);
  }
  return { states, free, need, have, axis, i, line };
}

const lineName = (board, axis, i) => (axis === 'h' ? `第${i + 1}行` : `第${i + 1}列`);
export const cellName = (board, t) => `第${Math.floor(t / board.w) + 1}行第${(t % board.w) + 1}列`;

// 一步铅笔推理。返回 null 表示本地规则无话可说（要靠猜或已经推完），
// 返回 {stalled:true} 表示盘面已经和题面打架。
export function nextDeduction(st) {
  const { board, cells } = st;

  // 0. 十字交叉的两条段不是"还没推完"，是已经摆坏了：先说出来，别让它继续往下推。
  const sm = shipMap(board, runsOf(board, cells));
  if (sm.bad.size) {
    const list = [...sm.bad];
    return { stalled: true, kind: 'contradiction', cells: list, why: `${list.map((t) => cellName(board, t)).join('、')} 同时属于一条横段和一条竖段：船只能是直线。` };
  }

  // 1. 邻格即水：已经落下的船格，八邻里除同船之外都必须是水。
  for (let t = 0; t < board.size; t++) {
    if (cells[t] !== SHIP) continue;
    const r = Math.floor(t / board.w);
    const c = t % board.w;
    for (const [dr, dc] of DIAG) {
      const n = at(board, r + dr, c + dc);
      if (n >= 0 && cells[n] === UNKNOWN) {
        return { kind: 'water', cells: [n], why: `${cellName(board, n)} 和 ${cellName(board, t)} 的船格斜角相对：船不能碰船，这里是水。`, rule: RULES.contact };
      }
    }
    for (const [dr, dc] of ORTHO) {
      const n = at(board, r + dr, c + dc);
      if (n >= 0 && cells[n] === SHIP && !sameSegment(board, cells, t, n)) {
        return { stalled: true, cells: [t, n], kind: 'contradiction', why: `${cellName(board, t)} 与 ${cellName(board, n)} 贴在一起，却不在同一条直段上：两条船碰了。` };
      }
      if (n >= 0 && cells[n] === UNKNOWN) {
        // 轴向邻格可能是同一艘船在延伸，不能直接判水；只有"这段已经封死"时才由满额规则处理。
      }
    }
  }

  // 2/3. 行与列的船格数。
  for (const axis of ['h', 'v']) {
    const count = axis === 'h' ? board.h : board.w;
    for (let i = 0; i < count; i++) {
      const line = lineCells(board, axis, i);
      const need = axis === 'h' ? board.rows[i] : board.cols[i];
      if (need < 0) continue;
      let have = 0;
      const free = [];
      for (const t of line) {
        if (cells[t] === SHIP) have++;
        else if (cells[t] === UNKNOWN) free.push(t);
      }
      if (have > need) {
        return { stalled: true, kind: 'contradiction', cells: line.filter((t) => cells[t] === SHIP), why: `${lineName(board, axis, i)}已经有 ${have} 个船格，题面只给了 ${need}。` };
      }
      if (free.length && have === need) {
        return { kind: 'water', cells: free, why: `${lineName(board, axis, i)}的 ${need} 个船格已经数满，其余 ${free.length} 格都是水。`, rule: RULES.full };
      }
      if (free.length && need - have === free.length) {
        return { kind: 'ship', cells: free, why: `${lineName(board, axis, i)}还差 ${need - have} 个船格，而未定的正好只有 ${free.length} 格：全得是船。`, rule: RULES.exact };
      }
    }
  }

  // 3.5 线内排法。一根线上的所有放法先枚举再取交集：谁都不盖的格是水，人人都盖的格是船。
  // 这条规则是大盘面上唯一还能开局的地方——满线索的大盘既没有 0 也没有满，前两条都推不动。
  for (const axis of ['h', 'v']) {
    const count = axis === 'h' ? board.h : board.w;
    for (let i = 0; i < count; i++) {
      const ls = lineStates(board, cells, axis, i);
      if (!ls) continue;
      if (!ls.states.length && ls.free.length && ls.need - ls.have > 0) {
        return {
          stalled: true,
          kind: 'contradiction',
          cells: ls.line.filter((t) => cells[t] !== WATER),
          why: `${lineName(board, axis, i)}要 ${ls.need} 个船格，可剩下的空格已经排不出任何一种放法了。`,
        };
      }
      if (ls.states.length < 2) continue;
      const every = ls.free.filter((t) => ls.states.every((s) => s.has(t)));
      if (every.length) {
        return {
          kind: 'ship',
          cells: every,
          why: `${lineName(board, axis, i)}的 ${ls.need} 个船格只有 ${ls.states.length} 种排法，每一种都盖住 ${every.map((t) => cellName(board, t)).join('、')}：这些格必是船。`,
          rule: RULES.line,
        };
      }
      const never = ls.free.filter((t) => !ls.states.some((s) => s.has(t)));
      if (never.length) {
        return {
          kind: 'water',
          cells: never,
          why: `${lineName(board, axis, i)}的 ${ls.states.length} 种排法没有一种盖到 ${never.map((t) => cellName(board, t)).join('、')}：这里是水。`,
          rule: RULES.line,
        };
      }
    }
  }

  // 4/5. 剩下的船还能摆在哪。
  const rf = remainingFleet(board, cells);
  if (!rf.ok) return { stalled: true, kind: 'contradiction', cells: rf.ships.flatMap((s) => s.cells), why: rf.reason };
  const undetermined = [];
  for (let t = 0; t < board.size; t++) if (cells[t] === UNKNOWN) undetermined.push(t);
  if (!undetermined.length) return null;
  if (!rf.remaining.length) {
    // 舰队已经全部落好并封死，剩下的空格只能是水。
    return { kind: 'water', cells: undetermined, why: `舰队 ${board.fleet.join('/')} 已经全部落位，剩下的空格再没有船能占：都是水。`, rule: RULES.nowhere };
  }
  const placements = placementsFor(board, cells, rf.remaining);
  const cover = new Set();
  for (const p of placements) for (const t of p.cells) cover.add(t);
  for (const t of undetermined) {
    if (!cover.has(t)) {
      return { kind: 'water', cells: [t], why: `${cellName(board, t)} 盖不住任何一艘还没落下的船（剩下 ${rf.remaining.join('/')}）：这里只能是水。`, rule: RULES.nowhere };
    }
  }
  // 唯一船位：某一艘剩余船在整个盘上只剩一种放法，或者所有放法都落在同一条线上并共享若干格。
  const byLen = new Map();
  for (const p of placements) {
    if (!byLen.has(p.len)) byLen.set(p.len, []);
    byLen.get(p.len).push(p);
  }
  for (const [len, list] of byLen) {
    const want = rf.remaining.filter((s) => s === len).length;
    if (list.length === want) {
      // 每一艘这个长度的船都只有自己的一个位置：逐艘落子。
      for (const p of list) {
        if (p.cells.every((t) => cells[t] === SHIP)) continue;
        return { kind: 'ship', cells: p.cells, why: `${len} 号船在这一盘只剩这一处放得下：${cellName(board, p.cells[0])} 起。`, rule: RULES.sole };
      }
      continue;
    }
    if (want === 1 && list.length > 1) {
      const lines = new Set(list.map((p) => `${p.axis}${p.axis === 'h' ? p.r : p.c}`));
      if (lines.size === 1) {
        const inter = list.map((p) => p.cells).reduce((a, b) => a.filter((t) => b.includes(t)));
        if (inter.length) {
          return {
            kind: 'ship',
            cells: inter,
            why: `${len} 号船放不进别的行/列，只能在 ${lineName(board, list[0].axis, list[0].axis === 'h' ? list[0].r : list[0].c)}——无论怎么挪，${inter.map((t) => cellName(board, t)).join('、')} 都是船。`,
            rule: RULES.sole,
          };
        }
      }
    }
  }
  return null;
  // 6. 反证。把某个未定格的两种可能各试一次，只看"必须成立"的那几项检查：
  //    它所在的行、列还得有排法；剩下的每一艘船还得找得到自己的位置。
  //    哪一边试出矛盾，另一边就是答案。这里用的全是**必要条件**——lineStates 与
  //    placementsFor 交出来的都是可能偏大的集合，所以"空了"就是真放不下，不会因为
  //    "没枚举全"而把正解抹掉。这是铅笔刀里的反证，不是搜索：一次只看一格，不套假设。
  const ni = nishioStep(board, cells, undetermined);
  if (ni) return ni;

  return null;
}

const NISHIO_CELLS = 90;

// 假设 cells[t] = v 之后，那些"非真不可"的检查里哪一条先塌。返回 null 表示没查出毛病
// （不代表假设成立，只代表必要条件都还过得去）。
function assumptionBreaks(board, cells, t, v) {
  cells[t] = v;
  let out = null;
  for (const axis of ['h', 'v']) {
    const i = axis === 'h' ? Math.floor(t / board.w) : t % board.w;
    const ls = lineStates(board, cells, axis, i);
    if (!ls) continue;
    if (!ls.states.length) {
      out = { where: lineName(board, axis, i), what: ls.need - ls.have > 0 ? '排不出任何一种放法' : '船格数已经超了' };
      break;
    }
  }
  if (!out) {
    const rf = remainingFleet(board, cells);
    if (!rf.ok) out = { where: '舰队', what: rf.reason };
    else if (rf.remaining.length) {
      const placements = placementsFor(board, cells, rf.remaining);
      const got = new Map();
      for (const p of placements) got.set(p.len, (got.get(p.len) || 0) + 1);
      for (const len of new Set(rf.remaining)) {
        const want = rf.remaining.filter((s) => s === len).length;
        if ((got.get(len) || 0) < want) {
          out = { where: `${len} 号船`, what: `只剩 ${got.get(len) || 0} 处放得下，可这样的船还有 ${want} 艘` };
          break;
        }
      }
    }
  }
  cells[t] = UNKNOWN;
  return out;
}

function nishioStep(board, cells, undetermined) {
  const list = undetermined.slice(0, NISHIO_CELLS);
  for (const t of list) {
    const asShip = assumptionBreaks(board, cells, t, SHIP);
    if (asShip) {
      return {
        kind: 'water',
        cells: [t],
        why: `假设 ${cellName(board, t)} 是船：${asShip.where}${asShip.what}。所以这里只能是水。`,
        rule: RULES.nishio,
      };
    }
  }
  for (const t of list) {
    const asWater = assumptionBreaks(board, cells, t, WATER);
    if (asWater) {
      return {
        kind: 'ship',
        cells: [t],
        why: `假设 ${cellName(board, t)} 是水：${asWater.where}${asWater.what}。所以这里必是船。`,
        rule: RULES.nishio,
      };
    }
  }
  return null;
}

function sameSegment(board, cells, a, b) {
  const ra = Math.floor(a / board.w);
  const ca = a % board.w;
  const rb = Math.floor(b / board.w);
  const cb = b % board.w;
  if (ra === rb && Math.abs(ca - cb) === 1) {
    // 同一行相邻：必须是同一条横段（两端都不算，只要中间没有水/未定隔开即可）
    return true;
  }
  if (ca === cb && Math.abs(ra - rb) === 1) return true;
  return false;
}

export function lineCells(board, axis, i) {
  const out = [];
  if (axis === 'h') for (let c = 0; c < board.w; c++) out.push(at(board, i, c));
  else for (let r = 0; r < board.h; r++) out.push(at(board, r, i));
  return out;
}

export function applyDeduction(st, d) {
  snapshot(st);
  for (const t of d.cells) st.cells[t] = d.kind === 'ship' ? SHIP : d.kind === 'water' ? WATER : st.cells[t];
  return true;
}

// ---- 判胜 ----------------------------------------------------------------------------

export function verify(board, cells) {
  const badCells = new Set();
  const badClues = new Set();

  const { ships: hulls, singles, bad } = shipMap(board, runsOf(board, cells));
  // 1 号小艇在 shipMap 里是单列的，这里必须并进来，否则舰队里那条 1 号船永远配不上对。
  const ships = hulls.concat(singles);
  for (const t of bad) badCells.add(t);
  if (bad.size) return { ok: false, badCells, badClues, reason: '有十字交叉的船段' };

  // 没写的格子就是水：判胜只看"写下来的船"，所以玩家不必把 100 格海都点一遍。
  // 但正因为行/列线索可能被省略，船格总数不能靠线索推出来——长度多重集那一行是唯一的把关处。
  // 每行每列的船格数
  for (let r = 0; r < board.h; r++) {
    const line = lineCells(board, 'h', r);
    const n = line.filter((t) => cells[t] === SHIP).length;
    if (board.rows[r] >= 0 && n !== board.rows[r]) {
      badClues.add(`h${r}`);
      for (const t of line) badCells.add(t);
    }
  }
  for (let c = 0; c < board.w; c++) {
    const line = lineCells(board, 'v', c);
    const n = line.filter((t) => cells[t] === SHIP).length;
    if (board.cols[c] >= 0 && n !== board.cols[c]) {
      badClues.add(`v${c}`);
      for (const t of line) badCells.add(t);
    }
  }

  const claim = new Int8Array(board.size);
  for (const s of ships) for (const t of s.cells) claim[t] = 1;
  for (let t = 0; t < board.size; t++) {
    if (cells[t] === SHIP && !claim[t]) {
      badCells.add(t);
      return { ok: false, badCells, badClues, reason: '有一段船既不是直线船体，也不是小艇' };
    }
  }
  const lens = ships.map((s) => s.len).sort((a, b) => b - a);
  const want = board.fleet.slice().sort((a, b) => b - a);
  if (lens.length !== want.length || lens.some((s, i) => s !== want[i])) {
    for (const s of ships) for (const t of s.cells) badCells.add(t);
    return { ok: false, badCells, badClues, reason: `船的长度是 ${lens.join('/') || '无'}，舰队要的是 ${want.join('/')}` };
  }
  for (const s of ships) {
    for (const t of s.cells) {
      const r = Math.floor(t / board.w);
      const c = t % board.w;
      for (const [dr, dc] of AHEAD) {
        const n = at(board, r + dr, c + dc);
        if (n < 0 || cells[n] !== SHIP) continue;
        if (s.cells.includes(n)) continue;
        badCells.add(t);
        badCells.add(n);
        return { ok: false, badCells, badClues, reason: '两条船相接了（含对角）' };
      }
    }
  }
  return { ok: true, badCells, badClues, reason: '舰队全部落位，四邻干净，行列船格数都对得上', ships };
}

export function diagnose(st) {
  const { board, cells } = st;
  let ships = 0;
  let water = 0;
  let unknown = 0;
  for (let t = 0; t < board.size; t++) {
    if (cells[t] === SHIP) ships++;
    else if (cells[t] === WATER) water++;
    else unknown++;
  }
  const badCells = new Set();
  const badClues = new Set();
  let conflicts = 0;
  for (const axis of ['h', 'v']) {
    const count = axis === 'h' ? board.h : board.w;
    for (let i = 0; i < count; i++) {
      const line = lineCells(board, axis, i);
      const need = axis === 'h' ? board.rows[i] : board.cols[i];
      if (need < 0) continue;
      const have = line.filter((t) => cells[t] === SHIP).length;
      if (have > need) {
        conflicts++;
        badClues.add(`${axis}${i}`);
        for (const t of line) if (cells[t] === SHIP) badCells.add(t);
      }
    }
  }
  const rf = remainingFleet(board, cells);
  if (!rf.ok) conflicts++;
  const touching = [];
  for (const [dr, dc] of DIAG) {
    for (let t = 0; t < board.size; t++) {
      if (cells[t] !== SHIP) continue;
      const n = at(board, Math.floor(t / board.w) + dr, (t % board.w) + dc);
      if (n >= 0 && cells[n] === SHIP) {
        touching.push([t, n]);
        badCells.add(t);
        badCells.add(n);
        conflicts++;
      }
    }
  }
  return {
    ships,
    water,
    unknown,
    total: board.size,
    fleetTotal: board.total,
    remaining: rf.ok ? rf.remaining.length : 0,
    docked: rf.ok ? rf.ships.length : 0,
    conflicts,
    badCells,
    badClues,
    clues: board.rows.filter((v) => v >= 0).length + board.cols.filter((v) => v >= 0).length,
    won: verify(board, cells).ok,
  };
}

// ---- 整盘求解（出题器的准入门）------------------------------------------------------

export function solveWithRules(st, { cap = 2000 } = {}) {
  const breakdown = {};
  let score = 0;
  let steps = 0;
  let stall = null;
  while (steps < cap) {
    const d = nextDeduction(st);
    if (!d) {
      stall = verify(st.board, st.cells).ok ? null : 'stalled';
      break;
    }
    if (d.stalled) {
      stall = 'contradiction';
      break;
    }
    applyDeduction(st, d);
    breakdown[d.rule.key] = (breakdown[d.rule.key] || 0) + 1;
    score += d.rule.weight;
    steps++;
  }
  const win = verify(st.board, st.cells);
  return { ok: win.ok, stall, steps, score, breakdown, cells: Uint8Array.from(st.cells) };
}

export function solveSpec(spec) {
  return solveWithRules(createState(createBoard(spec)), { cap: 3000 });
}
