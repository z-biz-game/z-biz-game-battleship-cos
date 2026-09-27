// 装配层：把引擎、渲染、存档和声音接到同一棵 DOM 上。这里不该有任何规则判断——
// 判胜在 verify，推理由 nextDeduction，进度由 diagnose 给。main.js 只做三件事：
// 把手势翻译成一个 Game 方法、把 state() 抄到 DOM 上、以及在出题的时候让玩家等得起。

import { Palette, applyThemeVars, setReduceMotion, prefersReducedMotion } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierFor, makePuzzle, generate, solutionOf, layout } from './engine/generate.js';
import { countSolutions } from './engine/count.js';
import * as Engine from './engine/ships.js';
import { Game, MODES } from './ui/game.js';
import { BoardView } from './render/board.js';

const VERSION = '1.0.0';
const $ = (sel) => document.querySelector(sel);
const el = {
  canvas: $('#board'),
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  tierList: $('#tier-list'),
  recordList: $('#record-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  btnResume: $('#btn-resume'),
  statName: $('#stat-name'),
  statTier: $('#stat-tier'),
  statFleet: $('#stat-fleet'),
  statTime: $('#stat-time'),
  statShips: $('#stat-ships'),
  statDocked: $('#stat-docked'),
  statRemaining: $('#stat-remaining'),
  statClues: $('#stat-clues'),
  statMoves: $('#stat-moves'),
  statHints: $('#stat-hints'),
  statScore: $('#stat-score'),
  conflict: $('#conflict-line'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  busy: $('#busy-veil'),
  boardWrap: $('#board-wrap'),
};

const view = new BoardView(el.canvas);
let game = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let pulse = null;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const fmtMs = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

function startClock() {
  stopClock();
  startedAt = Date.now();
  ticker = setInterval(() => {
    el.statTime.textContent = fmtMs(clock());
  }, 1000);
}
function stopClock() {
  if (ticker) clearInterval(ticker);
  ticker = 0;
  startedAt = 0;
}

// ---- 画面 ---------------------------------------------------------------------------

function avail() {
  const wide = window.innerWidth > 900;
  const w = el.boardWrap.clientWidth || (wide ? window.innerWidth - 380 : window.innerWidth - 60);
  const h = Math.max(320, Math.min(window.innerHeight - 260, 620));
  return { w, h };
}

function draw(extra) {
  if (!game) return;
  const { w, h } = avail();
  view.resize(game, w, h);
  view.draw(game, { pulse: pulse || null, ...extra });
}

function syncStats() {
  if (!game) return;
  const s = game.state();
  el.statName.textContent = s.name;
  el.statTier.textContent = `${s.size} · 实测 ${tierFor(s.tier).band[0]}–${tierFor(s.tier).band[1]}`;
  el.statFleet.textContent = `舰队 ${s.fleet}`;
  el.statShips.textContent = `${s.ships} / ${s.total}`;
  el.statDocked.textContent = `${s.docked} / ${game.board.fleet.length}`;
  el.statRemaining.textContent = s.remaining ? (s.remaining.join(' ') || '已落位') : '放不下';
  el.statRemaining.classList.toggle('bad', !s.remaining || s.remaining.length > game.board.fleet.length);
  el.statClues.textContent = `${s.clues} / ${game.board.w + game.board.h}`;
  el.statMoves.textContent = String(s.moves);
  el.statHints.textContent = String(s.hints);
  el.hintCount.textContent = String(s.hints);
  el.statScore.textContent = s.score.toFixed(1);
  el.conflict.textContent = game.conflictLine();
  el.statTime.textContent = fmtMs(clock());
}

function afterStep(soundKey) {
  if (soundKey) Sound[soundKey]?.();
  if (game && game.diag.conflicts > 0) Sound.conflict();
  syncStats();
  draw();
  if (game && game.status === 'won') onWin();
  else if (game) Store.saveResume(game.puzzle, game, clock());
}

// ---- 对局生命周期 ---------------------------------------------------------------------

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    renderMenu();
  } else {
    draw();
  }
}

// 换一局必须真的换一张盘。默认种子曾经是按日期算的（bs-trainee2026928），于是同一天里连按两次
// 「新的一局」交出的是同一张——按钮写着换，做的事是没换。随机只允许发生在**挑种子**这一步：
// 生成器仍然只吃 seed，墙钟或 Math.random 一旦进了生成器内部，"同一个 seed 画同一张盘"当场破，
// 而存档只记 seed，恢复就会变成另一张图。
let drawNo = 0;
function freshSeed(tierKey) {
  const r = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `bs|${tierKey}|${++drawNo}|${r}`;
}

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const puzzle = makePuzzle(seed || freshSeed(tier), tier);
  if (!puzzle) return null;
  game = new Game(puzzle);
  game.mode = resume?.mode || 'ship';
  el.canvas.dataset.mode = game.mode;
  el.winVeil.hidden = true;
  el.winRecord.textContent = '';
  baseElapsed = resume?.elapsedMs || 0;
  if (resume?.ink) game.load(Store.resumeCells(resume));
  else game.recompute();
  game.moves = resume?.moves || 0;
  game.hints = resume?.hints || 0;
  pulse = null;
  el.hintRule.textContent = '按「提示」要一条当下成立的推理';
  el.hintLine.textContent = '';
  startClock();
  show('game');
  syncStats();
  setModeButtons();
  draw();
  return game;
}

// 出题是要等的事：实测 p95 到 2 秒级（见 tools/balance.mjs 的 budgetMs）。同步跑会把
// 按钮"点下去没反应"变成事实，所以先让一帧过去，把"声呐扫描中"画出来再抽盘。
function beginAsync(opts) {
  el.busy.hidden = false;
  document.body.dataset.busy = '1';
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const got = begin(opts);
        el.busy.hidden = true;
        document.body.dataset.busy = '0';
        resolve(got);
      }),
    );
  });
}

function onWin() {
  stopClock();
  const ms = clock();
  const s = game.state();
  Store.recordSolve(ms, s.hints);
  const better = Store.recordBest(s.tier, { ms, hints: s.hints, moves: s.moves, size: s.size });
  Store.clearResume();
  Sound.win();
  el.winMeta.textContent = `${s.size} · 舰队 ${s.fleet} · ${fmtMs(ms)} · ${s.moves} 步 · ${s.hints} 提示 · 实测难度 ${s.score.toFixed(1)}`;
  el.winRecord.textContent = better ? '新纪录' : '';
  el.winVeil.hidden = false;
  draw();
}

function useHint() {
  if (!game || game.status === 'won') return null;
  const got = game.hint();
  // 分岔看的是 `rule` 而不是 `cells`：nextDeduction 报矛盾时也带 cells（那是要标红的格子），
  // 按 cells 判会让下面读 got.rule.name 直接炸掉——玩家把一行写超之后按「提示」就白屏。
  if (got.rule) {
    pulse = got;
    Sound.hint();
    el.hintRule.textContent = `规则「${got.rule.name}」：${got.rule.note}`;
    el.hintLine.textContent = got.why || '';
  } else {
    el.hintRule.textContent = got.conflict ? '这一盘和题面打架了' : '推不动了';
    el.hintLine.textContent = got.text || '';
    if (got.conflict) {
      pulse = { kind: 'conflict', cells: got.cells || [] };
      Sound.conflict();
    }
  }
  syncStats();
  draw();
  // 提示自己也能把最后一条船补上：判胜走的是 Game.checkWin（引擎 verify），但"赢了之后要做的事"
  // 停在 UI 这边。漏了这一句就会出现"盘面已经合法、钟还在走、成绩没记、胜利卡片没弹"——
  // 这正是这个品类最难看的一类 bug，所以它由 headless 的 hint 场景专门盯。
  if (game && game.status === 'won') onWin();
  return got;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (step) {
    Sound.undo();
    pulse = null;
    syncStats();
    draw();
  }
  return step;
}

function setMode(mode) {
  if (!game || !MODES[mode]) return game?.mode;
  game.mode = mode;
  el.canvas.dataset.mode = mode;
  setModeButtons();
  return mode;
}

function setModeButtons() {
  for (const m of ['ship', 'water', 'cycle']) {
    $(`#btn-mode-${m}`).classList.toggle('is-on', game?.mode === m);
  }
}

// ---- 手势：一个手势一份快照，落到 Game 上 --------------------------------------------

const stroke = { active: false, cells: [], erase: false };

el.canvas.addEventListener('pointerdown', (e) => {
  if (!game || game.status === 'won') return;
  const t = view.hitCell(e.clientX, e.clientY);
  if (t < 0) return;
  e.preventDefault();
  el.canvas.setPointerCapture?.(e.pointerId);
  stroke.active = true;
  stroke.erase = e.button === 2 || game.mode === 'cycle';
  stroke.cells = [t];
  if (game.mode === 'cycle') {
    const got = game.tap(t);
    finishStroke(got);
    stroke.active = false;
  }
});

el.canvas.addEventListener('pointermove', (e) => {
  if (!stroke.active || !game) return;
  const t = view.hitCell(e.clientX, e.clientY);
  if (t >= 0 && stroke.cells[stroke.cells.length - 1] !== t) stroke.cells.push(t);
  draw();
});

const finish = (e) => {
  if (!stroke.active || !game) return;
  stroke.active = false;
  const list = stroke.cells;
  if (list.length > 1) {
    const got = stroke.erase ? game.erase(list) : game.paint(list);
    finishStroke(got);
  } else {
    const got = game.tap(list[0]);
    finishStroke(got);
  }
};
el.canvas.addEventListener('pointerup', finish);
el.canvas.addEventListener('pointercancel', finish);
el.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function finishStroke(got) {
  if (!got) return;
  afterStep(got.kind === 'erase' ? 'erase' : got.kind === 'stroke' ? 'fleet' : 'paint');
}

// ---- 菜单 -----------------------------------------------------------------------------

const TIER_NOTE = {
  trainee: '四条线里的第一条船：邻格即水、满额即水就能收工',
  apprentice: '线内排法开始起作用：一行只有这几种摆法',
  regular: '行列互相牵制，无处落船要连着用',
  expert: '唯一船位与反证都要上手，线索也更稀',
  master: '六条船挤在 7×7：每一格都要先问"放不下就一定是水"',
};

function renderMenu() {
  el.tierList.textContent = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.className = 'tier';
    b.type = 'button';
    b.dataset.tier = t.key;
    b.innerHTML = `<span class="tier-name">${t.name}</span><span class="tier-size mono">${t.w}×${t.h} · 实测 ${t.band[0]}–${t.band[1]}</span><span class="tier-note">${TIER_NOTE[t.key] || ''}</span>`;
    b.addEventListener('click', () => beginAsync({ tier: t.key }));
    el.tierList.appendChild(b);
  }

  el.recordList.textContent = '';
  const rows = TIERS.map((t) => ({ t, best: Store.best(t.key) })).filter((r) => r.best);
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有成绩。赢一局就有了。';
    el.recordList.appendChild(li);
  }
  for (const { t, best } of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${t.name} ${best.size}</span><b>${fmtMs(best.ms)} · ${best.moves} 步 · ${best.hints} 提示</b>`;
    el.recordList.appendChild(li);
  }

  const r = Store.resume();
  if (r && !game) {
    const tier = tierFor(r.tier);
    el.resumeCard.hidden = false;
    el.resumeName.textContent = `${tier.name} 未完成的一局`;
    el.resumeMeta.textContent = `${tier.w}×${tier.h} · ${fmtMs(r.elapsedMs)} · ${r.moves} 步 · ${r.hints} 提示 · seed ${r.seed}`;
    el.btnResume.onclick = () => begin({ tier: r.tier, seed: r.seed, resume: r });
  } else {
    el.resumeCard.hidden = true;
  }
}

function applySettings() {
  const sound = Store.setting('sound') !== false;
  Sound.setEnabled(sound);
  $('#btn-sound').setAttribute('aria-pressed', String(sound));
  $('#btn-sound').textContent = sound ? '声音' : '静音';
  const motion = !!Store.setting('reduceMotion') || prefersReducedMotion();
  setReduceMotion(motion);
  document.body.classList.toggle('reduce-motion', motion);
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
}

// ---- 接线 -----------------------------------------------------------------------------

$('#btn-sound').addEventListener('click', () => {
  const next = Store.setting('sound') === false;
  Store.setSetting('sound', next);
  applySettings();
});
$('#btn-motion').addEventListener('click', () => {
  const next = !Store.setting('reduceMotion');
  Store.setSetting('reduceMotion', next);
  applySettings();
});
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => beginAsync({ tier: game?.puzzle.tier || 'trainee' }));
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => beginAsync({ tier: game?.puzzle.tier || 'trainee' }));
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  renderMenu();
});
for (const m of ['ship', 'water', 'cycle']) $(`#btn-mode-${m}`).addEventListener('click', () => setMode(m));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (el.viewGame.hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'n') beginAsync({ tier: game?.puzzle.tier || 'trainee' });
  else if (k === '1') setMode('ship');
  else if (k === '2') setMode('water');
  else if (k === '3') setMode('cycle');
});
window.addEventListener('resize', () => draw());

applyThemeVars();
applySettings();
renderMenu();

window.battleship = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  show,
  begin,
  beginAsync,
  useHint,
  undo,
  setMode,
  tap: (t) => {
    const got = game?.tap(t);
    finishStroke(got);
    return got;
  },
  paint: (cells) => {
    const got = game?.paint(cells);
    finishStroke(got);
    return got;
  },
  erase: (cells) => {
    const got = game?.erase(cells);
    finishStroke(got);
    return got;
  },
  solveWithLogic: (opts) => game?.solveWithLogic(opts) || null,
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), mode: game.mode, won: game.status === 'won' } : null),
  cellAt: (x, y) => game?.cellAt(x, y) ?? -1,
  valueAt: (t) => game?.valueAt(t) ?? -1,
  conflictLine: () => el.conflict.textContent,
  hintBox: () => ({ rule: el.hintRule.textContent, line: el.hintLine.textContent }),
  engine: {
    ...Engine,
    freshSeed,
    makePuzzle,
    generate,
    solutionOf,
    layout,
    countSolutions,
    TIERS,
    tierFor,
    Game,
    Store,
    MODES,
    theme: Palette,
  },
};
