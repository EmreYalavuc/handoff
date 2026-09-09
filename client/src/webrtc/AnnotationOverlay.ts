import { makeDCMessage, type DCMessage } from './DataChannelProtocol';

export type AnnTool = 'pen' | 'arrow' | 'rect';

interface Point { x: number; y: number } // normalized 0–1

export interface Stroke {
  id: string;
  userId: string;
  color: string;
  tool: AnnTool;
  width: number;
  points: Point[];
}

export interface AnnotationClearPayload { userId?: string }

const USER_COLORS = ['#ef4444','#3b82f6','#f59e0b','#10b981','#8b5cf6','#ec4899','#06b6d4'];
let colorIdx = 0;
const userColors = new Map<string, string>();
function colorFor(id: string) {
  if (!userColors.has(id)) userColors.set(id, USER_COLORS[colorIdx++ % USER_COLORS.length]);
  return userColors.get(id)!;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

/**
 * Canvas overlay that lives on top of the video container.
 * Both host and viewers create one. Viewer draws → sends via DC → host relays to all.
 */
export class AnnotationOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private drawing = false;
  private active = false; // annotation mode toggle
  private tool: AnnTool = 'pen';
  private width = 3;
  private myColor: string;
  private ro: ResizeObserver;

  constructor(
    private container: HTMLElement,
    private myId: string,
    private myName: string,
    private send: (msg: DCMessage) => void,
  ) {
    this.myColor = colorFor(myId);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'annotation-canvas';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.ro = new ResizeObserver(() => { this.syncSize(); this.redraw(); });
    this.ro.observe(this.container);
    this.syncSize();

    this.canvas.addEventListener('mousedown', this.onDown);
    this.canvas.addEventListener('mousemove', this.onMove);
    this.canvas.addEventListener('mouseup',   this.onUp);
    this.canvas.addEventListener('mouseleave',this.onUp);
  }

  enable()  { this.active = true;  this.canvas.style.pointerEvents = 'all'; this.canvas.style.cursor = 'crosshair'; }
  disable() { this.active = false; this.canvas.style.pointerEvents = 'none'; this.canvas.style.cursor = ''; this.current = null; this.drawing = false; }

  setTool(t: AnnTool)  { this.tool = t; }
  setWidth(w: number)  { this.width = w; }
  isEnabled()          { return this.active; }

  /** Clear strokes belonging to one user, or all if userId is absent. */
  clearOwn() {
    this.strokes = this.strokes.filter(s => s.userId !== this.myId);
    this.redraw();
    const payload: AnnotationClearPayload = { userId: this.myId };
    this.send(makeDCMessage('annotation-clear', payload));
  }

  clearAll() {
    this.strokes = [];
    this.redraw();
    const payload: AnnotationClearPayload = {};
    this.send(makeDCMessage('annotation-clear', payload));
  }

  /** Handle incoming DC messages from peers. */
  receive(msg: DCMessage) {
    if (msg.type === 'annotation-draw') {
      const stroke = msg.payload as Stroke;
      // Assign consistent color for this user
      if (!userColors.has(stroke.userId)) userColors.set(stroke.userId, stroke.color);
      this.strokes.push(stroke);
      this.drawStroke(stroke);
    } else if (msg.type === 'annotation-clear') {
      const { userId } = msg.payload as AnnotationClearPayload;
      this.strokes = userId ? this.strokes.filter(s => s.userId !== userId) : [];
      this.redraw();
    }
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
    userColors.delete(this.myId);
  }

  // ── Private ──────────────────────────────────────────────────

  private syncSize() {
    this.canvas.width  = this.container.clientWidth;
    this.canvas.height = this.container.clientHeight;
  }

  private norm(e: MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left)  / r.width,
      y: (e.clientY - r.top)   / r.height,
    };
  }

  private onDown = (e: MouseEvent) => {
    if (!this.active) return;
    this.drawing = true;
    const pt = this.norm(e);
    this.current = {
      id: uid(), userId: this.myId, color: this.myColor,
      tool: this.tool, width: this.width, points: [pt],
    };
  };

  private onMove = (e: MouseEvent) => {
    if (!this.drawing || !this.current) return;
    const pt = this.norm(e);
    this.current.points.push(pt);

    if (this.tool === 'pen') {
      // Live draw only the new segment
      this.drawPenTail(this.current);
    } else {
      // For shape tools redraw everything (cheap enough for normal stroke counts)
      this.redraw();
      this.drawStroke(this.current);
    }
  };

  private onUp = () => {
    if (!this.drawing || !this.current) return;
    this.drawing = false;
    if (this.current.points.length < 2) { this.current = null; return; }
    const finished = this.current;
    this.strokes.push(finished);
    this.current = null;
    this.send(makeDCMessage('annotation-draw', finished));
  };

  private redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const s of this.strokes) this.drawStroke(s);
  }

  private drawStroke(s: Stroke) {
    if (s.points.length < 2) return;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    ctx.strokeStyle = s.color;
    ctx.lineWidth   = s.width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = 0.92;

    const px = (p: Point) => p.x * W;
    const py = (p: Point) => p.y * H;

    if (s.tool === 'pen') {
      ctx.beginPath();
      ctx.moveTo(px(s.points[0]), py(s.points[0]));
      for (let i = 1; i < s.points.length - 1; i++) {
        const mx = (px(s.points[i]) + px(s.points[i + 1])) / 2;
        const my = (py(s.points[i]) + py(s.points[i + 1])) / 2;
        ctx.quadraticCurveTo(px(s.points[i]), py(s.points[i]), mx, my);
      }
      const last = s.points[s.points.length - 1];
      ctx.lineTo(px(last), py(last));
      ctx.stroke();

    } else if (s.tool === 'arrow') {
      const from = s.points[0];
      const to   = s.points[s.points.length - 1];
      const fx = px(from), fy = py(from), tx = px(to), ty = py(to);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      // Arrowhead
      const angle = Math.atan2(ty - fy, tx - fx);
      const hw = s.width * 4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - hw * Math.cos(angle - 0.4), ty - hw * Math.sin(angle - 0.4));
      ctx.lineTo(tx - hw * Math.cos(angle + 0.4), ty - hw * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();

    } else if (s.tool === 'rect') {
      const from = s.points[0];
      const to   = s.points[s.points.length - 1];
      ctx.beginPath();
      ctx.strokeRect(
        px(from), py(from),
        px(to) - px(from), py(to) - py(from),
      );
    }

    ctx.globalAlpha = 1;
  }

  /** Draw only the most recent pen segment (live preview optimization). */
  private drawPenTail(s: Stroke) {
    if (s.points.length < 2) return;
    const W = this.canvas.width, H = this.canvas.height;
    const ctx = this.ctx;
    const pts = s.points;
    const i = pts.length - 2;
    ctx.strokeStyle = s.color;
    ctx.lineWidth   = s.width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(pts[i].x * W, pts[i].y * H);
    ctx.lineTo(pts[i + 1].x * W, pts[i + 1].y * H);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
