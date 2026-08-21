import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { CameraService } from '../../services/camera.service';
import { StreamService } from '../../services/stream.service';
import { Camera } from '../../models/camera.model';
import { Player, PlayerLiveStatus } from '../../shared/player/player';

@Component({
  selector: 'yi-camera-detail-page',
  standalone: true,
  imports: [Player],
  template: `
    <div class="cam-detail">
      <yi-player
        [title]="camera()?.name || ''"
        [liveUrl]="liveUrl()"
        [liveFallbackMseUrl]="liveFallbackMseUrl()"
        (liveStatus)="onLiveStatusChange($event)"
      ></yi-player>

      @if (liveStatus() === 'loading') {
        <p class="live-status">Cargando…</p>
      } @else if (liveStatus() === 'error') {
        <p class="live-status error">Error de stream</p>
      }

      @if (camera()) {
        <div class="controls-section">
          <h2>Controles</h2>
          <div class="controls-grid">
            @if (camera()!.capabilities.power) {
              <button class="toggle-btn" [class.active]="powerOn()" (click)="togglePower()">
                <span class="toggle-label">Encendido</span>
                <span class="toggle-state">{{ powerOn() ? 'ON' : 'OFF' }}</span>
              </button>
            }
            @if (camera()!.capabilities.led) {
              <button class="toggle-btn" [class.active]="ledOn()" (click)="toggleLed()">
                <span class="toggle-label">LED</span>
                <span class="toggle-state">{{ ledOn() ? 'ON' : 'OFF' }}</span>
              </button>
            }
            @if (camera()!.capabilities.ircut) {
              <button class="toggle-btn" [class.active]="nightVision()" (click)="toggleNightVision()">
                <span class="toggle-label">Visión nocturna</span>
                <span class="toggle-state">{{ nightVision() ? 'ON' : 'OFF' }}</span>
              </button>
            }
            @if (camera()!.capabilities.rec_mode) {
              <button class="toggle-btn" [class.active]="recMode() === 'motion'" (click)="toggleRecMode()">
                <span class="toggle-label">Grabación</span>
                <span class="toggle-state">{{ recMode() === 'motion' ? 'Movimiento' : 'Off' }}</span>
              </button>
            }
            <button class="reload-btn" (click)="reloadCamera()">
              Recargar cámara
            </button>
          </div>
        </div>

        <div class="cam-info-section">
          <h2>Información</h2>
          <div class="info-grid">
            <div class="info-row"><span class="info-label">Host</span><span class="info-value">{{ camera()!.host }}</span></div>
            <div class="info-row"><span class="info-label">Videos</span><span class="info-value">{{ camera()!.video_count }}</span></div>
            @if (camera()!.last_video) {
              <div class="info-row"><span class="info-label">Último video</span><span class="info-value">{{ camera()!.last_video }}</span></div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './camera-detail.page.scss'
})
export class CameraDetailPage implements OnInit {
  private route = inject(ActivatedRoute);
  private cameraService = inject(CameraService);
  private streamService = inject(StreamService);

  camera = signal<Camera | null>(null);
  liveUrl = signal<string | null>(null);
  liveFallbackMseUrl = signal<string | null>(null);
  liveStatus = signal<PlayerLiveStatus>('idle');
  powerOn = signal(false);
  ledOn = signal(false);
  nightVision = signal(false);
  recMode = signal<'motion' | 'off'>('motion');

  private cameraId = '';

  ngOnInit() {
    this.cameraId = this.route.snapshot.paramMap.get('id') || '';
    this.loadCamera();
    this.loadStream();
  }

  private loadCamera() {
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        const cam = res.data.find(c => c.id === this.cameraId);
        this.camera.set(cam || null);
      },
      error: () => {}
    });
  }

  private loadStream() {
    this.streamService.getStreamInfo(this.cameraId).subscribe({
      next: (info) => {
        // Primario: WebRTC/WHEP (webrtc_url); fallback automático: MSE (mse_url).
        if (info.success && info.webrtc_url) {
          this.liveUrl.set(info.webrtc_url);
          this.liveFallbackMseUrl.set(info.mse_url || null);
        }
      },
      error: () => {}
    });
  }

  onLiveStatusChange(status: PlayerLiveStatus) {
    this.liveStatus.set(status);
  }

  togglePower() {
    const newVal = !this.powerOn();
    this.powerOn.set(newVal);
    this.cameraService.setPower(this.cameraId, newVal).subscribe({ error: () => this.powerOn.set(!newVal) });
  }

  toggleLed() {
    const newVal = !this.ledOn();
    this.ledOn.set(newVal);
    this.cameraService.setLed(this.cameraId, newVal).subscribe({ error: () => this.ledOn.set(!newVal) });
  }

  toggleNightVision() {
    const newVal = !this.nightVision();
    this.nightVision.set(newVal);
    this.cameraService.setNightVision(this.cameraId, newVal).subscribe({ error: () => this.nightVision.set(!newVal) });
  }

  toggleRecMode() {
    const newVal: 'motion' | 'off' = this.recMode() === 'motion' ? 'off' : 'motion';
    this.recMode.set(newVal);
    this.cameraService.setRecMode(this.cameraId, newVal).subscribe({ error: () => this.recMode.set(newVal === 'motion' ? 'off' : 'motion') });
  }

  reloadCamera() {
    this.cameraService.reloadCamera(this.cameraId).subscribe({
      next: () => this.loadStream(),
      error: () => {}
    });
  }
}
