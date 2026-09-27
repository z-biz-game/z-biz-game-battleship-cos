// 出题器。先按规则随机摆出一支舰队（这是保证有解的那一步），把行列船格数当线索抄下来，
// 然后一条一条试着抹掉线索：抹掉之后仍然"唯一 + 纯铅笔可推完"才保留。
// 所以盘面难度不是形容词，是量出来的——分数由推理内核自己打分，档位按实测分布定。
//
// 三条硬约束都在这文件里，不靠事后挑：
//   * 唯一：js/engine/count.js 的独立搜索说 UNIQUE 才算，OVERBUDGET 一律当不合格（不许蒙混）；
//   * 可推：js/engine/ships.js 的 solveWithRules 必须从空盘推到舰队全部落位，一步都不猜；
//   * 可复现：所有随机都来自 makeRng(seed)，存档只存 seed 和档位就能重画同一张盘。

import { makeRng } from './rng.js';
import { createBoard, solveWithRules, createState, SHIP, WATER, UNKNOWN } from './ships.js';
import { countSolutions } from './count.js';

// 一支合法舰队：逐艘随机落子，落不下就整支重来。船与船（含对角）不能碰，
// 这是规则本身，所以这里不需要"先摆满再修"，摆不下就重开更省事也好验证。
function randomFleet(w, h, fleet, rng) {
  const cells = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const near = (r, c, on) => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        blocked[rr * w + cc] += on ? 1 : -1;
      }
    }
  };
  const placed = [];
  const order = rng.shuffle(fleet.map((len, i) => ({ len, i })));
  order.sort((a, b) => b.len - a.len);
  for (const { len } of order) {
    const spots = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c + len <= w; c++) {
        let ok = true;
        for (let k = 0; k < len; k++) if (blocked[r * w + c + k]) ok = false;
        if (ok) spots.push({ r, c, len, axis: 'h' });
      }
    }
    if (len > 1) {
      for (let c = 0; c < w; c++) {
        for (let r = 0; r + len <= h; r++) {
          let ok = true;
          for (let k = 0; k < len; k++) if (blocked[(r + k) * w + c]) ok = false;
          if (ok) spots.push({ r, c, len, axis: 'v' });
        }
      }
    }
    if (!spots.length) return null;
    const pick = spots[rng.int(spots.length)];
    for (let k = 0; k < pick.len; k++) {
      const t = pick.axis === 'h' ? pick.r * w + pick.c + k : (pick.r + k) * w + pick.c;
      cells[t] = SHIP;
    }
    for (let k = 0; k < pick.len; k++) near(pick.axis === 'h' ? pick.r : pick.r + k, pick.axis === 'h' ? pick.c + k : pick.c, true);
    placed.push(pick);
  }
  return { cells, placed };
}

const rowCounts = (w, h, cells) => {
  const rows = [];
  for (let r = 0; r < h; r++) {
    let k = 0;
    for (let c = 0; c < w; c++) if (cells[r * w + c] === SHIP) k++;
    rows.push(k);
  }
  return rows;
};
const colCounts = (w, h, cells) => {
  const cols = [];
  for (let c = 0; c < w; c++) {
    let k = 0;
    for (let r = 0; r < h; r++) if (cells[r * w + c] === SHIP) k++;
    cols.push(k);
  }
  return cols;
};

// 抹线索。抹的顺序由 rng 打散后按"这条线索本身有多少信息"排序：一条线数出的船格越多，
// 它给的信息越硬，越往后抹；clue=0 的那条线其实只说了"整行都是水"，最先被抹。
// 每抹一条都重新过"纯逻辑能推完 + 独立搜索说唯一"两道门，任何一道不过就把这条放回去。
// 返回的 score/steps/breakdown 就是最后一次通过检查那一步量出来的，不再重复算一遍。
function craft(boardSpec, rng, { keepRatio = 0, minClues = 0, countBudget = 60_000 } = {}) {
  const { w, h, fleet } = boardSpec;
  const rows = boardSpec.rows.slice();
  const cols = boardSpec.cols.slice();
  let last = measure({ w, h, fleet, rows, cols }, countBudget);
  if (!last.ok) return last;
  const slots = rng.shuffle([
    ...rows.map((v, i) => ({ axis: 'h', i, strength: v })),
    ...cols.map((v, i) => ({ axis: 'v', i, strength: v })),
  ]);
  slots.sort((a, b) => a.strength - b.strength);
  const floor = minClues || Math.round((w + h) * keepRatio);
  let left = w + h;
  for (const s of slots) {
    if (left <= floor) break;
    const back = s.axis === 'h' ? rows[s.i] : cols[s.i];
    if (back === -1) continue;
    if (s.axis === 'h') rows[s.i] = -1;
    else cols[s.i] = -1;
    const got = measure({ w, h, fleet, rows, cols }, countBudget);
    if (!got.ok) {
      if (s.axis === 'h') rows[s.i] = back;
      else cols[s.i] = back;
      continue;
    }
    last = got;
    left--;
  }
  return { rows, cols, ...last };
}

// 两道门。顺序是故意的：逻辑检查比独立计数便宜得多，先让它挡掉大部分不合格。
// 门是"和"的关系，所以 ok=false 时 reason 说清是哪一道拦的，balance 用它统计淘汰原因。
function measure(spec, countBudget = 60_000) {
  const board = createBoard(spec);
  const t0 = performance.now();
  const run = solveWithRules(createState(board), { cap: 4000 });
  const ms = performance.now() - t0;
  if (!run.ok) return { ok: false, stage: 'logic', reason: run.stall || 'stalled', ms, run };
  const c = countSolutions(board, { cap: 2, budget: countBudget });
  if (c.status === 'OVERBUDGET') return { ok: false, stage: 'count', reason: 'overbudget', ms, run };
  if (c.status !== 'UNIQUE') return { ok: false, stage: 'count', reason: 'ambiguous', ms, run };
  return { ok: true, board, score: run.score, steps: run.steps, breakdown: run.breakdown, ms, clues: spec.rows.filter((v) => v >= 0).length + spec.cols.filter((v) => v >= 0).length };
}

export function layout({ w, h, fleet, seed }) {
  const rng = makeRng(`${seed}|layout|${w}x${h}`);
  for (let k = 0; k < 200; k++) {
    const got = randomFleet(w, h, fleet, rng);
    if (got) return got;
  }
  return null;
}

// 候选打分：分数越高越吃推理。band 是这一档实测出来的分数区间，越贴越好的；
// offBand 一并返回，harness 用它区分"挑出来的难度"和"顺手撞上的难度"。
export function generate(opts = {}) {
  const {
    w = 6,
    h = 6,
    fleet = [3, 2, 1],
    seed = 'plain',
    band = null,
    tries = 120,
    keepRatio = 0.55,
    countBudget = 60_000,
    report = () => {},
  } = opts;
  let best = null;
  let drawn = 0;
  const stats = { accepted: 0, inBand: 0, notLogic: 0, ambiguous: 0, overbudget: 0, noLayout: 0 };
  const keyOf = (c) => c.offBand;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const laid = layout({ w, h, fleet, seed: trial });
    if (!laid) {
      stats.noLayout++;
      continue;
    }
    drawn++;
    const base = { w, h, fleet, rows: rowCounts(w, h, laid.cells), cols: colCounts(w, h, laid.cells) };
    const rng = makeRng(`${trial}|craft`);
    const crafted = craft(base, rng, { keepRatio, countBudget });
    if (!crafted.ok) {
      // 连"一条线索都不抹"的满线索盘都过不了两道门，说明这支舰队的形状推不出来
      if (crafted.stage === 'logic') stats.notLogic++;
      else if (crafted.reason === 'overbudget') stats.overbudget++;
      else stats.ambiguous++;
      report({ k, stage: crafted.stage, ok: false, reason: crafted.reason });
      continue;
    }
    const spec = { w, h, fleet, rows: crafted.rows, cols: crafted.cols };
    const offBand = band ? Math.abs(crafted.score - clamp(crafted.score, band[0], band[1])) : 0;
    if (band && crafted.score >= band[0] && crafted.score <= band[1]) stats.inBand++;
    const cand = {
      board: crafted.board,
      spec,
      seed: trial,
      score: crafted.score,
      steps: crafted.steps,
      breakdown: crafted.breakdown,
      ms: crafted.ms,
      offBand,
      clues: crafted.clues,
      gen: k + 1,
      solution: laid.cells,
    };
    stats.accepted++;
    if (!best || keyOf(cand) < keyOf(best)) best = cand;
    report({ k, stage: 'ready', score: cand.score, offBand, clues: cand.clues, ms: cand.ms });
    // 落在带内就不再抽了。这里刻意不看墙钟时间：存档只记 seed，
    // 一个"取决于机器负载"的抽取结果没法在恢复对局时重画出来。
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, stats, drawn, board: null, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, stats, drawn, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 档位表。band 是 tools/balance.mjs 实测出来的分数区间，不拍脑袋。budgetMs 是同一台机器
// 量出来的**单盘墙钟 p95 基线**（24 抽），CI 拿它 ×2 当红线：出题慢是要玩家等的，不能靠感觉
// 放行。基线取 p95 而不是中位数，因为这个分布是双峰的——一次抽中的盘 1ms 就出来了，烧到
// tries 上限的盘要三秒，中位数（高阶 730ms）代表不了"点新的一局要等多久"的那条尾巴。
// 2026-09-27 实测 p95：199 / 182 / 1378 / 2782 / 1312，两次抽样里最差的一档取整作基线。
//
// 为什么最大只到 7×7：行/列"船格数"这种线索在大盘上信息量太薄——船与船连对角都不能碰，
// 一支舰队铺在 8×8 上只占不到三分之一的格子，剩下的都是海，线索又只数得出"这一行几条船格"。
// 实测（scratch 满线索推完率）：7×7 是 7/24，8×8 是 0～1/24，10×10 是 0/24；把档位表里的
// 8×8/10×10 换成 7×7 之后，出题器从"每档 6 个种子要抽空 150 次、单盘 37 秒"变成一秒级。
// 这不是偷懒砍尺寸，是被测量逼停的：反证规则补上之后大盘依然推不动，因为零规矩的盘本来就
// 不唯一，能推到底的那种排法在大盘上几乎不存在。想玩大盘得换线索形式（比如数墙/海战图），
// 那是另一道题。
export const TIERS = [
  { key: 'trainee', name: '初学', w: 4, h: 4, fleet: [3, 2, 1], band: [12, 17], keepRatio: 0.75, tries: 25, budgetMs: 250 },
  { key: 'apprentice', name: '上手', w: 5, h: 5, fleet: [4, 3, 2], band: [22, 29], keepRatio: 0.7, tries: 20, budgetMs: 200 },
  { key: 'regular', name: '熟练', w: 6, h: 6, fleet: [4, 3, 2, 1], band: [27, 36], keepRatio: 0.6, tries: 30, budgetMs: 1600 },
  { key: 'expert', name: '高阶', w: 7, h: 7, fleet: [5, 4, 3, 2, 1], band: [34, 47], keepRatio: 0.7, tries: 35, budgetMs: 3600 },
  { key: 'master', name: '大师', w: 7, h: 7, fleet: [6, 5, 4, 3, 1], band: [44, 56], keepRatio: 0.65, tries: 25, budgetMs: 1600 },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = generate({ ...tier, seed });
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.w}×${tier.h}`,
    w: tier.w,
    h: tier.h,
    fleet: tier.fleet,
  };
}

// solutionOf 供 harness 用：把出题时摆好的舰队转成 owner 数组，verify 不看任何机器只按规则判。
export function solutionOf(board, laid) {
  const out = new Uint8Array(board.size);
  for (let t = 0; t < board.size; t++) out[t] = laid[t] === SHIP ? SHIP : laid[t] === WATER ? WATER : UNKNOWN;
  return out;
}

export { UNKNOWN, SHIP, WATER };
