import { Component, inject, OnInit, signal } from '@angular/core';
import { VideoCardComponent } from '../../shared/video-card/video-card.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { VideoService } from '../../services/video.service';
import { CameraService } from '../../services/camera.service';
import { Video } from '../../models/video.model';
import { Camera } from '../../models/camera.model';

@Component({
  selector: 'yi-gallery-page',
  standalone: true,
  imports: [VideoCardComponent, EmptyStateComponent],
  template: `
    <div class="gallery">
      <header class="gallery-header">
        <h1>Galería</h1>
      </header>

      <div class="filter-bar">
        <select class="filter-select" [value]="cameraFilter()" (change)="onCameraChange($event)">
          <option value="">Todas</option>
          @for (cam of cameras(); track cam.id) {
            <option [value]="cam.name">{{ cam.name }}</option>
          }
        </select>
        <div class="date-range">
          <input type="date" [value]="startDate()" (change)="onStartDateChange($event)" aria-label="Desde" />
          <span class="date-sep">—</span>
          <input type="date" [value]="endDate()" (change)="onEndDateChange($event)" aria-label="Hasta" />
        </div>
        @if (hasFilters()) {
          <button class="clear-btn" (click)="clearFilters()">Limpiar</button>
        }
      </div>

      @if (loading()) {
        <div class="loading">Cargando…</div>
      } @else if (videos().length) {
        <div class="video-list">
          @for (vid of videos(); track vid.id) {
            <yi-video-card [video]="vid" [onDelete]="() => deleteVideo(vid.id)" />
          }
        </div>
      } @else {
        <yi-empty-state icon="🎬" title="Sin grabaciones" subtitle="Ajusta los filtros o espera nuevas grabaciones" />
      }
    </div>
  `,
  styleUrl: './gallery.page.scss'
})
export class GalleryPage implements OnInit {
  private videoService = inject(VideoService);
  private cameraService = inject(CameraService);

  cameras = signal<Camera[]>([]);
  videos = signal<Video[]>([]);
  loading = signal(true);
  cameraFilter = signal('');
  startDate = signal('');
  endDate = signal('');

  hasFilters = signal(false);

  ngOnInit() {
    this.cameraService.getCameras().subscribe({
      next: (res) => this.cameras.set(res.data),
      error: () => {}
    });
    this.loadVideos();
  }

  onCameraChange(e: Event) {
    this.cameraFilter.set((e.target as HTMLSelectElement).value);
    this.applyFilters();
  }

  onStartDateChange(e: Event) {
    this.startDate.set((e.target as HTMLInputElement).value);
    this.applyFilters();
  }

  onEndDateChange(e: Event) {
    this.endDate.set((e.target as HTMLInputElement).value);
    this.applyFilters();
  }

  clearFilters() {
    this.cameraFilter.set('');
    this.startDate.set('');
    this.endDate.set('');
    this.loadVideos();
  }

  private applyFilters() {
    const has = !!(this.cameraFilter() || this.startDate() || this.endDate());
    this.hasFilters.set(has);
    this.loadVideos();
  }

  private loadVideos() {
    this.loading.set(true);
    this.videoService.getVideos({
      camera: this.cameraFilter() || undefined,
      startDate: this.startDate() || undefined,
      endDate: this.endDate() || undefined,
    }).subscribe({
      next: (res) => {
        this.videos.set(res.data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  deleteVideo(id: number) {
    if (!confirm('¿Eliminar esta grabación?')) return;
    this.videoService.deleteVideo(id).subscribe({
      next: () => {
        this.videos.update(v => v.filter(x => x.id !== id));
      },
      error: () => alert('Error al eliminar')
    });
  }
}
