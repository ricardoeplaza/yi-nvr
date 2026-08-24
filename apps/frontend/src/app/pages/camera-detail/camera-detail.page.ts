import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CameraService } from '../../services/camera.service';
import { StreamService } from '../../services/stream.service';
import { Camera, CameraStatus } from '../../models/camera.model';
import { Player, PlayerLiveStatus } from '../../shared/player/player';
import { FormatDatePipe } from '../../shared/format-date.pipe';

const STATUS_POLL_MS = 30000;

@Component({
  selector: 'yi-camera-detail-page',
  standalone: true,
  imports: [Player, FormatDatePipe, RouterLink],
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
        @if (status()?.capabilities.live_status && status()?.state) {
          <div class="cam-state" [class.on]="status()!.state === 'on'"
               [class.off]="status()!.state === 'off'"
               [class.unreachable]="status()!.state === 'unreachable'">
            <span class="state-dot"></span>
            <span>{{ stateLabel() }}</span>
            @if (status()!.http === false && status()!.state === 'on') {
              <span class="state-sub">HTTP de la cámara caído · estado por MQTT</span>
            }
          </div>
        }

        @if (status()?.capabilities.sd) {
          <div class="sd-section">
            <div class="sd-header">
              <span class="sd-label">Tarjeta SD</span>
              @if (status()?.sd) {
                <span class="sd-value">{{ formatMb(status()!.sd!.used_mb) }} / {{ formatMb(status()!.sd!.total_mb) }}</span>
              } @else {
                <span class="sd-value dim">No disponible</span>
              }
            </div>
            @if (status()?.sd) {
              <div class="sd-bar">
                <div class="sd-fill" [style.width.%]="sdUsedPct()"></div>
              </div>
            }
            <a class="sd-manage" [routerLink]="['/cameras', camera()!.id, 'storage']">
              Gestionar almacenamiento
            </a>
          </div>
        }

        @if (status()?.capabilities.controls || status()?.capabilities.push) {
          <div class="controls-section">
            <h2>Controles</h2>
            @if (actionError()) {
              <p class="action-error">{{ actionError() }}</p>
            }
            <div class="controls-grid">
              @if (status()?.capabilities.controls) {
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
              }
              @if (status()?.capabilities.push) {
                <button class="toggle-btn" [class.active]="pushEnabled()" (click)="togglePush()">
                  <span class="toggle-label">Push de movimiento</span>
                  <span class="toggle-state">{{ pushEnabled() ? 'ON' : 'OFF' }}</span>
                </button>
              }
              @if (status()?.capabilities.controls && status()?.system_config) {
                <button class="toggle-btn" [class.active]="httpdOn()" (click)="toggleHttpd()">
                  <span class="toggle-label">Servidor HTTP *</span>
                  <span class="toggle-state">{{ httpdOn() ? 'ON' : 'OFF' }}</span>
                </button>
              }
              @if (status()?.capabilities.controls) {
                <button class="danger-btn" [disabled]="status()?.http === false" (click)="rebootCamera()">
                  Reiniciar cámara
                </button>
              }
            </div>
            @if (status()?.capabilities.controls) {
              <p class="section-note">
                * Requiere reinicio de la cámara para aplicarse; los demás controles son inmediatos.
                Desactivar «Servidor HTTP» impide el estado en vivo y los controles HTTP (el MQTT sigue funcionando).
                @if (status()?.http === false) {
                  «Reiniciar cámara» y «Servidor HTTP» requieren el httpd de la cámara (ahora mismo no disponible).
                }
              </p>
            }
          </div>
        }

        <div class="cam-info-section">
          <h2>Información</h2>
          <div class="info-grid">
            <div class="info-row"><span class="info-label">Host</span><span class="info-value">{{ camera()!.host }}</span></div>
            <div class="info-row"><span class="info-label">Videos</span><span class="info-value">{{ camera()!.video_count }}</span></div>
            @if (camera()!.last_video) {
              <div class="info-row"><span class="info-label">Último video</span><span class="info-value">{{ camera()!.last_video | formatDate }}</span></div>
            }
            @if (status()?.capabilities.system) {
              <div class="info-row"><span class="info-label">Firmware</span><span class="info-value">{{ status()?.status?.fw_version || 'No disponible' }}</span></div>
              <div class="info-row"><span class="info-label">Uptime</span><span class="info-value">{{ status()?.status?.uptime ? formatUptime(status()!.status!.uptime) : 'No disponible' }}</span></div>
            }
            @if (status()?.capabilities.live_status) {
              <div class="info-row"><span class="info-label">IP</span><span class="info-value">{{ status()?.status?.local_ip || 'No disponible' }}</span></div>
              <div class="info-row"><span class="info-label">MAC</span><span class="info-value">{{ status()?.status?.mac_addr || 'No disponible' }}</span></div>
              <div class="info-row"><span class="info-label">Serie</span><span class="info-value">{{ status()?.status?.serial_number || 'No disponible' }}</span></div>
            }
            @if (status()?.capabilities.wifi) {
              <div class="info-row"><span class="info-label">WiFi</span><span class="info-value">{{ wifiValue() }}</span></div>
            }
            @if (status()?.last_event) {
              <div class="info-row"><span class="info-label">Último evento</span><span class="info-value">{{ status()!.last_event!.event_type }} · {{ status()!.last_event!.received_at | formatDate }}</span></div>
            }
            @if (status()?.last_motion) {
              <div class="info-row"><span class="info-label">Último movimiento</span><span class="info-value">{{ status()!.last_motion!.received_at | formatDate }}</span></div>
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

  camera = signal<Camera | null>(null);
  status = signal<CameraStatus | null>(null);
  liveUrl = signal<string | null>(null);
  liveFallbackMseUrl = signal<string | null>(null);
  liveStatus = signal<PlayerLiveStatus>('idle');
  powerOn = signal(false);
  ledOn = signal(false);
  nightVision = signal(false);
  recMode = signal<'motion' | 'off'>('motion');
  pushEnabled = signal(true);
  httpdOn = signal(true);
  // Error de la última acción (p. ej. 409 UNSUPPORTED_ECOSYSTEM si el estado
  // cacheado está desactualizado). Se muestra sin romper la página.
  actionError = signal<string | null>(null);

  private cameraId = '';
  private statusTimer: number | null = null;

  ngOnInit() {
    this.cameraId = this.route.snapshot.paramMap.get('id') || '';
    this.loadCamera();
    this.loadStream();
    this.loadStatus();
    this.statusTimer = window.setInterval(() => this.loadStatus(), STATUS_POLL_MS);
  }

  ngOnDestroy() {
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
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

  private loadStatus() {
    this.cameraService.getCameraStatus(this.cameraId).subscribe({
      next: (res) => {
        const s = res.data;
        this.status.set(s);
        // Estado real de la cámara: los toggles MQTT se inicializan desde
        // la config real (sí se puede la cámara; si no, se mantiene el
        // último valor conocido).
        if (s.camera_config) {
          this.powerOn.set(s.camera_config['SWITCH_ON'] === 'yes');
          this.ledOn.set(s.camera_config['LED'] === 'yes');
          this.nightVision.set(s.camera_config['IR'] === 'yes');
          this.recMode.set(s.camera_config['SAVE_VIDEO_ON_MOTION'] === 'yes' ? 'motion' : 'off');
        }
        if (s.system_config) {
          this.httpdOn.set(s.system_config['HTTPD'] === 'yes');
        }
        this.pushEnabled.set(s.push_enabled);
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

  stateLabel(): string {
    switch (this.status()?.state) {
      case 'on': return 'En línea';
      case 'off': return 'Apagada';
      case 'unreachable': return 'Sin conexión';
      default: return '…';
    }
  }

  sdUsedPct(): number {
    const sd = this.status()?.sd;
    return sd ? 100 - sd.free_pct : 0;
  }

  formatMb(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  }

  wifiValue(): string {
    const st = this.status()?.status;
    return st?.wlan_essid ? `${st.wlan_essid} (${st.wlan_strength} dBm)` : 'No disponible';
  }

  formatUptime(uptime?: string | number): string {
    const secs = Math.floor(Number(uptime) || 0);
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d} d ${h} h`;
    if (h > 0) return `${h} h ${m} min`;
    return `${m} min`;
  }

  // Extrae el mensaje de error del body de la API ({success, error}) o, en
  // fallo de red, el mensaje del HttpClient.
  private extractError(err: unknown): string {
    const e = err as { error?: { error?: string }; message?: string };
    return e?.error?.error || e?.message || 'Error desconocido';
  }

  togglePower() {
    const newVal = !this.powerOn();
    this.powerOn.set(newVal);
    this.cameraService.setPower(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.powerOn.set(!newVal);
        this.actionError.set(this.extractError(err));
      }
    });
  }

  toggleLed() {
    const newVal = !this.ledOn();
    this.ledOn.set(newVal);
    this.cameraService.setLed(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.ledOn.set(!newVal);
        this.actionError.set(this.extractError(err));
      }
    });
  }

  toggleNightVision() {
    const newVal = !this.nightVision();
    this.nightVision.set(newVal);
    this.cameraService.setNightVision(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.nightVision.set(!newVal);
        this.actionError.set(this.extractError(err));
      }
    });
  }

  toggleRecMode() {
    const newVal: 'motion' | 'off' = this.recMode() === 'motion' ? 'off' : 'motion';
    this.recMode.set(newVal);
    this.cameraService.setRecMode(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.recMode.set(newVal === 'motion' ? 'off' : 'motion');
        this.actionError.set(this.extractError(err));
      }
    });
  }

  togglePush() {
    const newVal = !this.pushEnabled();
    this.pushEnabled.set(newVal);
    this.cameraService.setPush(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.pushEnabled.set(!newVal);
        this.actionError.set(this.extractError(err));
      }
    });
  }

  toggleHttpd() {
    const newVal = !this.httpdOn();
    this.httpdOn.set(newVal);
    this.cameraService.setHttpd(this.cameraId, newVal).subscribe({
      next: () => this.actionError.set(null),
      error: (err) => {
        this.httpdOn.set(!newVal);
        this.actionError.set(this.extractError(err));
      }
    });
  }

  rebootCamera() {
    if (!window.confirm('¿Reiniciar la cámara? Perderás la conexión en unos segundos.')) {
      return;
    }
    this.cameraService.rebootCamera(this.cameraId).subscribe({
      next: () => {
        this.actionError.set(null);
        this.status.set(null);
      },
      error: (err) => this.actionError.set(this.extractError(err))
    });
  }
}
