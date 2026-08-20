import { Component, effect, ElementRef, input, OnDestroy, ViewChild } from '@angular/core';
import type { Video } from '../../models/video.model';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

@Component({
  selector: 'yi-player',
  imports: [],
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class Player implements OnDestroy {
  /* ---------- inputs ---------- */
  readonly video = input<Video | null>(null);
  readonly title = input('');
  readonly liveUrl = input<string | null>(null);

  /* ---------- referencias de template ---------- */
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  private destroyed = false;

  constructor() {
    // Al cambiar el video seleccionado: carga la fuente (si cambió) y reproduce.
    effect(() => {
      const vid = this.video();
      if (!vid || this.destroyed) return;
      const el = this.videoEl?.nativeElement;
      if (!el) return;
      el.muted = true;
      if (el.currentSrc !== vid.original_url) {
        el.src = vid.original_url;
      }
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    });

    // Fuente live: usa la URL tal cual como <video src> y reproduce.
    effect(() => {
      const url = this.liveUrl();
      if (!url || this.destroyed) return;
      const el = this.videoEl?.nativeElement;
      if (!el) return;
      el.muted = true;
      if (el.currentSrc !== url) {
        el.src = url;
      }
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    });
  }

  clipLabel(): string {
    const v = this.video();
    if (!v) return '';
    const d = new Date(v.timestamp);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  togglePlay() {
    const video = this.videoEl?.nativeElement;
    if (!video) return;
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    const video = this.videoEl?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
}
