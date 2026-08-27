import { Component, computed, input, output, signal } from '@angular/core';
import type { Video } from '../../models/video.model';
import { FormatDurationPipe } from '../format-duration.pipe';

const pad2 = (n: number) => String(n).padStart(2, '0');

@Component({
  selector: 'yi-gallery-card',
  imports: [FormatDurationPipe],
  templateUrl: './gallery-card.html',
  styleUrl: './gallery-card.scss',
})
export class GalleryCard {
  /* ---------- inputs ---------- */
  readonly video = input.required<Video>();
  readonly isSelected = input(false);
  // Modo selección múltiple activo: muestra el dot, oculta favorito/play.
  readonly selecting = input(false);
  readonly renaming = input(false);
  readonly renameValue = input('');
  readonly renameError = input<string | null>(null);

  /* ---------- outputs ---------- */
  // Click en la thumb (reproducir o seleccionar según el modo del padre).
  readonly select = output<Video>();
  // Click en el botón de play.
  readonly play = output<Video>();
  readonly favorite = output<Video>();
  readonly renameStart = output<Video>();
  readonly renameInput = output<Event>();
  readonly renameCommit = output<Video>();
  readonly renameCancel = output<void>();
  readonly remove = output<Video>();

  // Preview animado: la card gestiona su propio hover. Solo muestra el webp
  // mientras el ratón está encima; al salir vuelve al thumbnail.
  private readonly previewing = signal(false);
  readonly cardSrc = computed(() => {
    const v = this.video();
    return this.previewing() && v.preview_url ? v.preview_url : v.thumbnail_url;
  });

  onEnter() {
    if (this.video().preview_url) this.previewing.set(true);
  }

  onLeave() {
    this.previewing.set(false);
  }

  readonly osdLabel = computed(() => {
    const d = new Date(this.video().timestamp);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
      d.getMinutes()
    )}:${pad2(d.getSeconds())}`;
  });
}
