import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CameraCard } from '../../shared/camera-card/camera-card';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { AppHeader } from '../../shared/app-header/app-header';
import { CameraService } from '../../services/camera.service';
import { PowerService } from '../../services/power.service';
import { Camera } from '../../models/camera.model';

@Component({
  selector: 'yi-cameras',
  imports: [CameraCard, EmptyStateComponent, AppHeader],
  templateUrl: './cameras.html',
  styleUrl: './cameras.scss',
})
export class Cameras implements OnInit, OnDestroy {
  private cameraService = inject(CameraService);
  // Público: el template consulta isOn() por cámara.
  readonly powerService = inject(PowerService);

  cameras = signal<Camera[]>([]);
  loading = signal(true);

  private destroyed = false;

  ngOnInit() {
    this.cameraService.getCameras().subscribe({
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

  // Fecha del clip cuyo thumbnail se muestra. null (sin clips) → la card
  // muestra "Sin grabaciones", coherente con el icono 📷 sin thumbnail.
  lastClipAt(cam: Camera): string | null {
    return cam.latest_video?.timestamp ?? null;
  }
}
