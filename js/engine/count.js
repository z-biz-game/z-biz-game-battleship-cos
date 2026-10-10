// 独立的计数搜索。它只读题面（舰队长度、行列船格数、"船连对角都不能碰"），
// 不调用 js/engine/ships.js 的任何推理函数——出题时用它证明"只有这一个解"，
// 要是它和推理器共用一套逻辑，那句"唯一"就只是自己给自己盖章。
//
// 做法是最朴素的回溯：一艘一艘地摆。每占一格就把它的八邻记一次数（记数不记布尔，
// 撤销时才能精确还原），同长度的船只按"段编号递增"的顺序摆，否则交换两艘同长度小艇
// 会被数成两个解，把"唯一"错判成"多个"。
//
// `capped` 是诚实字段：预算用完还没数完时状态是 OVERBUDGET，绝不冒充 UNIQUE。

const SHIP = 1;
const WATER = 2;

const NEIGH = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

// 盘上所有长度为 len 的候选段（横的竖的都要）。起点在段编号里也是递增的，
// 所以"同长度按编号递增"这一条同时排掉了重复，也保证了每个起点都会被试到。
function segmentsOf(w, h, len) {
  const out = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c + len <= w; c++) {
      const cells = [];
      for (let k = 0; k < len; k++) cells.push(r * w + c + k);
      out.push({ axis: 'h', r, c, cells });
    }
  }
  // 1 号小艇横着竖着是同一个摆法，只记一次，否则每个小艇都被数两遍，"唯一"会数成"两个"。
  if (len === 1) return out;
  for (let c = 0; c < w; c++) {
    for (let r = 0; r + len <= h; r++) {
      const cells = [];
      for (let k = 0; k < len; k++) cells.push((r + k) * w + c);
      out.push({ axis: 'v', r, c, cells });
    }
  }
  return out;
}

// fixed：已经钉死的格子（SHIP=必须是船格，WATER=必须是水），出题过程里传全 0 即可，
// 因为题面只有行列线索和舰队；恢复对局时用它数"玩家已经写的墨有没有别的解"。
export function countSolutions(board, { fixed = null, cap = 2, budget = 250_000 } = {}) {
  const { w, h, rows, cols } = board;
  const n = w * h;
  const lock = fixed ? Uint8Array.from(fixed) : new Uint8Array(n);

  const occ = new Uint8Array(n);
  const blocked = new Int16Array(n);
  const rowHave = new Int16Array(h);
  const colHave = new Int16Array(w);

  const counts = new Map();
  for (const s of board.fleet) counts.set(s, (counts.get(s) || 0) + 1);
  // 先摆长船：它们能放的位置少，早摆能更早地把树剪小。
  const queue = [...counts.keys()].sort((a, b) => b - a).flatMap((len) => Array.from({ length: counts.get(len) }, () => len));
  const segs = new Map();
  for (const len of counts.keys()) segs.set(len, segmentsOf(w, h, len));

  // 钉成水的格子永远不能落子；钉成船格的位置最后统一核对（见 locksHonoured）。
  for (let t = 0; t < n; t++) if (lock[t] === WATER) blocked[t] += 1000;

  let nodes = 0;
  let capped = false;
  const solutions = [];

  const freeCell = (t) => occ[t] === 0 && blocked[t] === 0;
  // 花括号在这里是必须的：写成 `if (axis==='h') for(...) if(...) room++; else for(...)`
  // 时 else 会挂到内层的 if 上，竖着数的那一支永远不会执行。
  const lineRoom = (axis, i) => {
    let room = 0;
    if (axis === 'h') {
      for (let c = 0; c < w; c++) if (freeCell(i * w + c)) room++;
    } else {
      for (let r = 0; r < h; r++) if (freeCell(r * w + i)) room++;
    }
    return room;
  };

  const apply = (seg, on) => {
    const delta = on ? 1 : -1;
    for (const t of seg.cells) {
      occ[t] = on ? 1 : 0;
      rowHave[Math.floor(t / w)] += delta;
      colHave[t % w] += delta;
    }
    for (const t of seg.cells) {
      const r = Math.floor(t / w);
      const c = t % w;
      for (const [dr, dc] of NEIGH) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const nb = rr * w + cc;
        if (seg.cells.includes(nb)) continue;
        blocked[nb] += delta;
      }
    }
  };

  const feasible = () => {
    for (let r = 0; r < h; r++) {
      if (rows[r] < 0) continue;
      if (rowHave[r] > rows[r]) return false;
      if (rowHave[r] + lineRoom('h', r) < rows[r]) return false;
    }
    for (let c = 0; c < w; c++) {
      if (cols[c] < 0) continue;
      if (colHave[c] > cols[c]) return false;
      if (colHave[c] + lineRoom('v', c) < cols[c]) return false;
    }
    return true;
  };

  const locksHonoured = () => {
    for (let t = 0; t < n; t++) {
      if (lock[t] === SHIP && !occ[t]) return false;
      if (lock[t] === WATER && occ[t]) return false;
    }
    return true;
  };

  // remainingCells[i] = 第 i 艘之后（含第 i 艘）还要占多少格，先算好用来剪枝。
  const remainingCells = new Int32Array(queue.length + 1);
  for (let i = queue.length - 1; i >= 0; i--) remainingCells[i] = remainingCells[i + 1] + queue[i];
  const freeTotal = () => {
    let k = 0;
    for (let t = 0; t < n; t++) if (freeCell(t)) k++;
    return k;
  };

  const search = (i, from) => {
    if (capped || solutions.length >= cap) return;
    if (nodes++ > budget) {
      capped = true;
      return;
    }
    if (i === queue.length) {
      const bad = rows.some((v, r) => v >= 0 && v !== rowHave[r]) || cols.some((v, c) => v >= 0 && v !== colHave[c]);
      if (!bad && locksHonoured()) solutions.push(Uint8Array.from(occ));
      return;
    }
    if (remainingCells[i] > freeTotal()) return;
    const len = queue[i];
    const list = segs.get(len);
    const sameAsPrev = i > 0 && queue[i - 1] === len;
    const start = sameAsPrev ? from : 0;
    for (let s = start; s < list.length; s++) {
      const seg = list[s];
      let ok = true;
      for (const t of seg.cells) if (!freeCell(t)) ok = false;
      if (!ok) continue;
      apply(seg, true);
      if (feasible()) search(i + 1, s + 1);
      apply(seg, false);
      if (capped || solutions.length >= cap) return;
      // 同长度的下一艘只能往更后面的段找，所以这一段之后不必再试同一个 i 的更小车号
      // ——但不同长度的下一艘从头开始，所以这里必须继续循环，不能 break。
    }
  };

  search(0, 0);
  if (capped) return { status: 'OVERBUDGET', capped: true, count: solutions.length, solutions };
  if (solutions.length === 0) return { status: 'NONE', capped: false, count: 0, solutions };
  if (solutions.length === 1) return { status: 'UNIQUE', capped: false, count: 1, solution: Uint8Array.from(solutions[0]), solutions };
  return { status: 'MULTIPLE', capped: false, count: solutions.length, solutions };
}
