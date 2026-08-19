import { Component, inject, OnInit, OnDestroy, ViewChild, ElementRef, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CameraService } from '../../services/camera.service';
import { StreamService } from '../../services/stream.service';
import { Camera } from '../../models/camera.model';

@Component({
  selector: 'yi-camera-detail-page',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="cam-detail">
      <header class="cam-header">
        <a routerLink="/" class="back-btn" aria-label="Volver">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M15 18l-6-6 6-6"/></svg>
        </a>
        <h1 class="cam-title">{{ camera()?.name || '...' }}</h1>
        <button class="alarm-btn" aria-label="Sirena">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M12 2a5 5 0 0 0-5 5v2a8 8 0 0 1-2.3 5.6L4 15h16l-.7-.4A8 8 0 0 1 17 9V7a5 5 0 0 0-5-5Z"/><path d="M9.5 19a2.5 2.5 0 0 0 5 0"/></svg>
        </button>
      </header>

      <div class="player-wrap">
        <video #videoEl playsinline muted autoplay></video>
        @if (buffering()) {
          <div class="buffering-overlay"><div class="spinner"></div></div>
        }
        <div class="player-controls">
          <button class="ctrl-btn" (click)="toggleMute()" [attr.aria-label]="muted() ? 'Activar sonido' : 'Silenciar'">
            @if (muted()) {
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>
            } @else {
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M16 8a5 5 0 0 1 0 8"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>
            }
          </button>
          <button class="ctrl-btn" (click)="toggleFullscreen()" aria-label="Pantalla completa">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </button>
        </div>
      </div>

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
export class CameraDetailPage implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private cameraService = inject(CameraService);
  private streamService = inject(StreamService);

  @ViewChild('videoEl') videoEl!: ElementRef<HTMLVideoElement>;

  camera = signal<Camera | null>(null);
  buffering = signal(true);
  muted = signal(true);
  powerOn = signal(false);
  ledOn = signal(false);
  nightVision = signal(false);
  recMode = signal<'motion' | 'off'>('motion');

  private cameraId = '';
  private pc: RTCPeerConnection | null = null;

  ngOnInit() {
    this.cameraId = this.route.snapshot.paramMap.get('id') || '';
    this.loadCamera();
    this.startStream();
  }

  ngOnDestroy() {
    if (this.pc) {
      this.pc.close();
    }
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

  private startStream() {
    this.streamService.getStreamInfo(this.cameraId).subscribe({
      next: (info) => {
        if (info.success && info.ws_url) {
          this.streamService.startWebRtc(this.videoEl.nativeElement, info.ws_url)
            .then(() => this.buffering.set(false))
            .catch(err => {
              console.error('WebRTC failed', err);
              this.buffering.set(false);
            });
        } else {
          this.buffering.set(false);
        }
      },
      error: () => this.buffering.set(false)
    });
  }

  toggleMute() {
    const el = this.videoEl.nativeElement;
    el.muted = !el.muted;
    this.muted.set(el.muted);
  }

  toggleFullscreen() {
    const el = this.videoEl.nativeElement.parentElement;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen().catch(() => {});
    }
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
      next: () => this.startStream(),
      error: () => {}
    });
  }
}
