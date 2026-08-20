import { Component, inject, OnInit, signal } from '@angular/core';
import { CameraCardComponent } from '../../shared/camera-card/camera-card.component';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { CameraService } from '../../services/camera.service';
import { Camera } from '../../models/camera.model';

@Component({
  selector: 'yi-cameras',
  imports: [CameraCardComponent, EmptyStateComponent],
  templateUrl: './cameras.html',
  styleUrl: './cameras.scss',
})
export class Cameras implements OnInit {
  private cameraService = inject(CameraService);

  cameras = signal<Camera[]>([]);
  loading = signal(true);

  ngOnInit() {
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        this.cameras.set(res.data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }
}
