// 推理内核的规矩测试。跑法：node tools/engine-test.mjs [每档种子数]
//
// 这里最硬的一条是"每一步推论都必须和出题那支舰队对得上"：出题器摆好的那支船就是这张盘的
// 一个解，所以任何一条铅笔规则只要落子和它不一样，就是在乱写。这条比"能推完"更值钱——
// 它抓的是"推错了"，不是"推不动"。这一条真抓出过两次：线内排法误杀竖穿的船、
// 无处落船把写过一格的船当成放不下。
//
// 另外三条：独立计数器和一个不加任何剪枝的朴素枚举必须给同一个数；verify 必须收正解、
// 拒绝每一处单格改动；出题器交出来的盘必须"唯一 + 纯逻辑推得完 + 独立验胜"。

import {
  createBoard,
  createState,
  verify,
  diagnose,
  nextDeduction,
  applyDeduction,
  solveWithRules,
  remainingFleet,
  dockedShips,
  lineStates,
  SHIP,
  WATER,
  UNKNOWN,
} from '../js/engine/ships.js';
import { countSolutions } from '../js/engine/count.js';
import { generate, layout, TIERS } from '../js/engine/generate.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) {
    fails++;
    console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`);
  }
};

const clueOf = (w, h, cells) => ({
  rows: [...Array(h)].map((_, r) => [...Array(w)].filter((_, c) => cells[r * w + c] === SHIP).length),
  cols: [...Array(w)].map((_, c) => [...Array(h)].filter((_, r) => cells[r * w + c] === SHIP).length),
});

// 出题器摆好的那支船只标了 SHIP，其余留空——"没写的就是水"正是这局的胜负判据。
// 但 dockedShips 认的是"两端封死"，空格在它眼里是还没定性的格子，不是水。
// 所以要量"舰队认全没有"，得先把正解写成满墨的一盘。
const inked = (cells) => Uint8Array.from(cells, (v) => (v === SHIP ? SHIP : WATER));

// 朴素枚举：一艘一艘地试所有摆法，只在最后一步按规则原文核对线索和接触，
// 不加任何剪枝。它就是 count.js 的对照组——那边每加一条剪枝，这边就必须还对得上。
function bruteForce(w, h, fleet, rows, cols) {
  const counts = new Map();
  for (const s of fleet) counts.set(s, (counts.get(s) || 0) + 1);
  const groups = [...counts.keys()]
    .sort((a, b) => b - a)
    .map((len) => {
      const list = [];
      for (let r = 0; r < h; r++) {
        for (let c = 0; c + len <= w; c++) list.push(Array.from({ length: len }, (_, k) => r * w + c + k));
      }
      if (len > 1) {
        for (let c = 0; c < w; c++) {
          for (let r = 0; r + len <= h; r++) list.push(Array.from({ length: len }, (_, k) => (r + k) * w + c));
        }
      }
      return { len, list, want: counts.get(len) };
    });
  const queue = groups.flatMap((g) => Array.from({ length: g.want }, () => g.list));
  const out = [];
  const occ = new Uint8Array(w * h);
  const taken = [];
  const accepts = () => {
    for (let r = 0; r < h; r++) {
      let k = 0;
      for (let c = 0; c < w; c++) if (occ[r * w + c]) k++;
      if (rows[r] >= 0 && k !== rows[r]) return false;
    }
    for (let c = 0; c < w; c++) {
      let k = 0;
      for (let r = 0; r < h; r++) if (occ[r * w + c]) k++;
      if (cols[c] >= 0 && k !== cols[c]) return false;
    }
    // 每一个船格的八邻若不是同一条船的格子，就是两条船碰上了
    for (const cells of taken) {
      const own = new Set(cells);
      for (const t of cells) {
        const r = Math.floor(t / w);
        const c = t % w;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
            const n = rr * w + cc;
            if (occ[n] && !own.has(n)) return false;
          }
        }
      }
    }
    return true;
  };
  const walk = (i, from) => {
    if (i === queue.length) {
      if (accepts()) out.push(Uint8Array.from(occ));
      return;
    }
    const list = queue[i];
    for (let a = from; a < list.length; a++) {
      let ok = true;
      for (const t of list[a]) if (occ[t]) ok = false;
      if (!ok) continue;
      for (const t of list[a]) occ[t] = 1;
      taken.push(list[a]);
      const nextSameGroup = i + 1 < queue.length && queue[i + 1] === list;
      walk(i + 1, nextSameGroup ? a + 1 : 0);
      taken.pop();
      for (const t of list[a]) occ[t] = 0;
    }
  };
  walk(0, 0);
  return out;
}

const SAMPLES = Number(process.argv[2] || 12);

// ---- 1. 每一步推论都要和出题那支舰队对得上 -------------------------------------------

console.log('— 推理器 soundness（满线索盘，逐条规则对着正解验）');
let probes = 0;
for (const tier of TIERS) {
  let done = 0;
  let stalled = 0;
  let quiet = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const seed = `s${s}`;
    const laid = layout({ w: tier.w, h: tier.h, fleet: tier.fleet, seed: `${seed}|${tier.key}` });
    if (!laid) continue;
    const { rows, cols } = clueOf(tier.w, tier.h, laid.cells);
    const board = createBoard({ w: tier.w, h: tier.h, fleet: tier.fleet, rows, cols });
    probes++;
    const st = createState(board);
    let verdict = 'quiet';
    for (let steps = 0; steps < 4000; steps++) {
      const d = nextDeduction(st);
      if (!d) break;
      if (d.stalled) {
        verdict = 'stalled';
        check(`${tier.key} ${seed} 正解盘不该被判矛盾`, false, d.why);
        break;
      }
      let wrong = null;
      for (const t of d.cells) {
        if (d.kind === 'ship' && laid.cells[t] !== SHIP) wrong = `${d.rule.name} 把 ${t} 判成船，正解在这里是水`;
        if (d.kind === 'water' && laid.cells[t] === SHIP) wrong = `${d.rule.name} 把 ${t} 判成水，正解在这里躺着船`;
        if (wrong) break;
      }
      if (wrong) {
        verdict = 'unsound';
        check(`${tier.key} ${seed} 推论与正解一致`, false, wrong);
        break;
      }
      applyDeduction(st, d);
    }
    if (verdict === 'quiet') {
      if (verify(board, st.cells).ok) done++;
      else verdict = 'quiet';
    }
    if (verdict !== 'quiet') stalled += verdict === 'stalled' ? 1 : 0;
    else quiet++;
  }
  console.log(`  ${tier.key.padEnd(11)} ${tier.w}×${tier.h}  推完 ${done}，推不动 ${quiet - done}，判矛盾 ${stalled}`);
}

// ---- 2. 独立计数器 vs 朴素枚举 --------------------------------------------------------

console.log('— 独立计数对账（4×4 / 4×5 / 5×5，全线索与抹两条各一组）');
let pairs = 0;
for (const [w, h, fleet] of [[4, 4, [2, 1]], [4, 4, [1, 1, 1]], [4, 5, [2, 2]], [5, 4, [3, 2]], [5, 5, [3, 1]]]) {
  const laid = layout({ w, h, fleet, seed: 'count' });
  const { rows, cols } = clueOf(w, h, laid.cells);
  for (const omit of [false, true]) {
    const spec = { w, h, fleet, rows: rows.slice(), cols: cols.slice() };
    if (omit) {
      spec.rows[0] = -1;
      spec.cols[0] = -1;
    }
    const board = createBoard(spec);
    const fast = countSolutions(board, { cap: 1e6, budget: 4_000_000 });
    const slow = bruteForce(w, h, fleet, spec.rows, spec.cols).length;
    check(`count ${w}×${h} ${fleet.join('/')} 抹掉=${omit}`, fast.count === slow && !fast.capped, `内核 ${fast.count} 枚举 ${slow}`);
    pairs++;
  }
}
console.log(`  ${pairs} 组对完`);

// ---- 3. verify 收正解、拒改动 ----------------------------------------------------------

let mutated = 0;
for (const tier of TIERS) {
  const laid = layout({ w: tier.w, h: tier.h, fleet: tier.fleet, seed: `v|${tier.key}` });
  const { rows, cols } = clueOf(tier.w, tier.h, laid.cells);
  const board = createBoard({ w: tier.w, h: tier.h, fleet: tier.fleet, rows, cols });
  check(`${tier.key} verify 收正解`, verify(board, laid.cells).ok, verify(board, laid.cells).reason);
  const full = inked(laid.cells);
  check(`${tier.key} verify 收满墨正解`, verify(board, full).ok, verify(board, full).reason);
  for (let t = 0; t < board.size; t++) {
    const flipped = Uint8Array.from(full);
    flipped[t] = flipped[t] === SHIP ? WATER : SHIP;
    if (verify(board, flipped).ok) check(`${tier.key} verify 拒绝翻格 ${t}`, false, '翻了格子还算赢');
    // 只有"擦掉一个船格"才算缺一格。擦水格是把墨擦回空白，而空白本来就是水，判胜是对的。
    if (full[t] === SHIP) {
      const wiped = Uint8Array.from(full);
      wiped[t] = UNKNOWN;
      if (verify(board, wiped).ok) check(`${tier.key} verify 拒绝擦船格 ${t}`, false, '缺一格还算赢');
    } else {
      const erased = Uint8Array.from(full);
      erased[t] = UNKNOWN;
      if (!verify(board, erased).ok) check(`${tier.key} verify 接受擦水格 ${t}`, false, '空白就是水，不该判负');
    }
    mutated += full[t] === SHIP ? 2 : 3;
  }
}
console.log(`  verify 判了 ${mutated} 处单格改动，全部按规则原文答复`);

// ---- 4. 内核定性函数：正解盘上必须认全舰队 -------------------------------------------

for (const tier of TIERS) {
  const laid = layout({ w: tier.w, h: tier.h, fleet: tier.fleet, seed: `d|${tier.key}` });
  const { rows, cols } = clueOf(tier.w, tier.h, laid.cells);
  const board = createBoard({ w: tier.w, h: tier.h, fleet: tier.fleet, rows, cols });
  const full = inked(laid.cells);
  const docked = dockedShips(board, full).ships;
  check(`${tier.key} dockedShips 认全舰队`, docked.length === board.fleet.length, `${docked.length}/${board.fleet.length}`);
  const rf = remainingFleet(board, full);
  check(`${tier.key} remainingFleet 归零`, rf.ok && rf.remaining.length === 0, JSON.stringify(rf.remaining));
  const empty = createState(board);
  const ls = lineStates(board, empty.cells, 'h', 0);
  check(`${tier.key} lineStates 第一行有排法`, !!ls && ls.states.length > 0);
  check(`${tier.key} 空盘不判胜`, diagnose(empty).won === false);
  check(`${tier.key} 正解盘判胜`, diagnose({ board, cells: full, history: [] }).won === true);
}

// ---- 5. 出题器交出来的盘必须过全部三道门 ---------------------------------------------

console.log('— 出题器（每档 6 个种子）');
for (const tier of TIERS) {
  let got = 0;
  const t0 = performance.now();
  for (let s = 0; s < 6; s++) {
    const r = generate({ ...tier, seed: `g${s}` });
    if (!r.ok) continue;
    got++;
    check(`${tier.key} 出题 verify`, verify(r.board, r.solution).ok);
    check(`${tier.key} 出题唯一`, countSolutions(r.board, { cap: 2, budget: 400_000 }).status === 'UNIQUE');
    check(`${tier.key} 出题推得完`, solveWithRules(createState(r.board)).ok);
    check(`${tier.key} 出题抹过线索`, r.clues < tier.w + tier.h, `${r.clues}/${tier.w + tier.h}`);
  }
  check(`${tier.key} 出题命中`, got === 6, `只有 ${got}/6 个种子出了盘`);
  console.log(`  ${tier.key.padEnd(11)} 命中 ${got}/6  ${((performance.now() - t0) / 6).toFixed(0)}ms/盘`);
}

console.log(fails ? `\nFAILED ${fails}` : '\nall engine invariants hold');
process.exit(fails ? 1 : 0);
