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
import { FX } from './render/fx.js';

const VERSION = '1.0.0';
const $ = (sel) => document.querySelector(sel);
const el = {
  canvas: $('#board'),
  btnPause: $('#btn-pause'),
  btnSound: $('#btn-sound'),
  btnMotion: $('#btn-motion'),
  btnFullscreen: $('#btn-fullscreen'),
  pauseVeil: $('#pause-veil'),
  pauseTime: $('#pause-time'),
  btnResumePlay: $('#btn-resume-play'),
  btnRestart: $('#btn-restart'),
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
let paused = false;
// 计时标签的节流放在**帧里**而不是 setInterval 里：后台标签的 interval 会被压到 1Hz 以下
// 甚至停掉，回到前台时标签和真实用时之间会差出一截；而 rAF 停在后台本来就是"没在画"，
// 帧恢复时顺手把标签补上，两者天然同步。
let labelAcc = 0;
let lastLabel = 0;

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const fmtMs = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// 计时器只剩"把秒数抄到 DOM 上"这一件事，走钟本身交给帧循环：
// 一个 setInterval 和一个 rAF 各自数时间，是"标签和盘面差一秒"这类 bug 的产地。
function startClock() {
  startedAt = Date.now();
  labelAcc = 1;
}

// ---- 画面 ---------------------------------------------------------------------------

function avail() {
  const wide = window.innerWidth > 900;
  const w = el.boardWrap.clientWidth || (wide ? window.innerWidth - 380 : window.innerWidth - 60);
  const h = Math.max(320, Math.min(window.innerHeight - 260, 620));
  return { w, h };
}

// resize() 会重设 canvas.width —— 那是整块位图的重新分配与清空。原先每个手势都画一帧，
// 现在每帧都画一帧，所以尺寸必须只在真的变了时才重算：否则 60Hz 下每秒分配 60 次画布，
// "帧率无关"这条还没验证，先把浏览器验证掉了。
let sizeKey = '';

function draw() {
  if (!game) return;
  const { w, h } = avail();
  const key = `${w}x${h}x${Math.round((window.devicePixelRatio || 1) * 100)}`;
  if (key !== sizeKey) {
    sizeKey = key;
    view.resize(game, w, h);
  }
  view.draw(game);
}

// 一帧最多走 50ms：切去后台十分钟再回来，那一段不该折算成"扫掠转了 80 圈"。
const MAX_DT = 0.05;
// 哨兵是 -1 而不是 0：rAF 的第一帧时间戳在沙箱/新导航里就是 0，拿 0 当"还没跑过"会让
// 第一帧算出 dt=0，那一帧的仿真量凭空消失（对拍时表现为"60Hz 少一步"）。
let lastTs = -1;
let rafId = 0;

function frame(ts) {
  rafId = requestAnimationFrame(frame);
  const dt = lastTs < 0 ? 0 : Math.min(MAX_DT, Math.max(0, (ts - lastTs) / 1000));
  lastTs = ts;
  if (!game || paused) return;
  FX.update(dt);
  labelAcc += dt;
  const ms = clock();
  if (labelAcc >= 1 || ms - lastLabel >= 900) {
    labelAcc = 0;
    lastLabel = ms;
    const s = fmtMs(ms);
    if (s !== el.statTime.textContent) el.statTime.textContent = s;
  }
  draw();
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

// 走钟只有一处真相：baseElapsed 是"已经折进来的那段"，startedAt 是"正在走的那段"。
// 停钟必须先把它折进去再清 startedAt——原先的 stopClock() 只清不折，于是 onWin() 里
// `stopClock(); const ms = clock()` 读到的是 baseElapsed，而一整局的用时恰好就是被清掉
// 的那一段：桌面上从头赢到尾，成绩记的是 00:00。
function freezeClock() {
  if (startedAt) {
    baseElapsed += Date.now() - startedAt;
    startedAt = 0;
  }
}
function runClock() {
  if (!startedAt && game && game.status !== 'won' && !paused) startedAt = Date.now();
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    // 回到海图不是暂停的同义词，但它必须**保得住**这段用时：折进 baseElapsed，
    // 等 show('game') 再续上。少了这一折，"看一眼规则"就等于白送这段时间。
    freezeClock();
    renderMenu();
  } else {
    runClock();
    draw();
  }
}

// 暂停：停钟、停仿真、挡住手势，三样都得做，而且都由同一个 `paused` 决定。
// 少任何一样就是"假暂停"——钟还在走的那一种，玩家用暂停来去倒杯水，回来成绩里
// 多了五分钟，这个功能就成了惩罚。
function setPaused(v = !paused) {
  if (!game || game.status === 'won') return paused;
  const next = !!v;
  if (next === paused) return paused;
  paused = next;
  if (paused) {
    stroke.active = false;
    stroke.cells = [];
    freezeClock();
    el.pauseTime.textContent = fmtMs(clock());
  } else {
    runClock();
    draw();
  }
  el.pauseVeil.hidden = !paused;
  el.btnPause.setAttribute('aria-pressed', String(paused));
  el.btnPause.textContent = paused ? '继续' : '暂停';
  el.canvas.setAttribute('aria-hidden', String(paused));
  return paused;
}

// 全屏：iOS Safari 到今天都没有 requestFullscreen，所以这里必须问的是"这个元素能不能"，
// 而不是假设标准方法在。不能就把按钮置灰并说明原因——一个按了没反应的按钮比没有更糟。
const fsApi = () => {
  const doc = document;
  const host = doc.documentElement;
  return {
    el: doc.fullscreenElement || doc.webkitFullscreenElement || null,
    req: host.requestFullscreen || host.webkitRequestFullscreen || host.webkitRequestFullScreen || null,
    exit: doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen || null,
  };
};

function toggleFullscreen() {
  const api = fsApi();
  // 检查的是**这一步要用的那个方法**在不在：iOS Safari 上 document.exitFullscreen 有可能在、
  // 元素上却没有 requestFullscreen，"两个都不在才算不支持"的 || 兜法会在按下时抛 TypeError，
  // 按钮就此变成"点了什么也不发生、只是不报错"。
  const act = api.el ? api.exit : api.req;
  if (!act) return false;
  const p = act.call(api.el ? document : document.documentElement, { navigationUI: 'hide' });
  p?.catch?.(() => {});
  return true;
}

function syncFullscreenButton() {
  const api = fsApi();
  // 判的是"这一步能不能做成"：没全屏时按钮要的是 requestFullscreen，已经全屏时是 exitFullscreen。
  // 用 || 把两个方法混起来判，遇到只有 document.exitFullscreen 的环境会把一个按了没反应的按钮留着。
  const supported = api.el ? !!api.exit : !!api.req;
  el.btnFullscreen.disabled = !supported;
  el.btnFullscreen.classList.toggle('is-on', !!api.el);
  el.btnFullscreen.setAttribute('aria-pressed', String(!!api.el));
  el.btnFullscreen.textContent = api.el ? '退出全屏' : '全屏';
  if (!supported) el.btnFullscreen.title = '这个浏览器不提供页面全屏';
}

for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, syncFullscreenButton);
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
  // 先把**上一局**正在走的那段折掉，再动 baseElapsed：反了的话上一局的几分钟会被算进这一局。
  freezeClock();
  game = new Game(puzzle);
  game.mode = Object.hasOwn(MODES, resume?.mode) ? resume.mode : 'ship';
  el.canvas.dataset.mode = game.mode;
  el.winVeil.hidden = true;
  el.winRecord.textContent = '';
  paused = false;
  el.pauseVeil.hidden = true;
  el.btnPause.setAttribute('aria-pressed', 'false');
  el.btnPause.textContent = '暂停';
  baseElapsed = resume?.elapsedMs || 0;
  const ink = resume ? Store.resumeCells(resume) : null;
  if (ink) game.load(ink);
  else game.recompute();
  game.moves = resume?.moves || 0;
  game.hints = resume?.hints || 0;
  // 重开一局要清的不只是盘面：上一笔没抬起来的手指、上一局的提示余辉和还没散完的波，
  // 留着就是"新的一局"里带着旧的一局的残影（而 stroke.active 留在 true 会让下一次
  // pointerup 把整串旧格子再刷一遍）。
  stroke.active = false;
  stroke.cells = [];
  stroke.erase = false;
  FX.reset();
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

// 重开 = 同一张题面（同一个 seed）从零再来；新的一局 = 换一张题面。这两件事原先只有一个按钮，
// 于是"这盘我推到一半想重来一遍同一条推理链"没有入口——而那正是这个品类最常见的诉求。
function restart() {
  if (!game) return null;
  const p = game.puzzle;
  Store.clearResume();
  return beginAsync({ tier: p.tier, seed: p.originSeed || p.seed });
}

function onWin() {
  // 先折钟再读数：顺序反了，整局用时会被算成 0（见 freezeClock 上面那段）。
  paused = false;
  el.pauseVeil.hidden = true;
  freezeClock();
  const ms = clock();
  const s = game.state();
  Store.recordSolve(ms, s.hints);
  const better = Store.recordBest(s.tier, { ms, hints: s.hints, moves: s.moves, size: s.size });
  Store.clearResume();
  Sound.win();
  FX.ripple();
  el.winMeta.textContent = `${s.size} · 舰队 ${s.fleet} · ${fmtMs(ms)} · ${s.moves} 步 · ${s.hints} 提示 · 实测难度 ${s.score.toFixed(1)}`;
  el.winRecord.textContent = better ? '新纪录' : '';
  el.winVeil.hidden = false;
  draw();
}

function useHint() {
  if (!game || game.status === 'won' || paused) return null;
  const got = game.hint();
  // 分岔看的是 `rule` 而不是 `cells`：nextDeduction 报矛盾时也带 cells（那是要标红的格子），
  // 按 cells 判会让下面读 got.rule.name 直接炸掉——玩家把一行写超之后按「提示」就白屏。
  if (got.rule) {
    FX.flash(got.cells || [], got.kind || 'ship');
    Sound.hint();
    el.hintRule.textContent = `规则「${got.rule.name}」：${got.rule.note}`;
    el.hintLine.textContent = got.why || '';
  } else {
    el.hintRule.textContent = got.conflict ? '这一盘和题面打架了' : '推不动了';
    el.hintLine.textContent = got.text || '';
    if (got.conflict) {
      FX.flash(got.cells || [], 'conflict');
      Sound.conflict();
    }
  }
  syncStats();
  draw();
  // 提示写了格子、也抬了 hints 计数，这两样都得落盘：原先只有 afterStep（落子/擦除）会存，
  // 于是"点一次提示就刷新"能把那一格连同那次提示免费抹掉——存档里的 hints 比实际少，
  // 而这正是这个品类最贵的东西（成绩与推理链）。
  if (game && got.charged) Store.saveResume(game.puzzle, game, clock());
  // 提示自己也能把最后一条船补上：判胜走的是 Game.checkWin（引擎 verify），但"赢了之后要做的事"
  // 停在 UI 这边。漏了这一句就会出现"盘面已经合法、钟还在走、成绩没记、胜利卡片没弹"——
  // 这正是这个品类最难看的一类 bug，所以它由 headless 的 hint 场景专门盯。
  if (game && game.status === 'won') onWin();
  return got;
}

function undo() {
  if (!game || paused) return null;
  const step = game.undo();
  if (step) {
    Sound.undo();
    FX.clear();
    syncStats();
    draw();
    // 撤销同样改了盘（还动了 moves 计数）：不落盘的话"撤销后刷新"会把刚擦掉的格子还回来。
    Store.saveResume(game.puzzle, game, clock());
  }
  return step;
}

function setMode(mode) {
  // MODES.cycle 的值是 UNKNOWN=0，用真值判断会把「循环」模式当成非法输入吃掉：必须按属性存在性判。
  if (!game || !Object.hasOwn(MODES, mode)) return game?.mode;
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
  if (!game || game.status === 'won' || paused) return;
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

// 这里刻意不画：帧循环每秒画 60 次，而 touchmove 每秒可以报上百次。
// 手势自己再 draw() 一遍，等于把"每次移动重画整盘"重新引进来。
el.canvas.addEventListener('pointermove', (e) => {
  if (!stroke.active || !game) return;
  const t = view.hitCell(e.clientX, e.clientY);
  if (t >= 0 && stroke.cells[stroke.cells.length - 1] !== t) stroke.cells.push(t);
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
  if (game && game.status !== 'won') {
    // 从对局页回到海图，必须还回得去。原先这张卡的条件是 `r && !game`，于是"打一局 →
    // 点海图想看规则 → 卡片消失"——回不去那一局，只能重开。看一眼规则不该是弃权。
    const s = game.state();
    el.resumeCard.hidden = false;
    el.resumeName.textContent = '回到正在推的这一局';
    el.resumeMeta.textContent = `${tierFor(s.tier).name} · ${s.size} · ${fmtMs(clock())} · ${s.moves} 步 · ${s.hints} 提示`;
    el.btnResume.onclick = () => show('game');
  } else if (r) {
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
  el.btnSound.setAttribute('aria-pressed', String(sound));
  el.btnSound.textContent = sound ? '声音' : '静音';
  const motion = !!Store.setting('reduceMotion') || prefersReducedMotion();
  setReduceMotion(motion);
  document.body.classList.toggle('reduce-motion', motion);
  const fromSystem = motion && !Store.setting('reduceMotion');
  // 按钮反映**生效态**（系统地板 + 游戏内开关），不是只反映游戏内开关：系统已经要求减弱时
  // 画面是不动的，按钮却显示"没开"，玩家会觉得这个开关坏了、或按了没反应。
  el.btnMotion.setAttribute('aria-pressed', String(motion));
  el.btnMotion.title = fromSystem ? '系统偏好里已开启减弱动效' : motion ? '游戏内已开启减弱动效' : '动效全开';
  // 减弱动效在这里有一个真的分支要跑：背景扫掠与余辉的**推进**关掉，
  // 而提示点名的那层颜色留着（它退成一张静图，不是退成"没有"）——见 fx.js 的 pulseAlpha。
  FX.setEnabled(!motion);
}

// 静音是这个游戏里唯一一个"必须能证明它真的停了"的开关：只看按钮文字的话，
// `gain=0` 和 `suspend()` 长得一模一样，而前者什么电都在耗。读数由 Sound.stats() 给。
function toggleSound() {
  Store.setSetting('sound', Store.setting('sound') === false);
  applySettings();
  return Store.setting('sound') !== false;
}

// ---- 接线 -----------------------------------------------------------------------------

el.btnSound.addEventListener('click', toggleSound);
el.btnMotion.addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
el.btnPause.addEventListener('click', () => setPaused());
el.btnResumePlay.addEventListener('click', () => setPaused(false));
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-new').addEventListener('click', () => beginAsync({ tier: game?.puzzle.tier || 'trainee' }));
el.btnRestart?.addEventListener('click', () => restart());
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => beginAsync({ tier: game?.puzzle.tier || 'trainee' }));
el.btnFullscreen.addEventListener('click', () => {
  toggleFullscreen();
  // 状态由 fullscreenchange 事件同步，而不是在这里猜：标准允许用户在 Esc 或系统手势里
  // 退出全屏，写在按钮里的第二套真相一定会和它打架。
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  renderMenu();
});
for (const m of ['ship', 'water', 'cycle']) $(`#btn-mode-${m}`).addEventListener('click', () => setMode(m));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // 焦点在按钮上时，空格/回车是"按下这个按钮"，不是"暂停"。两条规则抢同一个键，
  // 输的必须是键盘用户——所以这里让路，而不是 preventDefault 之后各做各的。
  const tag = e.target?.tagName;
  if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'A')) return;
  const k = e.key.toLowerCase();
  if (k === 'm') {
    toggleSound();
    return;
  }
  if (k === 'f') {
    toggleFullscreen();
    return;
  }
  if (k === '?') {
    show('menu');
    return;
  }
  if (el.viewGame.hidden) {
    if (k === 'enter') beginAsync({ tier: 'trainee' });
    return;
  }
  if (k === 'h') useHint();
  else if (k === 'z') undo();
  else if (k === 'n') beginAsync({ tier: game?.puzzle.tier || 'trainee' });
  else if (k === 'r') restart();
  else if (k === 'p' || k === ' ') { e.preventDefault(); setPaused(); }
  else if (k === 'escape') setPaused(false);
  else if (k === '1') setMode('ship');
  else if (k === '2') setMode('water');
  else if (k === '3') setMode('cycle');
});
window.addEventListener('resize', () => draw());

// manifest 的两个 shortcut 指向 ./#new 与 ./#resume。它们承诺的事得在这里兑现，
// 否则长按图标弹出的菜单就是一个进去什么也不发生的入口——那是比没有快捷方式更糟。
function handleHash() {
  const h = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  if (!h) return;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* file:// 下某些实现不让改历史：快捷方式照样生效，只是再刷新会重跑一次 */
  }
  const r = Store.resume();
  if (h === 'new') beginAsync({ tier: game?.puzzle.tier || 'trainee' });
  else if (h === 'resume') {
    if (game && game.status !== 'won') show('game');
    else if (r) begin({ tier: r.tier, seed: r.seed, resume: r });
    else show('menu');
  }
}
window.addEventListener('hashchange', handleHash);

applyThemeVars();
applySettings();
syncFullscreenButton();
renderMenu();
handleHash();
// 帧循环从第一帧就开着，而不是等有局才开：菜单页那张海平线图是静态的，而"进了一局
// 才开始转"会让扫掠在开局瞬间跳一次（它从 0 角起转），玩家看到的是一下子变了天。
rafId = requestAnimationFrame(frame);

window.battleship = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  get paused() {
    return paused;
  },
  show,
  begin,
  beginAsync,
  restart,
  setPaused,
  toggleFullscreen,
  toggleSound,
  useHint,
  undo,
  setMode,
  fx: () => FX.state(),
  fxUpdate: (dt) => FX.update(dt),
  soundStats: () => Sound.stats(),
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
  state: () => (game ? { ...game.state(), elapsedMs: clock(), mode: game.mode, won: game.status === 'won', paused } : null),
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
