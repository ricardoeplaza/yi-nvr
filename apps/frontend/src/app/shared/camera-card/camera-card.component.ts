import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Camera } from '../../models/camera.model';
import { FormatDatePipe } from '../format-date.pipe';

@Component({
  selector: 'yi-camera-card',
  standalone: true,
  imports: [RouterLink, FormatDatePipe],
  template: `
    <a class="camera-card" routerLink="/cameras/{{ camera().id }}">
      <div class="camera-thumb">
        <span class="camera-icon">📷</span>
      </div>
      <div class="camera-info">
        <span class="camera-name">
          <span class="mqtt-dot"
                [class.online]="camera()?.mqtt?.online === true"
                [class.offline]="camera()?.mqtt?.online === false"
                [title]="camera()?.mqtt ? (camera()!.mqtt!.online ? 'MQTT en línea' : 'MQTT sin conexión') : 'MQTT sin datos'">
          </span>
          {{ camera().name }}
          <span class="eco-badge" [class.generic]="camera().ecosystem !== 'yi-hack'">{{ ecoLabel() }}</span>
        </span>
        <span class="camera-count">{{ camera().video_count }} videos</span>
        @if (camera().has_videos && camera().last_video) {
          <span class="camera-last">{{ camera().last_video | formatDate }}</span>
        } @else {
          <span class="camera-last">Sin grabaciones</span>
        }
      </div>
    </a>
  `,
  styleUrl: './camera-card.component.scss'
})
export class CameraCardComponent {
  camera = input.required<Camera>();

  ecoLabel(): string {
    switch (this.camera().ecosystem) {
      case 'yi-hack': return 'yi-hack';
      case 'generic': return 'genérica';
      default: return this.camera().ecosystem;
    }
  }
}
