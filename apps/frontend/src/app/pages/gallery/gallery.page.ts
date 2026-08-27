import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { Subject, debounceTime, forkJoin } from 'rxjs';
import { ConfirmDialog } from '../../shared/confirm-dialog/confirm-dialog';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { Toast } from '../../shared/toast/toast';
import { ToastService } from '../../shared/toast/toast.service';
import { Player } from '../../shared/player/player';
import { GalleryCard } from '../../shared/gallery-card/gallery-card';
import { PurgeSheet, type PurgeScope } from '../../shared/purge-sheet/purge-sheet';
import { SelectionBar } from '../../shared/selection-bar/selection-bar';
import { AppHeader } from '../../shared/app-header/app-header';
import { VideoService } from '../../services/video.service';
import { CameraService } from '../../services/camera.service';
import { Video } from '../../models/video.model';
import { Camera } from '../../models/camera.model';

// Retención: borra lo anterior a (now - SCOPE_MS), nunca el último periodo
// (mismos valores que storage.page.ts).
const SCOPE_MS: Record<'day' | 'week' | 'month', number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000
};

const SCOPE_LABEL: Record<PurgeScope, string> = {
  day: 'más de 1 día',
  week: 'más de 1 semana',
  month: 'más de 1 mes',
  all: 'toda la biblioteca'
};

interface DayGroup {
  key: string;
  label: string;
  dateLabel: string;
  videos: Video[];
}

const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const pad2 = (n: number) => String(n).padStart(2, '0');

@Component({
  selector: 'yi-gallery-page',
  imports: [ConfirmDialog, Toast, Player, GalleryCard, PurgeSheet, SelectionBar, AppHeader],
  templateUrl: './gallery.page.html',
  styleUrl: './gallery.page.scss',
})
export class GalleryPage implements OnInit, OnDestroy {
  private videoService = inject(VideoService);
  private cameraService = inject(CameraService);
  private confirmDialog = inject(ConfirmDialogService);
  private toast = inject(ToastService);

  readonly LIMIT = 24;

  private static readonly SCROLL_THRESHOLD = 300;

  cameras = signal<Camera[]>([]);
  videos = signal<Video[]>([]);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = signal(false);
  offset = signal(0);

  // Toolbar: searchInput es el valor en vivo del input; search es el valor
  // debounced (300 ms) que alimenta la API.
  searchInput = signal('');
  search = signal('');
  cameraFilter = signal('');
  startDate = signal('');
  endDate = signal('');
  favoritesOnly = signal(false);

  // Modo selección múltiple: seleccionar clips y aplicar acciones en lote.
  selecting = signal(false);
  selected = signal<Set<number>>(new Set());
  selectedCount = computed(() => this.selected().size);

  hasFilters = computed(() =>
    !!(this.search() || this.cameraFilter() || this.startDate() || this.endDate() || this.favoritesOnly())
  );

  datePopoverOpen = signal(false);

  // Cierra el popover con un pointerdown fuera del contenedor .date-popover
  // (el botón y el panel están dentro, así que no lo cierran). En fase de
  // captura para ganar a cualquier otro handler del documento.
  private onDocPointerDown = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (t && !t.closest('.date-popover')) this.closeDatePopover();
  };

  constructor() {
    // Se registra/desregistra solo mientras el popover está abierto (cubre
    // toggle, close y clear, que solo tocan la señal).
    effect(() => {
      if (this.datePopoverOpen()) {
        document.addEventListener('pointerdown', this.onDocPointerDown, true);
      } else {
        document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      }
    });
  }

  dateLabel = computed(() => {
    const from = this.startDate();
    const to = this.endDate();
    if (!from && !to) return 'Cualquier fecha';
    const fmt = (v: string) => {
      const parts = v.split('-');
      return `${parts[2]}/${parts[1]}`;
    };
    return `${from ? fmt(from) : '…'} – ${to ? fmt(to) : '…'}`;
  });

  // Hook para la fase del player: video seleccionado, aún sin renderizar.
  playingVideo = signal<Video | null>(null);

  renamingId = signal<number | null>(null);
  renameValue = signal('');
  renameError = signal<string | null>(null);

  purgeOpen = signal(false);
  purgeScope = signal<PurgeScope>('month');
  purgeExpected = signal<number | null>(null);
  purging = signal(false);
  storageCount = signal<number | null>(null);
  // Aproximado: suma del file_size de los clips actualmente cargados.
  storageBytes = computed(() => this.videos().reduce((sum, v) => sum + (v.file_size || 0), 0));

  private searchSubject = new Subject<string>();
  private reqId = 0;
  private countReqId = 0;
  private storageReqId = 0;
  private destroyed = false;

  private onWindowScroll = () => {
    if (this.destroyed) return;
    if (this.shouldAutoLoadMore()) this.loadMore();
  };

  ngOnInit() {
    window.addEventListener('scroll', this.onWindowScroll, { passive: true });
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        if (!this.destroyed) this.cameras.set(res.data);
      },
      error: () => {}
    });

    this.searchSubject.pipe(debounceTime(300)).subscribe((q) => {
      if (this.destroyed) return;
      this.search.set(q);
      this.reload();
    });

    this.reload();
  }

  ngOnDestroy() {
    this.destroyed = true;
    window.removeEventListener('scroll', this.onWindowScroll);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  /* ---------------- TOOLBAR ---------------- */

  onSearchInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.searchInput.set(v);
    this.searchSubject.next(v);
  }

  selectCamera(ftpDir: string) {
    if (this.cameraFilter() === ftpDir) return;
    this.cameraFilter.set(ftpDir);
    this.reload();
  }

  onStartDateChange(e: Event) {
    this.startDate.set((e.target as HTMLInputElement).value);
    this.reload();
  }

  onEndDateChange(e: Event) {
    this.endDate.set((e.target as HTMLInputElement).value);
    this.reload();
  }

  toggleFavoritesOnly() {
    this.favoritesOnly.set(!this.favoritesOnly());
    this.reload();
  }

  toggleDatePopover() {
    this.datePopoverOpen.set(!this.datePopoverOpen());
  }

  closeDatePopover() {
    this.datePopoverOpen.set(false);
  }

  clearDateRange() {
    this.startDate.set('');
    this.endDate.set('');
    this.datePopoverOpen.set(false);
    this.reload();
  }

  /* ---------------- SELECCIÓN MÚLTIPLE ---------------- */

  toggleSelectMode() {
    if (this.selecting()) {
      this.exitSelection();
    } else {
      this.selecting.set(true);
    }
  }

  exitSelection() {
    this.selecting.set(false);
    this.selected.set(new Set());
  }

  isSelected(vid: Video): boolean {
    return this.selected().has(vid.id);
  }

  toggleSelect(vid: Video) {
    const next = new Set(this.selected());
    if (next.has(vid.id)) {
      next.delete(vid.id);
    } else {
      next.add(vid.id);
    }
    this.selected.set(next);
  }

  onCardClick(vid: Video) {
    if (this.selecting()) {
      this.toggleSelect(vid);
    } else {
      this.onPlay(vid);
    }
  }

  bulkFavorite() {
    const ids = [...this.selected()];
    if (!ids.length) return;
    const selectedVideos = this.videos().filter((v) => ids.includes(v.id));
    const target = !selectedVideos.every((v) => v.favorite);
    // Estado previo de cada id para poder revertir el update optimista.
    const prevFavorite = new Map<number, boolean>();
    for (const v of this.videos()) {
      if (ids.includes(v.id)) prevFavorite.set(v.id, v.favorite);
    }
    this.videos.update((list) => list.map((v) => (ids.includes(v.id) ? { ...v, favorite: target } : v)));
    this.videoService.bulkFavorite(ids, target).subscribe({
      next: () => {
        if (this.destroyed) return;
        this.toast.show(target ? 'Añadidos a favoritos' : 'Quitados de favoritos', 'success');
      },
      error: () => {
        if (this.destroyed) return;
        this.videos.update((list) =>
          list.map((v) => (prevFavorite.has(v.id) ? { ...v, favorite: prevFavorite.get(v.id)! } : v))
        );
        this.toast.show('Error al actualizar favoritos', 'error');
      }
    });
  }

  bulkDelete() {
    const ids = [...this.selected()];
    if (!ids.length) return;
    const n = ids.length;
    this.confirmDialog
      .show({
        title: `Eliminar ${n} ${n === 1 ? 'clip' : 'clips'}`,
        message: 'Esta acción no se puede deshacer.',
        confirmLabel: `Eliminar ${n}`,
        danger: true
      })
      .then((confirmed) => {
        if (!confirmed || this.destroyed) return;
        this.videoService.bulkDelete(ids).subscribe({
          next: (res) => {
            if (this.destroyed) return;
            // El API devuelve los ids como string: se convierten a number.
            const removed = res.deleted?.length ? res.deleted.map(Number) : ids;
            const removedSet = new Set(removed);
            this.videos.update((list) => list.filter((v) => !removedSet.has(v.id)));
            this.toast.show(`${n} ${n === 1 ? 'clip eliminado' : 'clips eliminados'}`, 'success');
            this.exitSelection();
          },
          error: () => {
            if (this.destroyed) return;
            this.toast.show('Error al eliminar', 'error');
          }
        });
      });
  }

  /* ---------------- LISTA / PAGINACIÓN ---------------- */

  private buildParams(): {
    camera?: string;
    startDate?: string;
    endDate?: string;
    q?: string;
    favorite?: 0 | 1;
  } {
    // La BD compara timestamps ISO 8601 UTC lexicográficamente: se envían
    // fechas completas para que ambos límites del rango sean inclusivos.
    return {
      camera: this.cameraFilter() || undefined,
      startDate: this.startDate() ? `${this.startDate()}T00:00:00.000Z` : undefined,
      endDate: this.endDate() ? `${this.endDate()}T23:59:59.999Z` : undefined,
      q: this.search() || undefined,
      favorite: this.favoritesOnly() ? 1 : undefined
    };
  }

  reload() {
    this.offset.set(0);
    this.loadVideos(false);
  }

  loadMore() {
    this.loadVideos(true);
  }

  private nearBottom(): boolean {
    const doc = document.documentElement;
    return window.innerHeight + window.scrollY >= doc.scrollHeight - GalleryPage.SCROLL_THRESHOLD;
  }

  shouldAutoLoadMore(): boolean {
    return (
      this.hasMore() &&
      !this.loadingMore() &&
      !this.loading() &&
      !this.playingVideo() &&
      !this.purgeOpen() &&
      this.nearBottom()
    );
  }

  private loadVideos(append: boolean) {
    const id = ++this.reqId;
    const nextOffset = append ? this.offset() + this.LIMIT : 0;
    if (append) {
      this.loadingMore.set(true);
    } else {
      this.loading.set(true);
    }
    this.videoService.getVideos({
      ...this.buildParams(),
      limit: this.LIMIT,
      offset: nextOffset
    }).subscribe({
      next: (res) => {
        if (id !== this.reqId || this.destroyed) return;
        const data = res.data || [];
        if (append) {
          this.videos.update((list) => [...list, ...data]);
        } else {
          this.videos.set(data);
        }
        // El API devuelve count = tamaño de la página: si la página está
        // completa, puede haber más.
        this.hasMore.set(data.length >= this.LIMIT);
        this.offset.set(nextOffset);
        this.loading.set(false);
        this.loadingMore.set(false);
        if (append && this.shouldAutoLoadMore()) this.loadMore();
      },
      error: () => {
        if (id !== this.reqId || this.destroyed) return;
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    });
  }

  /* ---------------- GRUPOS POR DÍA ---------------- */

  readonly dayGroups = computed<DayGroup[]>(() => {
    // videos() llega ordenado DESC del API; se agrupa por fecha LOCAL
    // preservando el orden (Map por orden de inserción).
    const groups = new Map<string, DayGroup>();
    for (const vid of this.videos()) {
      const d = new Date(vid.timestamp);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, label: this.dayLabel(d), dateLabel: this.dayDateLabel(d), videos: [] };
        groups.set(key, group);
      }
      group.videos.push(vid);
    }
    return [...groups.values()];
  });

  private isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  private formatDayDate(d: Date): string {
    return `${pad2(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }

  private dayLabel(d: Date): string {
    const now = new Date();
    if (this.isSameDay(d, now)) return 'Hoy';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (this.isSameDay(d, yesterday)) return 'Ayer';
    return this.formatDayDate(d);
  }

  private dayDateLabel(d: Date): string {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (this.isSameDay(d, now) || this.isSameDay(d, yesterday)) return this.formatDayDate(d);
    return '';
  }

  /* ---------------- CARDS ---------------- */

  onPlay(vid: Video) {
    this.playingVideo.set(vid);
  }

  closePlayer() {
    this.playingVideo.set(null);
  }

  // Actualización optimista del favorito con rollback si la API falla
  // (mismo patrón que dashboard.page.ts). Si el clip está abierto en el
  // player, playingVideo se sincroniza (hook de la fase del player).
  toggleFavorite(vid: Video) {
    if (this.destroyed) return;
    const next = !vid.favorite;
    this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: next } : v)));
    const playing = this.playingVideo();
    if (playing?.id === vid.id) this.playingVideo.set({ ...playing, favorite: next });
    this.videoService.setFavorite(vid.id, next).subscribe({
      error: () => {
        if (this.destroyed) return;
        this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: vid.favorite } : v)));
        const playing = this.playingVideo();
        if (playing?.id === vid.id) this.playingVideo.set({ ...playing, favorite: vid.favorite });
      }
    });
  }

  startRename(vid: Video) {
    this.renamingId.set(vid.id);
    this.renameValue.set(vid.name ?? '');
    this.renameError.set(null);
  }

  onRenameInput(e: Event) {
    this.renameValue.set((e.target as HTMLInputElement).value);
    this.renameError.set(null);
  }

  cancelRename() {
    this.renamingId.set(null);
    this.renameError.set(null);
  }

  commitRename(vid: Video) {
    if (this.renamingId() !== vid.id) return;
    const name = this.renameValue().trim() || null;
    if (name === (vid.name ?? null)) {
      this.renamingId.set(null);
      return;
    }
    this.videoService.renameVideo(vid.id, name).subscribe({
      next: (res) => {
        if (this.destroyed) return;
        const newName = res.video?.name ?? name;
        this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, name: newName } : v)));
        this.renamingId.set(null);
        this.renameError.set(null);
      },
      error: () => {
        if (this.destroyed) return;
        // Rollback del input al nombre anterior (la lista nunca se tocó).
        this.renameValue.set(vid.name ?? '');
        this.renameError.set('No se pudo renombrar');
        this.toast.show('No se pudo renombrar', 'error');
      }
    });
  }

  deleteVideo(vid: Video) {
    this.confirmDialog
      .show({
        title: 'Eliminar grabación',
        message: 'Esta acción no se puede deshacer.',
        confirmLabel: 'Eliminar',
        danger: true
      })
      .then((confirmed) => {
        if (!confirmed || this.destroyed) return;
        this.videoService.deleteVideo(vid.id).subscribe({
          next: () => {
            if (this.destroyed) return;
            this.videos.update((list) => list.filter((v) => v.id !== vid.id));
            this.toast.show('Grabación eliminada', 'success');
          },
          error: () => {
            if (this.destroyed) return;
            this.toast.show('Error al eliminar', 'error');
          }
        });
      });
  }

  /* ---------------- PURGE (bottom sheet) ---------------- */

  openPurgeSheet() {
    this.purgeOpen.set(true);
    // Total de clips de la biblioteca (sin filtros) para "Clips guardados".
    const id = ++this.storageReqId;
    this.videoService.countVideos({}).subscribe({
      next: (res) => {
        if (id !== this.storageReqId || this.destroyed) return;
        this.storageCount.set(res.count);
      },
      error: () => {
        if (id !== this.storageReqId || this.destroyed) return;
        this.storageCount.set(null);
      }
    });
    this.refreshPurgeCount();
  }

  closePurgeSheet() {
    this.purgeOpen.set(false);
  }

  selectPurgeScope(scope: PurgeScope) {
    this.purgeScope.set(scope);
    this.refreshPurgeCount();
  }

  // Conteo esperado = total del alcance - favoritos del alcance (los
  // favoritos están excluidos del purge).
  private refreshPurgeCount() {
    const scope = this.purgeScope();
    const params =
      scope === 'all' ? {} : { endDate: new Date(Date.now() - SCOPE_MS[scope]).toISOString() };
    const id = ++this.countReqId;
    forkJoin([
      this.videoService.countVideos(params),
      this.videoService.countVideos({ ...params, favorite: 1 })
    ]).subscribe({
      next: ([all, fav]) => {
        if (id !== this.countReqId || this.destroyed) return;
        this.purgeExpected.set(Math.max(0, all.count - fav.count));
      },
      error: () => {
        if (id !== this.countReqId || this.destroyed) return;
        this.purgeExpected.set(null);
      }
    });
  }

  storageUsedLabel(): string {
    const b = this.storageBytes();
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
    return Math.round(b / 1024) + ' KB';
  }

  onPurge() {
    const n = this.purgeExpected() ?? 0;
    if (n <= 0 || this.purging()) return;
    const scope = this.purgeScope();
    const message =
      scope === 'all'
        ? 'Se eliminarán de forma permanente todos los clips de la biblioteca. Los favoritos no se borran.'
        : `Se eliminarán de forma permanente los clips con ${SCOPE_LABEL[scope]} de antigüedad. Los favoritos no se borran.`;
    this.confirmDialog
      .show({
        title: `Purgar ${n} ${n === 1 ? 'clip' : 'clips'}`,
        message,
        confirmLabel: `Purgar ${n}`,
        danger: true
      })
      .then((confirmed) => {
        if (!confirmed || this.destroyed) return;
        this.purging.set(true);
        this.videoService.purgeVideos({ scope }).subscribe({
          next: (res) => {
            if (this.destroyed) return;
            this.purging.set(false);
            const purgedCount = (res.purged || []).length;
            if (purgedCount === 0) {
              this.toast.show('No había clips en ese alcance', 'info');
            } else {
              this.toast.show(`${purgedCount} ${purgedCount === 1 ? 'clip purgado' : 'clips purgados'}`, 'success');
            }
            this.closePurgeSheet();
            this.reload();
          },
          error: () => {
            if (this.destroyed) return;
            this.purging.set(false);
            this.toast.show('Error al purgar', 'error');
          }
        });
      });
  }
}
