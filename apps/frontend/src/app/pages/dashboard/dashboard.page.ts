import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CameraService } from '../../services/camera.service';
import { VideoService } from '../../services/video.service';
import { Camera } from '../../models/camera.model';
import { Video } from '../../models/video.model';
import { Timeline } from '../../shared/timeline/timeline';
import { Player } from '../../shared/player/player';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

@Component({
  selector: 'yi-dashboard-page',
  standalone: true,
  imports: [Timeline, Player],
  template: `
    <div class="home">
      @if (loadingCameras()) {
        <div class="home-loading">Cargando…</div>
      } @else if (cameras().length === 0) {
        <div class="empty-home">
          <div class="empty-icon">📷</div>
          <h2>Sin cámaras</h2>
          <p>Configura cámaras en cameras.json</p>
        </div>
      } @else {
        <yi-player
          [video]="selectedVideo()"
          [title]="playerTitle()"
          [isFavorite]="selectedVideo()?.favorite ?? false"
          (nextVideo)="onVideoEnded($event)"
          (favorite)="onFavoriteToggle($event)"
        ></yi-player>

        <yi-timeline
          [videos]="videos()"
          [selectedId]="selectedVideo()?.id ?? null"
          (videoSelect)="selectVideo($event)"
          (rangeChange)="timelineRange.set($event)"
        ></yi-timeline>

        <div class="events">
          @if (videos().length === 0) {
            <div class="empty-day">Sin videos</div>
          } @else {
            @for (vid of videos(); track vid.id) {
              <div class="ev-row" [class.active]="selectedVideo()?.id === vid.id" (click)="selectVideo(vid)" style="--ev-color:#3b82f6">
                <div class="ev-thumb">
                  @if (vid.thumbnail_url) {
                    <img [src]="vid.thumbnail_url" alt="">
                  } @else {
                    <div class="art"></div>
                  }
                  <div class="play-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>
                  <div class="pause-ico"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg></div>
                </div>
                <div class="ev-mid">
                  <p class="ev-title">
                    Grabación
                    @if (vid.favorite) {
                      <svg class="ev-fav" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.6l5.8-.8Z" /></svg>
                    }
                  </p>
                  <p class="ev-sub">{{ fmtVideoDate(vid) }}&nbsp;·&nbsp;<span class="ev-cam">{{ cameraNameOf(vid) }}</span></p>
                </div>
                <span class="ev-time">{{ fmtVideoTime(vid) }}</span>
                <div class="ev-badge" style="--ev-color:#3b82f6">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15.5" cy="5" r="1.8" fill="currentColor" stroke="none"/><path d="M13 8l-2.5 3 2 2.3-1 5.2M10.5 11 7 12.5l-2 4M13 8 9.7 9.5l-.2 3.3M13 8l4 1.5 2.3 3.7"/></svg>
                </div>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
  styleUrl: './dashboard.page.scss'
})
export class DashboardPage implements OnInit, OnDestroy {
  private cameraService = inject(CameraService);
  private videoService = inject(VideoService);

  cameras = signal<Camera[]>([]);
  loadingCameras = signal(true);
  videos = signal<Video[]>([]);
  selectedVideo = signal<Video | null>(null);
  timelineRange = signal<{ from: number; to: number } | null>(null);

  private camByFtp = new Map<string, Camera>();
  private destroyed = false;

  ngOnInit() {
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        this.cameras.set(res.data);
        this.loadingCameras.set(false);
        if (res.data.length > 0) {
          this.camByFtp = new Map(res.data.map(c => [c.ftp_dir, c]));
        }
      },
      error: () => this.loadingCameras.set(false)
    });

    this.videoService.getVideos({}).subscribe({
      next: (res) => {
        if (this.destroyed) return;
        this.applyDataset(res.data || []);
      },
      error: () => {
        if (this.destroyed) return;
        this.applyDataset([]);
      }
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
  }

  /* ---------------- DATOS ---------------- */

  private applyDataset(videos: Video[]) {
    const sorted = [...videos].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    this.videos.set(sorted);
  }

  playerTitle(): string {
    const v = this.selectedVideo();
    return v ? this.cameraNameOf(v) : '';
  }

  cameraNameOf(vid: Video): string {
    return this.camByFtp.get(vid.camera_name)?.name || vid.camera_name;
  }

  fmtVideoDate(vid: Video): string {
    const d = new Date(vid.timestamp);
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  }

  fmtVideoTime(vid: Video): string {
    const d = new Date(vid.timestamp);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------------- REPRODUCTOR ---------------- */

  selectVideo(vid: Video) {
    if (this.destroyed) return;
    this.selectedVideo.set(vid);
  }

  // Autoplay: al terminar un clip, avanza al siguiente más nuevo siguiendo el
  // orden natural del timeline (izquierda → derecha = cronológico). La lista
  // está ordenada DESC (más reciente primero), así que el "siguiente más nuevo"
  // es el índice anterior. Se detiene en el clip más reciente (índice 0).
  onVideoEnded(vid: Video) {
    if (this.destroyed) return;
    const list = this.videos();
    const idx = list.findIndex((v) => v.id === vid.id);
    if (idx < 0) return;
    const nextIdx = idx - 1;
    if (nextIdx >= 0) {
      this.selectVideo(list[nextIdx]);
    }
  }

  // El player emite el clip al pulsar la estrella (no decide la dirección).
  // Se actualiza el estado de forma optimista (los dos signals son
  // independientes: la lista y el clip seleccionado) y se persiste en la BD;
  // si la API falla, se revierte al estado anterior.
  onFavoriteToggle(vid: Video) {
    if (this.destroyed) return;
    const next = !vid.favorite;
    this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: next } : v)));
    const sel = this.selectedVideo();
    if (sel?.id === vid.id) {
      this.selectedVideo.set({ ...sel, favorite: next });
    }
    this.videoService.setFavorite(vid.id, next).subscribe({
      error: () => {
        if (this.destroyed) return;
        this.videos.update((list) => list.map((v) => (v.id === vid.id ? { ...v, favorite: vid.favorite } : v)));
        const s = this.selectedVideo();
        if (s?.id === vid.id) {
          this.selectedVideo.set({ ...s, favorite: vid.favorite });
        }
      }
    });
  }

}
