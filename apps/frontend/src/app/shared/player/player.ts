import { Component, effect, ElementRef, inject, input, output, OnDestroy, ViewChild } from '@angular/core';
import type { Video } from '../../models/video.model';
import { StreamService } from '../../services/stream.service';

export type PlayerLiveStatus = 'idle' | 'loading' | 'playing' | 'error';

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
  readonly liveFallbackMseUrl = input<string | null>(null);

  /* ---------- estado live ---------- */
  readonly liveStatus = output<PlayerLiveStatus>();

  /* ---------- referencias de template ---------- */
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;

  private readonly streamService = inject(StreamService);
  private destroyed = false;
  private liveActive = false;
  private livePlaying = false;
  private liveFallbackTried = false;
  private liveTimer: number | null = null;
  private liveRtc: RTCPeerConnection | null = null;
  private liveMseAbort: AbortController | null = null;
  private liveMse: MediaSource | null = null;
  private liveMseObjectUrl = '';

  constructor() {
    // Al cambiar el video seleccionado: carga la fuente (si cambió) y reproduce.
    effect(() => {
      const vid = this.video();
      if (!vid || this.destroyed) return;
      this.resetLive();
      const el = this.videoEl?.nativeElement;
      if (!el) return;
      el.muted = true;
      if (el.currentSrc !== vid.original_url) {
        el.src = vid.original_url;
      }
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    });

    // Fuente live: primaria = WebRTC (WHEP) directo. Si el handshake falla o no
    // hay 'playing' en ~10 s y hay liveFallbackMseUrl, fallback a MSE real
    // (MediaSource + SourceBuffer contra el mp4 fragmentado de go2rtc).
    effect(() => {
      const url = this.liveUrl();
      const mseUrl = this.liveFallbackMseUrl();
      if (!url || this.destroyed) {
        this.resetLive();
        return;
      }
      const el = this.videoEl?.nativeElement;
      if (!el) return;
      this.resetLive();
      this.liveActive = true;
      this.liveStatus.emit('loading');
      el.muted = true;
      this.streamService
        .startWebRtc(el, url)
        .then((pc) => {
          if (!this.liveActive) {
            pc.close();
            return;
          }
          this.liveRtc = pc;
          const p = el.play();
          if (p && p.catch) p.catch(() => {});
          // Si tras el handshake no hay 'playing' en ~10 s, fallback a MSE.
          this.liveTimer = window.setTimeout(() => {
            this.liveTimer = null;
            if (this.liveActive && !this.livePlaying && !this.liveFallbackTried) {
              this.tryMseFallback(el, mseUrl);
            }
          }, 10000);
        })
        .catch(() => {
          if (!this.liveActive) return;
          this.tryMseFallback(el, mseUrl);
        });
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

  // Eventos del <video> (solo actúan en modo live; los clips no los usan).
  onLivePlaying() {
    if (!this.liveActive) return;
    this.clearLiveTimer();
    this.livePlaying = true;
    this.liveStatus.emit('playing');
  }

  onLiveError() {
    if (!this.liveActive) return;
    this.clearLiveTimer();
    const el = this.videoEl?.nativeElement;
    if (el && !this.liveFallbackTried && this.liveFallbackMseUrl()) {
      this.tryMseFallback(el, this.liveFallbackMseUrl());
    } else {
      this.liveStatus.emit('error');
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.resetLive();
    const video = this.videoEl?.nativeElement;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  private clearLiveTimer() {
    if (this.liveTimer !== null) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
  }

  /**
   * Fallback MSE real (un solo intento): fetch del endpoint mp4 fragmentado de
   * go2rtc → bucle de reader → MediaSource + SourceBuffer. Replica el
   * algoritmo MSE de la UI de go2rtc (video-rtc.js): el contentType lo da el
   * propio Content-Type de la respuesta (p. ej. video/mp4;
   * codecs="hvc1.1.6.L153.B0"), sb.mode='segments', ventana de ~5 s con
   * setLiveSeekableRange y catch-up por playbackRate.
   */
  private tryMseFallback(el: HTMLVideoElement, mseUrl: string | null) {
    if (this.liveFallbackTried) return;
    this.liveFallbackTried = true;
    this.clearLiveTimer();
    if (this.liveRtc) {
      this.liveRtc.close();
      this.liveRtc = null;
      el.srcObject = null;
    }
    if (!mseUrl || typeof MediaSource === 'undefined') {
      this.liveStatus.emit('error');
      return;
    }
    this.liveStatus.emit('loading');

    const abort = new AbortController();
    this.liveMseAbort = abort;
    let objectUrl = this.liveMseObjectUrl;

    const cleanup = () => {
      abort.abort();
      if (this.liveMseAbort === abort) this.liveMseAbort = null;
      const ms = this.liveMse;
      if (ms) {
        this.liveMse = null;
        try {
          ms.endOfStream();
        } catch {
          // ya cerrado
        }
      }
      if (objectUrl) {
        const u = objectUrl;
        URL.revokeObjectURL(u);
        objectUrl = '';
        this.liveMseObjectUrl = '';
        if (el.src === u) {
          el.removeAttribute('src');
          el.load();
        }
      }
    };

    fetch(mseUrl, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`MSE: HTTP ${res.status}`);
        // go2rtc anuncia el codec en el Content-Type (p. ej.
        // video/mp4; codecs="avc1.640029" o "hvc1.1.6.L153.B0"): se usa tal
        // cual como contentType del SourceBuffer.
        const contentType = res.headers.get('Content-Type') || 'video/mp4';
        if (!MediaSource.isTypeSupported(contentType)) {
          throw new Error(`MSE: codec no soportado (${contentType})`);
        }

        const ms = new MediaSource();
        this.liveMse = ms;
        objectUrl = URL.createObjectURL(ms);
        this.liveMseObjectUrl = objectUrl;
        el.srcObject = null;
        el.src = objectUrl;

        await new Promise<void>((resolve, reject) => {
          ms.addEventListener('sourceopen', () => resolve(), { once: true });
          ms.addEventListener('sourceended', () => reject(new Error('MSE: sourceended')), { once: true });
          ms.addEventListener('sourceerror', () => reject(new Error('MSE: sourceerror')), { once: true });
        });

        const sb = ms.addSourceBuffer(contentType);
        if ('mode' in sb) sb.mode = 'segments';

        // Bucle de append + ventana de ~5 s (misma lógica que la UI de go2rtc).
        const buf = new Uint8Array(2 * 1024 * 1024);
        let bufLen = 0;
        sb.addEventListener('updateend', () => {
          if (!sb.updating && bufLen > 0) {
            try {
              sb.appendBuffer(buf.slice(0, bufLen));
              bufLen = 0;
            } catch {
              // chunk inválido: se descarta
            }
          }
          if (!sb.updating && sb.buffered.length > 0) {
            const end = sb.buffered.end(sb.buffered.length - 1);
            const start = end - 5;
            const start0 = sb.buffered.start(0);
            if (start > start0) {
              sb.remove(start0, start);
              ms.setLiveSeekableRange(start, end);
            }
            if (el.currentTime < start) {
              el.currentTime = start;
            }
            const gap = end - el.currentTime;
            el.playbackRate = gap > 0.1 ? gap : 0.1;
          }
        });

        const p = el.play();
        if (p && p.catch) p.catch(() => {});

        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (sb.updating || bufLen > 0) {
            const b = new Uint8Array(value);
            if (bufLen + b.byteLength > buf.length) {
              // no cabe en el buffer pendiente: se appendea directo si se puede
              if (!sb.updating) {
                try {
                  sb.appendBuffer(b);
                } catch {
                  // chunk inválido: se descarta
                }
              }
            } else {
              buf.set(b, bufLen);
              bufLen += b.byteLength;
            }
          } else {
            try {
              sb.appendBuffer(value);
            } catch {
              // chunk inválido: se descarta
            }
          }
        }
      })
      .catch((err: unknown) => {
        const e = err as Error;
        if (e && e.name === 'AbortError') return; // limpieza programada
        console.warn('[Player] fallback MSE falló:', e);
        this.liveStatus.emit('error');
      })
      .finally(() => cleanup());
  }

  private resetLive() {
    this.clearLiveTimer();
    if (this.liveRtc) {
      this.liveRtc.close();
      this.liveRtc = null;
    }
    if (this.liveMseAbort) {
      this.liveMseAbort.abort();
      this.liveMseAbort = null;
    }
    if (this.liveMse) {
      const ms = this.liveMse;
      this.liveMse = null;
      try {
        ms.endOfStream();
      } catch {
        // ya cerrado
      }
    }
    const wasActive = this.liveActive;
    this.liveActive = false;
    this.livePlaying = false;
    this.liveFallbackTried = false;
    if (!wasActive) return;
    const el = this.videoEl?.nativeElement;
    if (el) {
      el.srcObject = null;
      el.removeAttribute('src');
      el.load();
    }
    if (this.liveMseObjectUrl) {
      URL.revokeObjectURL(this.liveMseObjectUrl);
      this.liveMseObjectUrl = '';
    }
    this.liveStatus.emit('idle');
  }
}
