import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CameraCard } from '../../shared/camera-card/camera-card';
import { EmptyState } from '../../shared/empty-state/empty-state';
import { AppHeader } from '../../shared/app-header/app-header';
import { CameraService } from '../../services/camera.service';
import { PowerService } from '../../services/power.service';
import { ToastService } from '../../shared/toast/toast.service';
import { Camera } from '../../models/camera.model';

@Component({
  selector: 'yi-cameras',
  imports: [CameraCard, EmptyState, AppHeader],
  templateUrl: './cameras.html',
  styleUrl: './cameras.scss',
})
export class Cameras implements OnInit, OnDestroy {
  private cameraService = inject(CameraService);
  // Público: el template consulta isOn() por cámara.
  readonly powerService = inject(PowerService);
  private toast = inject(ToastService);

  cameras = signal<Camera[]>([]);
  loading = signal(true);

  private destroyed = false;

  ngOnInit() {
    this.cameraService.getCamerasStatus().subscribe({
      next: (res) => {
        if (this.destroyed) return;
        this.cameras.set(res.data);
        this.loading.set(false);
        // GET /cameras ya trae el status de cada yi-hack (estado real de los
        // toggles): siembra el encendido conocido sin llamadas extra.
        for (const cam of res.data) {
          const cfg = cam.status?.camera_config;
          if (cfg) {
            this.powerService.seed(cam.id, cfg['SWITCH_ON'] === 'yes');
          }
        }
      },
      error: () => {
        if (this.destroyed) return;
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
  }

  onTogglePower(cam: Camera) {
    this.powerService.toggle(cam.id);
  }

  onToggleRecMode(cam: Camera) {
    const current: 'motion' | 'off' =
      cam.status?.camera_config?.['SAVE_VIDEO_ON_MOTION'] === 'yes' ? 'motion' : 'off';
    const next: 'motion' | 'off' = current === 'motion' ? 'off' : 'motion';
    const prev = this.cameras();
    this.cameras.update((cams) =>
      cams.map((c) => {
        if (c.id !== cam.id) return c;
        const status = c.status ? { ...c.status } : c.status;
        if (!status) return { ...c };
        const camera_config = status.camera_config ? { ...status.camera_config } : {};
        camera_config['SAVE_VIDEO_ON_MOTION'] = next === 'motion' ? 'yes' : 'no';
        return { ...c, status: { ...status, camera_config } };
      }),
    );
    this.cameraService.setRecMode(cam.id, next).subscribe({
      next: () =>
        this.toast.show(next === 'motion' ? 'Grabación por movimiento' : 'Grabación continua', 'success'),
      error: () => {
        this.cameras.set(prev);
        this.toast.show('Error al cambiar la grabación', 'error');
      },
    });
  }

  // Fecha del clip cuyo thumbnail se muestra. null (sin clips) → la card
  // muestra "Sin grabaciones", coherente con el icono 📷 sin thumbnail.
  lastClipAt(cam: Camera): string | null {
    return cam.latest_video?.timestamp ?? null;
  }
}
