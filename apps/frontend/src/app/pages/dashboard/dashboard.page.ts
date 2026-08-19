import { Component, inject, OnInit, signal } from '@angular/core';
import { CameraCardComponent } from '../../shared/camera-card/camera-card.component';
import { VideoCardComponent } from '../../shared/video-card/video-card.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { CameraService } from '../../services/camera.service';
import { VideoService } from '../../services/video.service';
import { Camera } from '../../models/camera.model';
import { Video } from '../../models/video.model';

@Component({
  selector: 'yi-dashboard-page',
  standalone: true,
  imports: [CameraCardComponent, VideoCardComponent, EmptyStateComponent],
  template: `
    <div class="dashboard">
      <header class="dash-header">
        <h1>Yi NVR</h1>
        <p class="dash-subtitle">
          @if (cameras().length) {
            {{ cameras().length }} cámara{{ cameras().length !== 1 ? 's' : '' }} conectada{{ cameras().length !== 1 ? 's' : '' }}
          }
        </p>
      </header>

      <section class="section">
        <h2 class="section-title">Cámaras</h2>
        @if (loadingCameras()) {
          <div class="loading">Cargando…</div>
        } @else if (cameras().length) {
          <div class="camera-grid">
            @for (cam of cameras(); track cam.id) {
              <yi-camera-card [camera]="cam" />
            }
          </div>
        } @else {
          <yi-empty-state icon="📷" title="Sin cámaras" subtitle="Configura cámaras en cameras.json" />
        }
      </section>

      <section class="section">
        <h2 class="section-title">Últimas grabaciones</h2>
        @if (loadingVideos()) {
          <div class="loading">Cargando…</div>
        } @else if (videos().length) {
          <div class="video-list">
            @for (vid of videos(); track vid.id) {
              <yi-video-card [video]="vid" />
            }
          </div>
        } @else {
          <yi-empty-state icon="🎬" title="Sin grabaciones" />
        }
      </section>
    </div>
  `,
  styleUrl: './dashboard.page.scss'
})
export class DashboardPage implements OnInit {
  private cameraService = inject(CameraService);
  private videoService = inject(VideoService);

  cameras = signal<Camera[]>([]);
  videos = signal<Video[]>([]);
  loadingCameras = signal(true);
  loadingVideos = signal(true);

  ngOnInit() {
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        this.cameras.set(res.data);
        this.loadingCameras.set(false);
      },
      error: () => this.loadingCameras.set(false)
    });

    this.videoService.getVideos({ limit: 10 }).subscribe({
      next: (res) => {
        this.videos.set(res.data);
        this.loadingVideos.set(false);
      },
      error: () => this.loadingVideos.set(false)
    });
  }
}
