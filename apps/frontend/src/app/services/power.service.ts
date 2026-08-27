import { Injectable, inject, signal } from '@angular/core';
import { CameraService } from './camera.service';
import { ToastService } from '../shared/toast/toast.service';

@Injectable({ providedIn: 'root' })
export class PowerService {
  private readonly cameraService = inject(CameraService);
  private readonly toast = inject(ToastService);

  readonly powers = signal<Record<string, boolean>>({});

  isOn(id: string): boolean | null {
    return this.powers()[id] ?? null;
  }

  // Registra el estado real conocido (p. ej. camera_config['SWITCH_ON'] ===
  // 'yes'); no-op si el valor ya es igual.
  seed(id: string, on: boolean): void {
    if (this.isOn(id) === on) return;
    this.powers.update((powers) => ({ ...powers, [id]: on }));
  }

  // Toggle optimista con rollback: si setPower falla, se restaura el estado
  // anterior. Sin seed, el default es false (igual que en camera-detail).
  toggle(id: string): void {
    const actual = this.isOn(id) ?? false;
    const target = !actual;
    this.powers.update((powers) => ({ ...powers, [id]: target }));
    this.cameraService.setPower(id, target).subscribe({
      next: () => this.toast.show(target ? 'Cámara encendida' : 'Cámara apagada', 'success'),
      error: () => {
        this.powers.update((powers) => ({ ...powers, [id]: actual }));
        this.toast.show('Error al cambiar el encendido', 'error');
      },
    });
  }
}
