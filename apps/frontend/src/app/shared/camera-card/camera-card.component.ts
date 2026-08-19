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
        <span class="camera-name">{{ camera().name }}</span>
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
}
