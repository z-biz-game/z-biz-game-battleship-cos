// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。
//
// 这里只认三种证据：DOM 的矩形、画布的像素、指针事件打进去之后的读数。`.hidden` 说的是
// 代码想干什么，clientRect 和一个像素说的是玩家拿到了什么。这局最难看的 bug 恰好都是
// "引擎里对，屏幕上错"：船在 engine 里躺着、画布上看不见，或者线索画在了偏一格的列上。
//
// window.battleship.engine 就是玩家加载的那份模块图，所以这里绿一次，等于玩家那侧的
// 出题器/推理机/独立计数器同时绿一次。引擎常量都在场景函数**内部**取——这个文件注入的
// 时机比 app 的模块执行还早，那时 window.battleship 还不存在。

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `${got} vs ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.battleship;
  const E = () => w.battleship.engine;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- 真手势 ----------------------------------------------------------------

  function pointer(type, x, y, button = 0) {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button,
      clientX: x,
      clientY: y,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }

  const center = (t) => {
    const r = A().view.cellRect(t);
    const box = A().view.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.w / 2, y: box.top + r.y + r.h / 2 };
  };

  async function tap(t, button = 0) {
    const p = center(t);
    pointer('pointerdown', p.x, p.y, button);
    await wait(16);
    pointer('pointerup', p.x, p.y, button);
    await wait(16);
  }

  async function drag(list, button = 0) {
    const a = center(list[0]);
    pointer('pointerdown', a.x, a.y, button);
    for (const t of list) {
      const p = center(t);
      pointer('pointermove', p.x, p.y, button);
      await wait(6);
    }
    const z = center(list[list.length - 1]);
    pointer('pointerup', z.x, z.y, button);
    await wait(24);
  }

  // 画布像素：ctx 被 dpr 缩过，cellRect 是 CSS 像素，所以取样必须乘 dpr。
  function pixel(t) {
    const { ctx } = A().view;
    const r = A().view.cellRect(t);
    const d = A().view.geo.dpr;
    const x = Math.round((r.x + r.w / 2) * d);
    const y = Math.round((r.y + r.h / 2) * d);
    const p = ctx.getImageData(x, y, 1, 1).data;
    return [p[0], p[1], p[2]];
  }

  const rgb = (hex) => {
    const h = hex.replace('#', '');
    const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };

  const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

  // 把当前这局推到"引擎认为该赢"的那一步：只用玩家按得出来的动作（paint），
  // 不直接改引擎状态——否则场景验的是测试代码，不是玩家能走的路。
  function fillToSolution() {
    const g = A().game;
    const sol = g.puzzle.solution;
    const SHIP = E().SHIP;
    const painted = [];
    for (let t = 0; t < sol.length; t++) if (sol[t] === SHIP && g.st.cells[t] !== SHIP) painted.push(t);
    A().setMode('ship');
    A().paint(painted);
    return painted;
  }

  const ng = {};

  // 1. 引擎在浏览器里也必须成立：唯一解、推得完、每条推论和出题那支舰队逐格同色。
  ng.engine = async () => {
    const { makePuzzle, countSolutions, verify, createState, nextDeduction, applyDeduction, solveWithRules, SHIP, TIERS } = E();
    for (const tier of TIERS) {
      const p = makePuzzle('scen-engine', tier.key);
      if (!p) {
        ck(`${tier.key} 出得了盘`, false, 'makePuzzle 返回 null');
        continue;
      }
      ck(`${tier.key} 独立计数唯一`, countSolutions(p.board, { cap: 2, budget: 200_000 }).status === 'UNIQUE');
      ck(`${tier.key} 验胜收正解`, verify(p.board, p.solution).ok, verify(p.board, p.solution).reason);
      ck(`${tier.key} 推得完`, solveWithRules(createState(p.board), { cap: 4000 }).ok);
      const st = createState(p.board);
      let wrong = null;
      for (let k = 0; k < 4000; k++) {
        const d = nextDeduction(st);
        if (!d) break;
        if (d.stalled) {
          wrong = d.why;
          break;
        }
        for (const t of d.cells) {
          if (d.kind === 'ship' && p.solution[t] !== SHIP) wrong = `${d.rule.name} 判 ${t} 是船，正解里是水`;
          if (d.kind === 'water' && p.solution[t] === SHIP) wrong = `${d.rule.name} 判 ${t} 是水，正解里躺着船`;
        }
        if (wrong) break;
        applyDeduction(st, d);
      }
      ck(`${tier.key} 推论与正解同色`, !wrong, wrong);
      ck(`${tier.key} 线索抹过`, p.clues < tier.w + tier.h, `${p.clues}/${tier.w + tier.h}`);
    }
    return report({ tier: 'engine' });
  };

  // 2. 每一档都开得出局，分数落在实测带里，而且画布上真的有墨。
  ng.gen = async () => {
    for (const tier of E().TIERS) {
      A().begin({ tier: tier.key, seed: `gen-${tier.key}` });
      const s = A().state();
      eq(`${tier.key} 尺寸`, s.size, `${tier.w || tier.w}×${tier.h}`.replace(`${tier.w}×${tier.h}`, `${tier.w}×${tier.h}`));
      ck(`${tier.key} 分数在带内`, s.score >= tier.band[0] && s.score <= tier.band[1], `${s.score} vs ${tier.band}`);
      ck(`${tier.key} 舰队对`, s.fleet === tier.fleet.slice().sort((a, b) => b - a).join('/'), s.fleet);
      const g = A().game;
      const ink = [...g.puzzle.solution].filter((v) => v === E().SHIP).length;
      eq(`${tier.key} 盘上船格数`, ink, g.board.total);
      ck(`${tier.key} 开局无冲突`, g.diag.conflicts === 0, g.diag.conflicts);
      const { ctx } = A().view;
      ck(`${tier.key} 画布有尺寸`, A().view.canvas.width > 100 && ctx.getTransform().a > 0);
    }
    return report({ tier: 'gen' });
  };

  // 3. 玩家真的用鼠标下一局：拖一条线、超线索要报错、把正解刷满必须判胜并弹卡片。
  ng.play = async () => {
    A().begin({ tier: 'apprentice', seed: 'play-1' });
    A().setMode('ship');
    const g = A().game;
    const before = A().state().moves;
    await drag([0, 1, 2]);
    eq('拖过三格落成船', [g.st.cells[0], g.st.cells[1], g.st.cells[2]].join(''), `${E().SHIP}${E().SHIP}${E().SHIP}`);
    ck('拖一条线记一步', A().state().moves === before + 1, `${A().state().moves} vs ${before + 1}`);
    ck('画布上看得见', near(pixel(1), rgb(E().theme.hull)), pixel(1).join(','));

    // 再拖一遍同样的东西：一个墨都没变，所以既不记步也不留快照。
    const same = A().state().moves;
    await drag([0, 1, 2]);
    eq('空手势不记步', A().state().moves, same);

    // 把某行数满之后多写一格：引擎必须说冲突，UI 必须把它念出来。
    const r = g.board.rows.findIndex((v) => v >= 0 && v < g.board.w);
    if (r >= 0) {
      A().setMode('ship');
      const row = [...Array(g.board.w).keys()].map((c) => r * g.board.w + c);
      A().paint(row);
      ck('写超了会说冲突', A().state().conflicts > 0 || text('#conflict-line').length > 0, A().state().conflicts);
    }

    A().begin({ tier: 'apprentice', seed: 'play-win' });
    fillToSolution();
    ck('刷满正解即判胜', A().state().won === true);
    ck('胜利卡片弹出', shown('#win-veil'));
    ck('成绩进了 localStorage', JSON.stringify(w.localStorage.getItem('battleship.save.v1') || '{}').includes('apprentice'));
    return report({ tier: 'play' });
  };

  // 4. 提示必须是一条当下成立的推理，而且计费规矩不许绕：撤销能退步数，退不掉提示。
  ng.hint = async () => {
    A().begin({ tier: 'regular', seed: 'hint-1' });
    const g = A().game;
    const got = A().useHint();
    ck('提示给出推理', !!(got && got.cells && got.cells.length), JSON.stringify(got));
    if (got && got.rule) {
      let agree = true;
      for (const t of got.cells) {
        if (got.kind === 'ship' && g.puzzle.solution[t] !== E().SHIP) agree = false;
        if (got.kind === 'water' && g.puzzle.solution[t] === E().SHIP) agree = false;
      }
      ck('提示与正解同色', agree, `${got.rule.name} ${got.cells.join(',')}`);
      ck('提示写进了引擎', got.cells.every((t) => g.st.cells[t] === (got.kind === 'ship' ? E().SHIP : E().WATER)));
      eq('提示念出规则名', text('#hint-rule').includes(got.rule.name), 'true');
    }
    const h0 = A().state().hints;
    ck('提示计一次数', h0 === 1, h0);
    A().undo();
    eq('撤销不退提示', A().state().hints, h0);
    eq('撤销把墨退了', g.st.cells[got.cells[0]], E().UNKNOWN);

    // 用提示把整局推到底：赢必须被 UI 看见（这是曾经漏过的一句 onWin）。
    let guard = 0;
    while (guard++ < 600 && A().state().status !== 'won') {
      const r = A().useHint();
      if (!r || r.conflict || r.done) break;
    }
    ck('只靠提示也能赢', A().state().status === 'won', `步数 ${A().state().moves} 提示 ${A().state().hints}`);
    ck('提示赢了也弹卡片', shown('#win-veil'));
    return report({ tier: 'hint' });
  };

  // 5. paint 走的是和指针同一个 commit 路径，所以它记步、判胜、也能被撤销。
  ng.paint = async () => {
    A().begin({ tier: 'trainee', seed: 'paint-1' });
    const g = A().game;
    A().setMode('ship');
    const got = A().paint([0, 1]);
    ck('paint 落墨', g.st.cells[0] === E().SHIP && g.st.cells[1] === E().SHIP);
    ck('paint 记步', A().state().moves === 1, A().state().moves);
    ck('paint 返回手势', !!got && got.kind === 'stroke', JSON.stringify(got));
    const nullGot = A().paint([0, 1]);
    ck('重复 paint 是空手势', nullGot === null && A().state().moves === 1, A().state().moves);
    A().undo();
    eq('paint 可撤销', g.st.cells[0], E().UNKNOWN);
    A().undo();
    eq('撤销退到底就是空盘', g.st.cells[1], E().UNKNOWN);
    A().undo();
    ck('退无可退也不炸', A().state().moves === 0);
    return report({ tier: 'paint' });
  };

  // 6. 擦除要花钱：反悔不返还，这是"擦掉重画不能刷步数"的根据。
  ng.erase = async () => {
    A().begin({ tier: 'regular', seed: 'erase-1' });
    const g = A().game;
    A().setMode('ship');
    A().paint([0, 1, 2]);
    const m1 = A().state().moves;
    ck('同种笔再点一次是擦', (() => {
      A().tap(1);
      return g.st.cells[1] === E().UNKNOWN;
    })(), g.st.cells[1]);
    ck('擦除也记一步', A().state().moves === m1 + 1, `${A().state().moves} vs ${m1}`);
    // 没写的格子就是水：把一条船擦掉一格，正解就不该再判胜。
    A().begin({ tier: 'regular', seed: 'erase-win' });
    const g2 = A().game;
    fillToSolution();
    ck('满盘判胜', A().state().won === true);
    const sol = [...g2.puzzle.solution].map((v, t) => (v === E().SHIP ? t : -1)).filter((t) => t >= 0);
    A().erase([sol[0]]);
    ck('擦掉一格就不算赢', A().state().won === false);
    A().paint([sol[0]]);
    ck('补回来又赢了', A().state().won === true);
    const erasedWater = [...Array(g2.board.size).keys()].find((t) => g2.puzzle.solution[t] !== E().SHIP);
    A().erase([erasedWater]);
    ck('擦一个本来就是水的格子是空手势', A().state().won === true);
    return report({ tier: 'erase' });
  };

  // 7. 撤销栈：一个手势一份快照，UI 的步数和引擎的快照必须一一对应。
  ng.undo = async () => {
    A().begin({ tier: 'expert', seed: 'undo-1' });
    const g = A().game;
    const ink0 = [...g.st.cells].filter((v) => v !== E().UNKNOWN).length;
    A().setMode('ship');
    A().paint([0, 1]);
    A().setMode('water');
    A().paint([2, 3, 4]);
    eq('两个手势两份快照', g.st.history.length, 2);
    A().undo();
    eq('退掉最后一个手势', [...g.st.cells].filter((v) => v !== E().UNKNOWN).length, ink0 + 2);
    A().undo();
    eq('退到起点', [...g.st.cells].filter((v) => v !== E().UNKNOWN).length, ink0);
    ck('栈空了', g.st.history.length === 0);
    ck('空手势没有留快照', A().paint([]) === null && g.st.history.length === 0);
    return report({ tier: 'undo' });
  };

  // 8. 存档只许存 seed、花销和墨：盘必须能从种子重画出来。
  ng.save = async () => {
    A().begin({ tier: 'regular', seed: 'save-1' });
    const g = A().game;
    A().setMode('ship');
    A().paint([0, 1, 7]);
    A().useHint();
    await wait(30);
    const raw = JSON.parse(w.localStorage.getItem('battleship.save.v1') || '{}');
    ck('存了档', !!raw.resume, JSON.stringify(Object.keys(raw)));
    eq('存的是 originSeed', raw.resume.seed, 'save-1');
    eq('档位存了', raw.resume.tier, 'regular');
    ck('墨是游程编码', Array.isArray(raw.resume.ink) && raw.resume.ink.length % 2 === 0, JSON.stringify(raw.resume.ink));
    ck('没存盘面', !JSON.stringify(raw).includes('"rows"') && !JSON.stringify(raw.resume).includes('cells":['), JSON.stringify(raw.resume).slice(0, 120));
    const back = E().Store.resumeCells(raw.resume);
    let same = true;
    for (let t = 0; t < g.board.size; t++) if (back[t] !== g.st.cells[t]) same = false;
    ck('墨能原样回来', same);
    eq('花销存住了', raw.resume.moves, A().state().moves);
    ck('best 里有成绩或没有都行', !!raw.best);
    return report({ tier: 'save' });
  };

  // 9. 恢复：同一个 seed 重画同一张题面，再接上原来的墨、步数、提示和计时。
  ng.resume = async () => {
    A().begin({ tier: 'master', seed: 'resume-1' });
    const g = A().game;
    A().setMode('ship');
    A().paint([0, 1]);
    const rowsA = JSON.stringify(g.puzzle.spec.rows);
    const colsA = JSON.stringify(g.puzzle.spec.cols);
    const saved = JSON.parse(w.localStorage.getItem('battleship.save.v1')).resume;
    const moves = A().state().moves;
    A().show('menu');
    A().begin({ tier: saved.tier, seed: saved.seed, resume: saved });
    const again = A().game;
    eq('同一张题面', JSON.stringify(again.puzzle.spec.rows), rowsA);
    eq('同一张题面（列）', JSON.stringify(again.puzzle.spec.cols), colsA);
    eq('墨接上了', A().game.st.cells[0], E().SHIP);
    eq('步数接上了', A().state().moves, moves);
    ck('计时没归零', A().elapsed() >= saved.elapsedMs, `${A().elapsed()} vs ${saved.elapsedMs}`);
    ck('恢复的这一局仍可独立验胜', E().verify(A().game.board, A().game.puzzle.solution).ok);
    return report({ tier: 'resume' });
  };

  // 10. 几何与像素：指针落在哪一格、线索画在哪、主题变量是否真的被应用。
  ng.layout = async () => {
    A().begin({ tier: 'expert', seed: 'layout-1' });
    const g = A().game;
    let hits = 0;
    let miss = null;
    for (let t = 0; t < g.board.size; t++) {
      const p = center(t);
      if (A().view.hitCell(p.x, p.y) === t) hits++;
      else miss = miss || `格 ${t} 点到了 ${A().view.hitCell(p.x, p.y)}`;
    }
    eq('每格的命中都对', hits, g.board.size);
    ck('盘外不落子', A().view.hitCell(2, 2) === -1 || A().view.hitCell(1, 1) === -1);
    const canvasBox = A().view.canvas.getBoundingClientRect();
    ck('画布在舞台上', canvasBox.width > 100 && canvasBox.height > 100 && canvasBox.right <= window.innerWidth + 1, JSON.stringify(canvasBox));
    ck('画布没超出可用高度', canvasBox.bottom <= window.innerHeight, JSON.stringify(canvasBox));

    // 线索格必须真画了东西：那一列的颜色不能和海一样。
    const gut = A().view.geo.ox;
    const { ctx } = A().view;
    const d = A().view.geo.dpr;
    const sample = ctx.getImageData(Math.round((gut / 2) * d), Math.round((A().view.geo.oy + A().view.geo.cell / 2) * d), Math.round(gut * d), Math.round(A().view.geo.cell * d)).data;
    let ink = 0;
    for (let i = 0; i < sample.length; i += 4) if (sample[i] + sample[i + 1] + sample[i + 2] > 150) ink++;
    ck('行线索画在盘外', ink > 20, ink);

    eq('主题变量进了 CSS', cssVar('--accent').toLowerCase(), E().theme.accent.toLowerCase());
    ck('五档五配色', E().theme.tints.length === E().TIERS.length, E().theme.tints.length);
    ck('对局面板可见', shown('.panel') && shown('#board-wrap'));
    ck('胜利卡片藏着', !shown('#win-veil'));
    ck('冲突行是空的', text('#conflict-line') === '');
    const modeBtn = $('#btn-mode-water');
    A().setMode('water');
    ck('换笔有反馈', modeBtn.classList.contains('is-on') && A().state().mode === 'water');
    A().setMode('ship');
    return report({ tier: 'layout' });
  };

  w.__ng = ng;
})(window);
