import { Component, input } from '@angular/core';
import { Video } from '../../models/video.model';
import { FormatDatePipe } from '../format-date.pipe';
import { FormatDurationPipe } from '../format-duration.pipe';

@Component({
  selector: 'yi-video-card',
  standalone: true,
  imports: [FormatDatePipe, FormatDurationPipe],
  template: `
    <div class="video-card">
      <img class="video-thumb" [src]="video().thumbnail_url" alt="" />
      <div class="video-info">
        <span class="video-camera">{{ video().camera_name }}</span>
        <span class="video-time">{{ video().timestamp | formatDate }}</span>
        <span class="video-duration">{{ video().duration | formatDuration }}</span>
      </div>
      <div class="video-actions">
        @if (video().file_size) {
          <span class="video-size">{{ formatSize(video().file_size) }}</span>
        }
        @if (onDelete()) {
          <button class="video-delete" type="button" (click)="onDelete()!()" aria-label="Eliminar">🗑</button>
        }
      </div>
    </div>
  `,
  styleUrl: './video-card.component.scss'
})
export class VideoCardComponent {
  video = input.required<Video>();
  onDelete = input<() => void>();

  formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${Math.round(bytes / 1024)} KB`;
  }
}
