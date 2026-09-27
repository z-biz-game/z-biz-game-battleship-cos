// 画盘。这里不做任何判断：格子是什么状态、哪些是冲突、哪条线索数满了，全部从引擎的
// 读数里拿（game.st.cells / game.diag / game.docked）。命中测试也留在这里，和 draw 共用
// 同一份 this.geo——如果另写一套坐标，鼠标就会点歪一格。
//
// 线索是画在盘外的：行线索在这一行左边，列线索在这一列上边。题面可以省略某条线
// （引擎里是 -1），省略的位置画一个淡淡的菱形——玩家必须能看出"这里没给数"和"这里给的是
// 0"是两件不同的事，否则整个推理的出发点就错了。

import { Palette, Cell, Radius, Font } from '../theme.js';
import { UNKNOWN, SHIP, WATER } from '../engine/ships.js';

const GUTTER = 1.15;

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, ox: 0, oy: 0, w: 0, h: 0, dpr: 1, size: 0 };
  }

  resize(game, availW, availH) {
    const { w, h } = game.board;
    const need = GUTTER + Math.max(w, h);
    const byW = (availW - 8) / need;
    const byH = (availH - 8) / (GUTTER + h);
    const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(Math.min(byW, byH))));
    const gut = Math.round(cell * GUTTER);
    const size = gut + cell * w + 6;
    const height = gut + cell * h + 6;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell, ox: gut, oy: gut, w, h, dpr, size };
    return this.geo;
  }

  local(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  hitCell(clientX, clientY) {
    const { x, y } = this.local(clientX, clientY);
    const { cell, ox, oy, w, h } = this.geo;
    if (!cell) return -1;
    const c = Math.floor((x - ox) / cell);
    const r = Math.floor((y - oy) / cell);
    if (r < 0 || c < 0 || r >= h || c >= w) return -1;
    return r * w + c;
  }

  cellRect(t) {
    const { cell, ox, oy, w } = this.geo;
    const r = Math.floor(t / w);
    const c = t % w;
    return { x: ox + c * cell, y: oy + r * cell, w: cell, h: cell };
  }

  draw(game, { pulse = null } = {}) {
    const { ctx, geo } = this;
    const { cell, ox, oy } = geo;
    const board = game.board;
    const cells = game.st.cells;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 船体按"哪一条船"分色只在赢的时候有意义：那时 dockedShips 认得出完整的舰队。
    // 还在下的过程中，一段没封死的船该是船格的颜色，不该提前穿上某条船的制服。
    const hullOf = new Map();
    if (won) {
      game.docked.forEach((s, i) => s.cells.forEach((t, k) => hullOf.set(t, { tint: Palette.tints[i % Palette.tints.length], head: k === 0 })));
    }

    for (let t = 0; t < board.size; t++) {
      const rect = this.cellRect(t);
      const v = cells[t];
      ctx.fillStyle = v === SHIP ? (hullOf.has(t) ? hullOf.get(t).tint : Palette.hull) : v === WATER ? Palette.water : Palette.unlit;
      roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Radius.cell);
      ctx.fill();
      if (v === WATER) {
        ctx.fillStyle = Palette.ripple;
        ctx.beginPath();
        ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(1.4, rect.w * 0.07), 0, Math.PI * 2);
        ctx.fill();
      }
      if (v === SHIP) {
        ctx.strokeStyle = Palette.hullEdge;
        ctx.lineWidth = 1.5;
        roundRect(ctx, rect.x + 2.5, rect.y + 2.5, rect.w - 5, rect.h - 5, Radius.cell);
        ctx.stroke();
      }
      if (game.diag.badCells.has(t)) {
        ctx.strokeStyle = Palette.error;
        ctx.lineWidth = 2;
        roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Radius.cell);
        ctx.stroke();
      }
      if (pulse && pulse.cells && pulse.cells.includes(t)) {
        ctx.fillStyle = pulse.kind === 'ship' ? 'rgba(123,184,255,0.30)' : 'rgba(123,184,255,0.16)';
        roundRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, Radius.cell);
        ctx.fill();
      }
    }

    // 网格与盘框
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= board.w; c++) {
      ctx.moveTo(ox + c * cell + 0.5, oy);
      ctx.lineTo(ox + c * cell + 0.5, oy + board.h * cell);
    }
    for (let r = 0; r <= board.h; r++) {
      ctx.moveTo(ox, oy + r * cell + 0.5);
      ctx.lineTo(ox + board.w * cell, oy + r * cell + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - 1, oy - 1, board.w * cell + 2, board.h * cell + 2);

    // 线索
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(cell * Cell.clueScale)}px ${Font.mono}`;
    for (let r = 0; r < board.h; r++) clue(ctx, board.rows[r], countLine(game, 'h', r), ox - cell * 0.62, oy + r * cell + cell / 2, cell);
    for (let c = 0; c < board.w; c++) clue(ctx, board.cols[c], countLine(game, 'v', c), ox + c * cell + cell / 2, oy - cell * 0.62, cell);
  }
}

// 一条线索该长什么样：没给 = 淡菱形；给了但对不上 = 红；给了且数满 = 实心偏亮。
function clue(ctx, given, have, x, y, cell) {
  if (given < 0) {
    ctx.fillStyle = Palette.inkFaint;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-cell * 0.08, -cell * 0.08, cell * 0.16, cell * 0.16);
    ctx.restore();
    return;
  }
  ctx.fillStyle = given === have ? Palette.ink : given < have ? Palette.error : Palette.inkDim;
  ctx.fillText(String(given), x, y);
}

function countLine(game, axis, i) {
  const board = game.board;
  let n = 0;
  if (axis === 'h') for (let c = 0; c < board.w; c++) if (game.st.cells[board.w * i + c] === SHIP) n++;
  else for (let r = 0; r < board.h; r++) if (game.st.cells[r * board.w + i] === SHIP) n++;
  return n;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function layoutFor(w, h, availW, availH) {
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(Math.min((availW - 8) / (GUTTER + w), (availH - 8) / (GUTTER + h)))));
  const gut = Math.round(cell * GUTTER);
  return { cell, gut, size: gut + cell * w + 6 };
}
