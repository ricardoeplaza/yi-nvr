import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Subject, debounceTime, forkJoin } from 'rxjs';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { FormatDatePipe } from '../../shared/format-date.pipe';
import { FormatDurationPipe } from '../../shared/format-duration.pipe';
import { VideoService } from '../../services/video.service';
import { CameraService } from '../../services/camera.service';
import { Video } from '../../models/video.model';
import { Camera } from '../../models/camera.model';

type PurgeScope = 'day' | 'week' | 'month' | 'range';

// Retención: borra lo anterior a (now - SCOPE_MS), nunca el último periodo
// (mismos valores que storage.page.ts).
const SCOPE_MS: Record<'day' | 'week' | 'month', number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000
};

const SCOPE_LABEL: Record<PurgeScope, string> = {
  day: 'de más de un día',
  week: 'de más de 1 semana',
  month: 'de más de 30 días',
  range: 'del rango indicado'
};

interface PurgeOutcome {
  expected: number;
  purged: number;
  failed: number;
}

@Component({
  selector: 'yi-gallery-page',
  imports: [EmptyStateComponent, FormatDatePipe, FormatDurationPipe],
  templateUrl: './gallery.page.html',
  styleUrl: './gallery.page.scss',
})
export class GalleryPage implements OnInit, OnDestroy {
  private videoService = inject(VideoService);
  private cameraService = inject(CameraService);

  readonly LIMIT = 24;

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

  hasFilters = computed(() =>
    !!(this.search() || this.cameraFilter() || this.startDate() || this.endDate() || this.favoritesOnly())
  );

  // Preview: una vez que el usuario ha hoverado una card, su src queda fijo
  // en preview_url (el navegador lo cachea) para no reasignar src en cada
  // hover/unhover.
  private previewSeen = new Set<number>();

  renamingId = signal<number | null>(null);
  renameValue = signal('');
  renameError = signal<string | null>(null);

  purgeOpen = signal(false);
  purgeScope = signal<PurgeScope>('day');
  purgeFrom = signal('');
  purgeTo = signal('');
  purgeExpected = signal<number | null>(null);
  purging = signal(false);
  purgeError = signal<string | null>(null);
  purgeOutcome = signal<PurgeOutcome | null>(null);

  private searchSubject = new Subject<string>();
  private reqId = 0;
  private countReqId = 0;
  private destroyed = false;

  ngOnInit() {
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
  }

  /* ---------------- TOOLBAR ---------------- */

  onSearchInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    this.searchInput.set(v);
    this.searchSubject.next(v);
  }

  onCameraChange(e: Event) {
    this.cameraFilter.set((e.target as HTMLSelectElement).value);
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

  onFavoritesChange(e: Event) {
    this.favoritesOnly.set((e.target as HTMLInputElement).checked);
    this.reload();
  }

  clearFilters() {
    this.searchInput.set('');
    this.search.set('');
    this.cameraFilter.set('');
    this.startDate.set('');
    this.endDate.set('');
    this.favoritesOnly.set(false);
    this.reload();
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
      },
      error: () => {
        if (id !== this.reqId || this.destroyed) return;
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    });
  }

  /* ---------------- CARDS ---------------- */

  onCardEnter(vid: Video) {
    if (vid.preview_url) this.previewSeen.add(vid.id);
  }

  cardSrc(vid: Video): string {
    if (vid.preview_url && this.previewSeen.has(vid.id)) return vid.preview_url;
    return vid.thumbnail_url;
  }

  displayName(vid: Video): string {
    if (vid.name) return vid.name;
    const d = new Date(vid.timestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${vid.camera_name}`;
  }

  formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
  }

  // Actualización optimista del favorito con rollback si la API falla
  // (mismo patrón que dashboard.page.ts).
  toggleFavorite(vid: Video) {
    if (this.destroyed) return;
    const next = !vid.favorite;
    this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: next } : v)));
    this.videoService.setFavorite(vid.id, next).subscribe({
      error: () => {
        if (this.destroyed) return;
        this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: vid.favorite } : v)));
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
      }
    });
  }

  deleteVideo(vid: Video) {
    if (!window.confirm('¿Eliminar esta grabación? Esta acción no se puede deshacer.')) return;
    this.videoService.deleteVideo(vid.id).subscribe({
      next: () => {
        if (this.destroyed) return;
        this.videos.update((list) => list.filter((v) => v.id !== vid.id));
      },
      error: () => {
        if (!this.destroyed) window.alert('Error al eliminar');
      }
    });
  }

  /* ---------------- PURGE ---------------- */

  onPurgeScopeChange(e: Event) {
    this.purgeScope.set((e.target as HTMLSelectElement).value as PurgeScope);
    this.refreshPurgeCount();
  }

  onPurgeFromChange(e: Event) {
    this.purgeFrom.set((e.target as HTMLInputElement).value);
    this.refreshPurgeCount();
  }

  onPurgeToChange(e: Event) {
    this.purgeTo.set((e.target as HTMLInputElement).value);
    this.refreshPurgeCount();
  }

  // Rango de conteo equivalente al que purgará el API:
  //  - day/week/month: retención → [-∞, now - SCOPE_MS]
  //  - range: fechas de los inputs (día inclusivo)
  private purgeRangeParams(): { startDate?: string; endDate?: string } {
    const scope = this.purgeScope();
    if (scope === 'range') {
      return {
        startDate: this.purgeFrom() ? `${this.purgeFrom()}T00:00:00.000Z` : undefined,
        endDate: this.purgeTo() ? `${this.purgeTo()}T23:59:59.999Z` : undefined
      };
    }
    return { endDate: new Date(Date.now() - SCOPE_MS[scope]).toISOString() };
  }

  // Conteo esperado = total del rango - favoritos del rango (los favoritos
  // están excluidos del purge).
  private refreshPurgeCount() {
    const scope = this.purgeScope();
    if (scope === 'range' && !(this.purgeFrom() && this.purgeTo())) {
      this.purgeExpected.set(null);
      return;
    }
    const id = ++this.countReqId;
    const params = this.purgeRangeParams();
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

  onPurge() {
    const scope = this.purgeScope();
    if (scope === 'range' && !(this.purgeFrom() && this.purgeTo())) return;
    if (!window.confirm(`¿Borrar los videos ${SCOPE_LABEL[scope]}? Los favoritos no se borran. Esta acción no se puede deshacer.`)) {
      return;
    }
    const req =
      scope === 'range'
        ? { scope, from: `${this.purgeFrom()}T00:00:00.000Z`, to: `${this.purgeTo()}T23:59:59.999Z` }
        : { scope };
    this.purging.set(true);
    this.purgeError.set(null);
    this.purgeOutcome.set(null);
    this.videoService.purgeVideos(req).subscribe({
      next: (res) => {
        if (this.destroyed) return;
        this.purging.set(false);
        this.purgeOutcome.set({
          expected: res.expected,
          purged: (res.purged || []).length,
          failed: (res.failed || []).length
        });
        this.purgeExpected.set(0);
        this.reload();
      },
      error: (err) => {
        if (this.destroyed) return;
        this.purging.set(false);
        this.purgeError.set(this.extractError(err));
      }
    });
  }

  private extractError(err: unknown): string {
    const e = err as { error?: { error?: string }; message?: string };
    return e?.error?.error || e?.message || 'Error desconocido';
  }
}
