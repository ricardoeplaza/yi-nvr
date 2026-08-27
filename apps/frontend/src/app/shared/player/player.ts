import { afterNextRender, Component, effect, ElementRef, inject, input, output, OnDestroy, signal, ViewChild } from '@angular/core';
import type { Video } from '../../models/video.model';
import { StreamService } from '../../services/stream.service';

export type PlayerLiveStatus = 'idle' | 'loading' | 'playing' | 'error';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// m:ss o h:mm:ss según la duración
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? pad2(h) + ':' + pad2(m) + ':' + pad2(r) : pad2(m) + ':' + pad2(r);
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
  // Estado de favorito (solo reflejo visual): el padre indica si el clip ES
  // favorito y el botón se muestra marcado. Opcional (false por defecto).
  readonly isFavorite = input(false);
  // When true, the video-wrap adopts the clip's intrinsic aspect ratio,
  // defaulting to 16/9 until metadata loads (used by the gallery overlay only).
  readonly adaptiveRatio = input(false);

  /* ---------- outputs ---------- */
  // Estado del stream en vivo (se conserva; lo consume camera-detail).
  readonly liveStatus = output<PlayerLiveStatus>();
  // Nuevo (aditivo): el padre decide qué hacer con el clip (p. ej. marcar favorito).
  readonly favorite = output<Video>();
  // Clip siguiente (solo on-demand): se emite al padre cuando el clip llega al
  // final Y el autoplay está activo. El padre decide qué clip reproducir a
  // continuación (p. ej. el siguiente en el timeline).
  readonly nextVideo = output<Video>();

  /* ---------- referencias de template ---------- */
  @ViewChild('videoEl') videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('playerEl') playerEl?: ElementRef<HTMLDivElement>;

  /* ---------- estado de vista (signals) ---------- */
  readonly paused = signal(false);
  readonly buffering = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  // Mute por defecto (onInit): el primer clip arranca silenciado. Si el usuario
  // lo desilencia, el estado se conserva en el <video> para el siguiente clip
  // (el componente no se destruye entre videos).
  readonly muted = signal(true);
  readonly isFullscreen = signal(false);
  // Aspect ratio del clip actual (adaptivo): '16 / 9' como fallback hasta que
  // loadedmetadata aporte el ratio intrínseco.
  readonly videoRatio = signal('16 / 9');
  // Ocultos por defecto: solo aparecen con interacción o en pausa/carga.
  readonly controlsVisible = signal(false);
  // Autoplay del siguiente clip (on-demand): si está activo, al terminar un clip
  // se emite nextVideo para que el padre seleccione el siguiente. Si está
  // desactivado, NO se emite (el clip queda pausado al final).
  readonly autoplay = signal(true);
  private seeking = false;

  /* ---------- estado live ---------- */
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
  private lastOnDemandUrl: string | null = null;
  private hideTimer: number | null = null;
  private onFullscreenChange = () => this.isFullscreen.set(!!document.fullscreenElement);

  constructor() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);

    // Mute por defecto (onInit): el <video> arranca silenciado. Si el usuario
    // lo desilencia, el estado se conserva en el elemento para el siguiente
    // video (el componente no se destruye entre clips).
    afterNextRender(() => {
      const el = this.videoEl?.nativeElement;
      if (el) el.muted = true;
    });

    // Al cambiar el video seleccionado: detiene el live (si había) y reproduce.
    // La fuente la asigna la plantilla de forma declarativa ([attr.src]), así
    // que este effect no depende de llegar primero a poner el src: solo
    // reacciona al cambio (reset del tiempo, controles si queda pausado y
    // play() como red de seguridad).
    // No se toca el estado de mute: arranca muted por defecto (onInit) y si el
    // usuario lo desilencia, el <video> conserva el estado para el siguiente
    // clip (el elemento no se destruye entre videos).
    effect(() => {
      const vid = this.video();
      if (!vid || this.destroyed) return;
      this.resetLive();
      const el = this.videoEl?.nativeElement;
      if (!el) return;
      // Red de seguridad para la transición live → on-demand: resetLive()
      // limpia el atributo src que la plantilla acaba de asignar.
      if (el.getAttribute('src') !== vid.original_url) {
        el.src = vid.original_url;
      }
      if (this.lastOnDemandUrl !== vid.original_url) {
        this.lastOnDemandUrl = vid.original_url;
        this.currentTime.set(0);
        this.duration.set(0);
        // Clip nuevo: el ratio vuelve al fallback hasta sus metadatos.
        this.videoRatio.set('16 / 9');
      }
      this.paused.set(el.paused);
      // Al cargar: si el video queda pausado, se muestran los controles para
      // que el usuario pueda controlarlo.
      if (el.paused) {
        this.controlsVisible.set(true);
        this.clearHideTimer();
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
      // El live arranca silenciado (política de autoplay); el usuario lo
      // desilencia con el botón de volumen.
      el.muted = true;
      this.muted.set(true);
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

  /* ---------- modos ---------- */

  isIdle(): boolean {
    return !this.video() && !this.liveUrl();
  }

  isLiveMode(): boolean {
    return !!this.liveUrl();
  }

  isOnDemandMode(): boolean {
    return !!this.video();
  }

  clipLabel(): string {
    const v = this.video();
    if (!v) return '';
    const d = new Date(v.timestamp);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  fmtTime(sec: number): string {
    return fmtTime(sec);
  }

  seekPercent(): number {
    const d = this.duration();
    return d > 0 ? Math.min(100, (this.currentTime() / d) * 100) : 0;
  }

  volumePct(): number {
    return Math.round(this.volume() * 100);
  }

  /* ---------- controles: reproducción ---------- */

  togglePlay() {
    const video = this.videoEl?.nativeElement;
    if (!video) return;
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
    this.pokeControls();
  }

  /* ---------- controles: volumen ---------- */

  toggleMute() {
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    el.muted = !el.muted;
    this.muted.set(el.muted);
    this.pokeControls();
  }

  onVolumeInput(e: Event) {
    const el = this.videoEl?.nativeElement;
    const input = e.target as HTMLInputElement;
    if (!el) return;
    const v = Math.min(100, Math.max(0, input.valueAsNumber)) / 100;
    el.volume = v;
    // Subir el slider desilencia (comportamiento estándar de reproductor)
    if (v > 0 && el.muted) {
      el.muted = false;
      this.muted.set(false);
    }
    this.pokeControls();
  }

  /* ---------- controles: seek (solo bajo demanda) ---------- */

  onSeekDown(e: PointerEvent) {
    const el = this.videoEl?.nativeElement;
    if (!el || !this.isOnDemandMode()) return;
    this.seeking = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.seekTo(e);
  }

  onSeekMove(e: PointerEvent) {
    if (!this.seeking) return;
    this.seekTo(e);
  }

  onSeekUp(e: PointerEvent) {
    if (!this.seeking) return;
    this.seeking = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  private seekTo(e: PointerEvent) {
    const el = this.videoEl?.nativeElement;
    const bar = e.currentTarget as HTMLElement;
    if (!el || !bar) return;
    const d = el.duration || this.duration();
    if (!d || !isFinite(d)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = ratio * d;
    el.currentTime = t;
    this.currentTime.set(t);
  }

  /* ---------- controles: descarga / favorito (solo bajo demanda) ---------- */

  // Descarga local del clip: fetch → blob → <a download> (así el atributo
  // download respeta el nombre aunque el origen sea cross-origin). Si el fetch
  // falla (CORS, red), se degrada a <a href="original_url" download="...">.
  downloadClip() {
    const vid = this.video();
    if (!vid) return;
    const name = this.downloadName(vid);
    fetch(vid.original_url)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        this.triggerDownload(url, name, true);
      })
      .catch(() => {
        this.triggerDownload(vid.original_url, name, false);
      });
  }

  private downloadName(vid: Video): string {
    const d = new Date(vid.timestamp);
    const date =
      d.getFullYear() +
      '-' +
      pad2(d.getMonth() + 1) +
      '-' +
      pad2(d.getDate()) +
      '-' +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds());
    const cam = (vid.camera_name || 'clip').replace(/[^\w-]+/g, '_');
    return `grabacion-${cam}-${date}.mp4`;
  }

  private triggerDownload(href: string, name: string, revoke: boolean) {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) {
      window.setTimeout(() => URL.revokeObjectURL(href), 4000);
    }
  }

  // El favorito NO se gestiona aquí: se emite al padre, que decide la lógica y
  // actualiza el input isFavorite (componente 100% controlado, sin estado interno).
  toggleFavorite() {
    const vid = this.video();
    if (!vid) return;
    this.favorite.emit(vid);
  }

  // Alterna el autoplay del siguiente clip (on-demand). Activo → al terminar un
  // clip se emite nextVideo; desactivado → no se emite (clip pausado al final).
  toggleAutoplay() {
    this.autoplay.set(!this.autoplay());
    this.pokeControls();
  }

  /* ---------- controles: captura (solo live) ---------- */

  // Captura 100% local: dibuja el frame actual en un <canvas>, toBlob() y
  // descarga el PNG por object URL. No pasa por ningún servidor.
  takeSnapshot() {
    const el = this.videoEl?.nativeElement;
    if (!el || !el.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const t = new Date();
      const name = `captura-${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${pad2(
        t.getHours()
      )}${pad2(t.getMinutes())}${pad2(t.getSeconds())}.png`;
      this.triggerDownload(url, name, true);
    }, 'image/png');
  }

  /* ---------- controles: pantalla completa ---------- */

  toggleFullscreen() {
    const el = this.playerEl?.nativeElement;
    if (!el) return;
    if (document.fullscreenElement) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (el.requestFullscreen) {
      const p = el.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    }
  }

  /* ---------- eventos del <video> ---------- */

  onVideoPlay() {
    this.paused.set(false);
    // Al empezar la reproducción los controles se ocultan (el effect de carga
    // los mostraba mientras el video seguía pausado, antes de que play()
    // resolviera). Excepción: si el usuario está interactuando (pokeControls
    // activo, p. ej. pulsó play a mano), se mantienen hasta el auto-hide.
    if (this.hideTimer === null) {
      this.controlsVisible.set(false);
    }
  }

  onVideoPause() {
    this.paused.set(true);
    // En pausa los controles quedan siempre a la vista
    this.controlsVisible.set(true);
    this.clearHideTimer();
  }

  // Fin natural del clip (on-demand): si el autoplay está activo se emite
  // nextVideo para que el padre avance al clip siguiente. Si está desactivado,
  // no se emite nada (el clip queda pausado al final).
  onVideoEnded() {
    if (!this.isOnDemandMode()) return;
    if (!this.autoplay()) return;
    const vid = this.video();
    if (vid) this.nextVideo.emit(vid);
  }

  onTimeUpdate() {
    if (this.seeking) return;
    const el = this.videoEl?.nativeElement;
    if (el) this.currentTime.set(el.currentTime || 0);
  }

  onLoadedMetadata() {
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    this.duration.set(el.duration || 0);
    if (
      this.adaptiveRatio() &&
      el.videoWidth > 0 &&
      el.videoHeight > 0 &&
      isFinite(el.videoWidth) &&
      isFinite(el.videoHeight)
    ) {
      this.videoRatio.set(el.videoWidth + ' / ' + el.videoHeight);
    }
  }

  // null → sin style inline → rige el aspect-ratio por defecto del CSS.
  wrapAspectRatio(): string | null {
    return this.adaptiveRatio() ? this.videoRatio() : null;
  }

  onWaiting() {
    this.buffering.set(true);
  }

  onCanPlay() {
    this.buffering.set(false);
  }

  onVolumeChange() {
    const el = this.videoEl?.nativeElement;
    if (!el) return;
    this.volume.set(el.volume);
    this.muted.set(el.muted);
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

  /* ---------- visibilidad de controles ---------- */

  // Mantiene la barra visible mientras hay interacción; se ocula sola tras
  // ~2,8 s sin movimiento (solo si el video está reproduciéndose).
  pokeControls() {
    this.controlsVisible.set(true);
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      const el = this.videoEl?.nativeElement;
      if (el && !el.paused && !this.seeking) {
        this.controlsVisible.set(false);
      }
    }, 2800);
  }

  private clearHideTimer() {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /* ---------- ciclo de vida ---------- */

  ngOnDestroy() {
    this.destroyed = true;
    this.clearHideTimer();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
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
