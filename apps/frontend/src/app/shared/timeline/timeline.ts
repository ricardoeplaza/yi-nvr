import {
  afterNextRender,
  ChangeDetectorRef,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import type { Video } from '../../models/video.model';

/* =========================================================
   Constantes de layout / comportamiento
   ========================================================= */
const PX_PER_MIN = 2;
const MIN_PER_DAY = 24 * 60;
const DAY_WIDTH = MIN_PER_DAY * PX_PER_MIN;
const TICK_MIN = 10;
const PREPEND_TRIGGER_PX = DAY_WIDTH * 0.6;
const EV_COLOR = '#3b82f6';
const RANGE_DEBOUNCE_MS = 140;

/* =========================================================
   Utilidades de fecha (locales, sin zona horaria)
   ========================================================= */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function dateKey(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isSameDay(a: Date, b: Date): boolean {
  return dateKey(a) === dateKey(b);
}
function minutesNow(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}
function fmtHourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? h + 'am' : h - 12 + 'pm';
}
function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.floor(minutes % 60);
  const s = Math.floor((minutes * 60) % 60);
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
}
function pillLabel(d: Date, today: Date): string {
  if (isSameDay(d, today)) return 'Hoy';
  if (isSameDay(d, addDays(today, -1))) return 'Ayer';
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

/* =========================================================
   Modelos de vista (expuestos al template)
   ========================================================= */
export interface DaySegment {
  left: number;
  width: number;
}
export interface DayEvent {
  video: Video;
  left: number;
  selected: boolean;
}
export interface HourTick {
  left: number;
  label: string;
  major: boolean;
}
export interface NightZone {
  left: number;
  width: number;
}
export interface DayColumn {
  key: string;
  date: Date;
  startEpoch: number;
  width: number;
  isToday: boolean;
  nightZones: NightZone[];
  hourTicks: HourTick[];
  segments: DaySegment[];
  events: DayEvent[];
  nowLineLeft: number | null;
}

/* =========================================================
   Componente
   ========================================================= */
@Component({
  selector: 'yi-timeline',
  imports: [],
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
})
export class Timeline implements OnDestroy {
  /* ---------- inputs ---------- */
  readonly videos = input.required<Video[]>();
  readonly selectedId = input<number | null>(null);

  /* ---------- outputs ---------- */
  readonly videoSelect = output<Video>();
  readonly rangeChange = output<{ from: number; to: number }>();

  /* ---------- señales públicas (estado visible) ---------- */
  /** Ventana de tiempo (epoch ms) actualmente visible; null hasta el primer scroll. */
  readonly range = signal<{ from: number; to: number } | null>(null);
  /** Columnas de día renderizadas (con segmentos de grabación y marcas de evento). */
  readonly days = signal<DayColumn[]>([]);
  /** Hora del centro del viewport (HH:MM:SS) para la lectura de tiempo. */
  readonly centerTime = signal('');
  /** Etiqueta del día central (p. ej. "· Hoy") para la lectura de tiempo. */
  readonly centerDayLabel = signal('');
  /** Etiqueta del selector de fecha (píldora): Hoy / Ayer / fecha corta. */
  readonly dateLabel = signal('');
  /** Valor (YYYY-MM-DD) del <input type="date">. */
  readonly dateValue = signal('');
  /** Fecha máxima (hoy) para el <input type="date">. */
  readonly dateMax = signal('');

  /* ---------- referencias de template (para el paso de template) ---------- */
  @ViewChild('timelineScroll') scrollRef?: ElementRef<HTMLDivElement>;
  @ViewChild('timelineWrap') wrapRef?: ElementRef<HTMLDivElement>;
  @ViewChild('dateInput') dateInputRef?: ElementRef<HTMLInputElement>;

  private readonly cdr = inject(ChangeDetectorRef);
  private destroyed = false;

  /* ---------- estado interno ---------- */
  private readonly loadedDays = signal<Date[]>([]);
  private readonly now = signal(new Date());
  private dayCache = new Map<string, Video[]>();

  private readonly hourTicks: HourTick[] = [];
  private readonly nightZones: NightZone[] = [
    { left: 0, width: 6 * 60 * PX_PER_MIN },
    { left: 21 * 60 * PX_PER_MIN, width: 3 * 60 * PX_PER_MIN },
  ];

  /* ---------- DOM / temporizadores ---------- */
  private scrollEl: HTMLDivElement | null = null;
  private wrapEl: HTMLDivElement | null = null;
  private dateInputEl: HTMLInputElement | null = null;
  private scrollRaf = 0;
  private rangeTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private lastSelectedId: number | null = null;
  private dragging = false;
  private dragStartX = 0;
  private dragStartScroll = 0;
  private suppressClick = false;

  constructor() {
    for (let h = 0; h < 24; h++) {
      this.hourTicks.push({ left: h * 60 * PX_PER_MIN, label: fmtHourLabel(h), major: true });
      for (let m = TICK_MIN; m < 60; m += TICK_MIN) {
        this.hourTicks.push({ left: h * 60 * PX_PER_MIN + m * PX_PER_MIN, label: '', major: false });
      }
    }

    // Derivación reactiva: reconstruye las columnas cuando cambian los datos,
    // los días cargados, el "ahora" o la selección.
    effect(() => {
      this.rebuildNow();
      const sel = this.selectedId();
      if (sel !== null && sel !== this.lastSelectedId) {
        this.lastSelectedId = sel;
        const vid = this.videos().find(v => v.id === sel);
        if (vid) this.centerOnVideo(vid);
      }
    });

    afterNextRender(() => this.initDom());
  }

  /** Relee las señales y reconstruye las columnas (sincrono). */
  private rebuildNow() {
    this.rebuildDays(this.videos(), this.loadedDays(), this.now(), this.selectedId());
  }

  /* =========================================================
     Inicialización de DOM (una vez)
     ========================================================= */
  private initDom() {
    if (this.destroyed) return;
    this.scrollEl = this.scrollRef?.nativeElement ?? null;
    this.wrapEl = this.wrapRef?.nativeElement ?? null;
    this.dateInputEl = this.dateInputRef?.nativeElement ?? null;

    const today = startOfDay(new Date());
    this.loadedDays.set([addDays(today, -2), addDays(today, -1), today]);
    this.dateMax.set(dateKey(today));
    this.dateValue.set(dateKey(today));
    // Refresca el DOM de forma síncrona para que days() esté poblado antes de centrar.
    this.rebuildNow();
    this.cdr.detectChanges();

    if (this.scrollEl) {
      this.scrollEl.addEventListener('scroll', this.onScroll);
      this.scrollEl.addEventListener('click', this.onTrackClick);
      this.scrollEl.addEventListener('wheel', this.onWheel, { passive: false });
    }
    if (this.wrapEl) {
      this.wrapEl.addEventListener('mousedown', this.onDragStart);
      this.wrapEl.addEventListener('keydown', this.onKeydown);
    }
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);

    this.clockTimer = setInterval(() => {
      this.now.set(new Date());
      this.updateReadout();
    }, 60000);

    this.updateReadout();
    this.centerInitial();
  }

  private centerInitial() {
    const sel = this.selectedId();
    if (sel !== null) {
      const vid = this.videos().find(v => v.id === sel);
      if (vid) {
        this.centerOnVideo(vid);
        return;
      }
    }
    this.centerOnNow();
  }

  /* =========================================================
     Reconstrucción de columnas
     ========================================================= */
  private rebuildDays(vids: Video[], loaded: Date[], now: Date, sel: number | null) {
    const today = startOfDay(now);
    const cache = new Map<string, Video[]>();
    for (const v of vids) {
      const key = dateKey(new Date(v.timestamp));
      const list = cache.get(key);
      if (list) list.push(v);
      else cache.set(key, [v]);
    }
    this.dayCache = cache;

    const columns: DayColumn[] = [];
    for (const day of loaded) {
      columns.push(this.buildDayColumn(day, cache, today, sel));
    }
    this.days.set(columns);
    this.dateMax.set(dateKey(today));
  }

  private buildDayColumn(day: Date, cache: Map<string, Video[]>, today: Date, sel: number | null): DayColumn {
    const key = dateKey(day);
    const isToday = isSameDay(day, today);
    const nowMin = isToday ? minutesNow(this.now()) : MIN_PER_DAY;
    const start = startOfDay(day).getTime();
    const end = start + MIN_PER_DAY * 60000 - 1;
    const videos = cache.get(key) || [];

    const segs: [number, number][] = [];
    for (const v of videos) {
      const t = new Date(v.timestamp).getTime();
      if (t < start || t > end) continue;
      const s0 = Math.max(0, (t - start) / 60000);
      const e0 = Math.min(nowMin, s0 + v.duration / 60);
      if (e0 > s0) segs.push([s0, e0]);
    }
    segs.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of segs) {
      const last = merged[merged.length - 1];
      if (last && s - last[1] <= 3) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    const segments: DaySegment[] = merged.map(([s, e]) => ({
      left: s * PX_PER_MIN,
      width: Math.max(2, (e - s) * PX_PER_MIN),
    }));

    const events: DayEvent[] = [];
    for (const v of videos) {
      const t = new Date(v.timestamp).getTime();
      if (t < start || t > end) continue;
      const minute = (t - start) / 60000;
      events.push({ video: v, left: minute * PX_PER_MIN, selected: sel === v.id });
    }
    events.sort((a, b) => a.left - b.left);

    return {
      key,
      date: day,
      startEpoch: start,
      width: DAY_WIDTH,
      isToday,
      nightZones: this.nightZones,
      hourTicks: this.hourTicks,
      segments,
      events,
      nowLineLeft: isToday ? nowMin * PX_PER_MIN : null,
    };
  }

  /* =========================================================
     Lectura del centro / posicionamiento
     ========================================================= */
  private centerInfo(): { idx: number; minute: number; date: Date } | null {
    const el = this.scrollEl;
    const days = this.days();
    if (!el || days.length === 0) return null;
    const centerX = el.scrollLeft + el.clientWidth / 2;
    let idx = Math.floor(centerX / DAY_WIDTH);
    idx = Math.max(0, Math.min(days.length - 1, idx));
    const minute = (centerX - idx * DAY_WIDTH) / PX_PER_MIN;
    return { idx, minute: Math.max(0, Math.min(MIN_PER_DAY, minute)), date: days[idx].date };
  }

  private updateReadout() {
    const info = this.centerInfo();
    if (!info) return;
    const today = startOfDay(this.now());
    this.centerTime.set(fmtTime(info.minute));
    const label = pillLabel(info.date, today);
    this.centerDayLabel.set('· ' + label);
    this.dateLabel.set(label);
  }

  private centerOnNow() {
    const el = this.scrollEl;
    if (!el) return;
    const days = this.days();
    if (days.length === 0) return;
    const idx = days.length - 1;
    const x = idx * DAY_WIDTH + minutesNow(this.now()) * PX_PER_MIN;
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }

  private centerOnVideo(vid: Video) {
    const el = this.scrollEl;
    if (!el) return;
    const d = new Date(vid.timestamp);
    const days = this.days();
    const idx = days.findIndex(day => isSameDay(day.date, d));
    if (idx < 0) return;
    const minute = d.getHours() * 60 + d.getMinutes();
    const x = idx * DAY_WIDTH + minute * PX_PER_MIN;
    el.scrollTo({ left: Math.max(0, x - el.clientWidth / 2), behavior: 'smooth' });
  }

  private centerOnMinute(idx: number, minute: number) {
    const el = this.scrollEl;
    if (!el) return;
    const x = idx * DAY_WIDTH + minute * PX_PER_MIN;
    el.scrollTo({ left: Math.max(0, x - el.clientWidth / 2), behavior: 'smooth' });
  }

  /* =========================================================
     Scroll / arrastre / rueda / teclado
     ========================================================= */
  private onScroll = () => {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.handleScroll();
    });
  };

  private handleScroll() {
    const el = this.scrollEl;
    if (!el) return;

    if (el.scrollLeft < PREPEND_TRIGGER_PX) {
      this.prependOlderDay();
    }

    const days = this.days();
    if (days.length > 0) {
      const last = days[days.length - 1];
      if (last.isToday) {
        const maxX = (days.length - 1) * DAY_WIDTH + minutesNow(this.now()) * PX_PER_MIN - el.clientWidth / 2 + 2;
        if (el.scrollLeft > maxX) {
          el.scrollLeft = Math.max(0, maxX);
        }
      }
    }

    this.updateReadout();

    if (this.rangeTimer) clearTimeout(this.rangeTimer);
    this.rangeTimer = setTimeout(() => this.emitRange(), RANGE_DEBOUNCE_MS);
  }

  private prependOlderDay() {
    const el = this.scrollEl;
    const loaded = this.loadedDays();
    if (!el || loaded.length === 0) return;
    const newDate = addDays(loaded[0], -1);
    this.loadedDays.update(list => [newDate, ...list]);
    // Refresca el DOM de forma síncrona para poder compensar scrollLeft sin salto.
    this.rebuildNow();
    this.cdr.detectChanges();
    el.scrollLeft += DAY_WIDTH;
  }

  private onWheel = (e: WheelEvent) => {
    const el = this.scrollEl;
    if (!el) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };

  private onDragStart = (e: MouseEvent) => {
    const el = this.scrollEl;
    if (!el) return;
    this.dragging = true;
    this.dragStartX = e.pageX;
    this.dragStartScroll = el.scrollLeft;
    if (this.wrapEl) this.wrapEl.classList.add('dragging');
  };

  private onDragMove = (e: MouseEvent) => {
    if (!this.dragging) return;
    const el = this.scrollEl;
    if (!el) return;
    const dx = e.pageX - this.dragStartX;
    el.scrollLeft = this.dragStartScroll - dx;
    if (Math.abs(dx) > 4) this.suppressClick = true;
  };

  private onDragEnd = () => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.wrapEl) this.wrapEl.classList.remove('dragging');
  };

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = this.scrollEl;
    if (!el) return;
    const step = TICK_MIN * PX_PER_MIN;
    if (e.key === 'ArrowLeft') el.scrollLeft -= step;
    else el.scrollLeft += step;
    e.preventDefault();
  };

  private onTrackClick = (e: MouseEvent) => {
    const el = this.scrollEl;
    if (!el) return;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const target = e.target as Element;
    const mark = target.closest('.ev-mark') as HTMLElement | null;
    if (mark) {
      const id = Number(mark.dataset['id']);
      const vid = this.videos().find(v => v.id === id);
      if (vid) this.selectEvent(vid);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = el.scrollLeft + (e.clientX - rect.left) - el.clientWidth / 2;
    el.scrollTo({ left: Math.max(0, x), behavior: 'smooth' });
  };

  /* =========================================================
     Selección de eventos
     ========================================================= */
  selectEvent(video: Video) {
    this.videoSelect.emit(video);
  }

  /* =========================================================
     Selector de fecha
     ========================================================= */
  openDatePicker() {
    const input = this.dateInputEl;
    if (!input) return;
    const picker = input as HTMLInputElement & { showPicker?: () => void };
    if (picker.showPicker) {
      try {
        picker.showPicker();
      } catch {
        input.focus();
      }
    } else {
      input.focus();
    }
  }

  onDateChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.value) return;
    const parts = input.value.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return;
    this.jumpToDate(new Date(parts[0], parts[1] - 1, parts[2]));
  }

  private jumpToDate(target: Date) {
    const t = startOfDay(target);
    const today = startOfDay(this.now());
    const clamped = t.getTime() > today.getTime() ? today : t;
    const next = addDays(clamped, 1);
    const list: Date[] = [addDays(clamped, -1), clamped];
    if (next.getTime() <= today.getTime()) list.push(next);
    this.loadedDays.set(list);
    this.rebuildNow();
    this.cdr.detectChanges();
    const idx = list.findIndex(d => isSameDay(d, clamped));
    const centerMinute = isSameDay(clamped, today) ? minutesNow(this.now()) : 12 * 60;
    this.centerOnMinute(idx, centerMinute);
  }

  /* =========================================================
     Rango visible (epoch ms)
     ========================================================= */
  private xToEpoch(x: number): number {
    const days = this.days();
    if (days.length === 0) return 0;
    let idx = Math.floor(x / DAY_WIDTH);
    idx = Math.max(0, Math.min(days.length - 1, idx));
    const day = days[idx];
    const minute = (x - idx * DAY_WIDTH) / PX_PER_MIN;
    return day.startEpoch + Math.max(0, minute) * 60000;
  }

  private computeRange(): { from: number; to: number } | null {
    const el = this.scrollEl;
    if (!el || this.days().length === 0) return null;
    return {
      from: this.xToEpoch(el.scrollLeft),
      to: this.xToEpoch(el.scrollLeft + el.clientWidth),
    };
  }

  private emitRange() {
    const r = this.computeRange();
    if (!r) return;
    this.range.set(r);
    this.rangeChange.emit(r);
  }

  /* =========================================================
     Limpieza
     ========================================================= */
  ngOnDestroy() {
    this.destroyed = true;
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.rangeTimer) clearTimeout(this.rangeTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.scrollEl) {
      this.scrollEl.removeEventListener('scroll', this.onScroll);
      this.scrollEl.removeEventListener('click', this.onTrackClick);
      this.scrollEl.removeEventListener('wheel', this.onWheel);
    }
    if (this.wrapEl) {
      this.wrapEl.removeEventListener('mousedown', this.onDragStart);
      this.wrapEl.removeEventListener('keydown', this.onKeydown);
    }
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragEnd);
  }
}
