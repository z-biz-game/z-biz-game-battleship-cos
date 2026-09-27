// 难度实测台。跑法：node tools/balance.mjs [每档种子数]
//
// 这个脚本只干一件事：把"这一档到底有多难"从口味变成数字。分数是 solveWithRules 按
// 规则权重累加出来的（见 ships.js 的 RULES），档位表里的 band 必须是这里量出来的分位数，
// 不是手填的。band 一旦和实测脱节（改了规则权重、换了舰队、动了 keepRatio），CI 就该红。
//
// 还量两件事：出题命中率（低于 100% 就不能上线，UI 会拿到 null）和单盘墙钟。墙钟的分布是
// **双峰**的：一次就抽中的盘只要 1ms，烧到 tries 上限的盘要三秒——所以"中位"根本代表不了
// 玩家等多久，budgetMs 记的是**实测 p95 基线**，门禁盯的是"比基线慢了一倍"这种回归。
// 绝对值（中位/p95/最慢/最多抽几次）每次都打出来给人看，不藏进任何比值里。
// 同一种子必须画出同一张盘，这是存档只记 seed 的前提。

import { generate, TIERS, makePuzzle } from '../js/engine/generate.js';
import { verify } from '../js/engine/ships.js';
import { countSolutions } from '../js/engine/count.js';

const N = Number(process.env.SAMPLES || process.argv[2] || 24);
const HEADROOM = Number(process.env.HEADROOM || 2);
const BAND_DRIFT = 0.35;

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))] : NaN);
const fmt = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '—');

let bad = 0;
const fail = (msg) => {
  bad++;
  console.log(`FAIL  ${msg}`);
};

console.log(`每档 ${N} 个种子\n`);
for (const tier of TIERS) {
  const cands = [];
  const accepted = [];
  const times = [];
  const rejects = {};
  const reasons = [];
  let hits = 0;
  let drawn = 0;
  const draws = [];
  for (let s = 0; s < N; s++) {
    const seed = `b${s}`;
    const t0 = performance.now();
    const r = generate({
      ...tier,
      seed,
      report: (e) => {
        if (e.stage === 'ready') cands.push(e.score);
        else rejects[e.reason || e.stage] = (rejects[e.reason || e.stage] || 0) + 1;
      },
    });
    times.push(performance.now() - t0);
    drawn += r.drawn || 0;
    draws.push(r.drawn || 0);
    if (!r.ok) {
      reasons.push(`${seed}: ${r.reason}`);
      continue;
    }
    hits++;
    accepted.push({ score: r.score, clues: r.clues, steps: r.steps, breakdown: r.breakdown });
  }

  cands.sort((a, b) => a - b);
  const scores = accepted.map((a) => a.score).sort((a, b) => a - b);
  const timesSorted = times.slice().sort((a, b) => a - b);
  const drawsSorted = draws.slice().sort((a, b) => a - b);
  const inBand = accepted.filter((a) => a.score >= tier.band[0] && a.score <= tier.band[1]).length;
  const median = q(scores, 0.5);
  const lo = q(scores, 0.15);
  const hi = q(scores, 0.85);

  console.log(`【${tier.name} ${tier.key}】${tier.w}×${tier.h} 舰队 ${tier.fleet.join('/')}  保留 ${tier.keepRatio}`);
  console.log(
    `  命中 ${hits}/${N}  平均抽 ${(drawn / Math.max(1, hits)).toFixed(1)} 次（最坏 ${q(drawsSorted, 1)}/${tier.tries}）  分数 ${fmt(q(scores, 0))}–${fmt(q(scores, 0.15))}–${fmt(median)}–${fmt(q(scores, 0.85))}–${fmt(q(scores, 1))}`,
  );
  console.log(
    `  候选 ${cands.length} 个，其中落带 ${inBand}/${accepted.length}  线索 ${(accepted.reduce((a, x) => a + x.clues, 0) / Math.max(1, accepted.length)).toFixed(1)}/${tier.w + tier.h}  出题墙钟 中位 ${fmt(q(timesSorted, 0.5))}ms  p95 ${fmt(q(timesSorted, 0.95))}ms  最慢 ${fmt(q(timesSorted, 1))}ms（门禁：p95 ≤ 基线 ${tier.budgetMs} × ${HEADROOM} = ${tier.budgetMs * HEADROOM}ms）`,
  );
  console.log(`  实测建议带 [${fmt(lo)}, ${fmt(hi)}]，档位表写的是 [${tier.band.join(', ')}]`);
  if (Object.keys(rejects).length) console.log(`  淘汰：${Object.entries(rejects).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  const rules = {};
  for (const a of accepted) for (const [k, v] of Object.entries(a.breakdown || {})) rules[k] = (rules[k] || 0) + v;
  console.log(`  用到的规则：${Object.entries(rules).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  reasons.slice(0, 3).forEach((r) => console.log(`  ${r}`));

  if (hits < N) fail(`${tier.key} 命中率 ${hits}/${N}：UI 会拿到空盘`);
  const budget = tier.budgetMs * HEADROOM;
  if (q(timesSorted, 0.95) > budget) fail(`${tier.key} p95 ${fmt(q(timesSorted, 0.95))}ms 超过实测基线 ${tier.budgetMs}ms 的 ${HEADROOM} 倍——出题变慢了，去查 tries / keepRatio / 规则改动`);
  if (inBand < Math.ceil(accepted.length * 0.5)) fail(`${tier.key} 落带率 ${inBand}/${accepted.length} 太低，band 和实测脱节`);
  if (Math.abs(median - (tier.band[0] + tier.band[1]) / 2) > ((tier.band[1] - tier.band[0]) / 2) * (1 + BAND_DRIFT)) {
    fail(`${tier.key} 中位 ${fmt(median)} 偏离带心 ${(tier.band[0] + tier.band[1]) / 2} 超过 ${BAND_DRIFT * 100}%`);
  }
}

// 分数必须随档位单调上升，否则"高阶"只是个名字。
const meds = TIERS.map((t) => {
  const s = [];
  for (let k = 0; k < 6; k++) {
    const r = generate({ ...t, seed: `m${k}` });
    if (r.ok) s.push(r.score);
  }
  s.sort((a, b) => a - b);
  return q(s, 0.5);
});
for (let i = 1; i < meds.length; i++) {
  if (!(meds[i] > meds[i - 1])) fail(`档位分数不单调：${TIERS[i - 1].key} ${fmt(meds[i - 1])} → ${TIERS[i].key} ${fmt(meds[i])}`);
}
console.log(`\n档位中位数阶梯：${meds.map(fmt).join(' < ')}`);

// 同一个 seed 必须画同一张盘：存档只记 seed，恢复对局靠这个。
for (const t of TIERS) {
  const a = makePuzzle('determinism', t.key);
  const b = makePuzzle('determinism', t.key);
  if (!a || !b) {
    fail(`${t.key} makePuzzle 返回空`);
    continue;
  }
  const same = JSON.stringify(a.spec.rows) === JSON.stringify(b.spec.rows) && JSON.stringify(a.spec.cols) === JSON.stringify(b.spec.cols);
  if (!same) fail(`${t.key} 同一个 seed 画出两张盘，存档没法恢复对局`);
  if (!verify(a.board, a.solution).ok) fail(`${t.key} 交出来的盘过不了独立验胜`);
  if (countSolutions(a.board, { cap: 2, budget: 200_000 }).status !== 'UNIQUE') fail(`${t.key} 交出来的盘不唯一`);
}

console.log(bad ? `\nFAILED ${bad}` : '\n难度带、命中率、时延、确定性都合格');
process.exit(bad ? 1 : 0);
