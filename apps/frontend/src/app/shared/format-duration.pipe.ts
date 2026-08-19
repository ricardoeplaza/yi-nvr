import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'formatDuration', standalone: true })
export class FormatDurationPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value == null || isNaN(value) || value < 0) {
      return '0:00';
    }
    const total = Math.round(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
}
