import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Player } from './player';
import type { Video } from '../../models/video.model';

function makeVideo(): Video {
  return {
    id: 1,
    camera_name: 'cam1',
    timestamp: new Date(2026, 7, 20, 10, 30).toISOString(),
    original_path: '',
    thumbnail_path: '',
    preview_path: '',
    duration: 60,
    file_size: 1024,
    favorite: false,
    original_url: 'https://example.com/clips/clip1.mp4',
    thumbnail_url: '',
    preview_url: '',
  };
}

describe('Player', () => {
  let component: Player;
  let fixture: ComponentFixture<Player>;
  let host: HTMLElement;
  let videoEl: HTMLVideoElement;
  let origCreateObjectURL: typeof URL.createObjectURL;
  let origRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Player],
    }).compileComponents();

    fixture = TestBed.createComponent(Player);
    component = fixture.componentInstance;
    host = fixture.nativeElement;

    // jsdom no implementa object URLs
    origCreateObjectURL = URL.createObjectURL;
    origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    // Primera detección de cambios: resuelve @ViewChild (el <video> real del
    // DOM) y ejecuta los effects con inputs vacíos (no hacen nada).
    fixture.detectChanges();
    videoEl = host.querySelector('video') as HTMLVideoElement;
    // jsdom no implementa la reproducción: se sustituyen los métodos.
    videoEl.play = vi.fn(() => Promise.resolve());
    videoEl.pause = vi.fn();
    videoEl.load = vi.fn();
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('estados visuales', () => {
    it('muestra el icono idle y sin botones, sin video ni live', () => {
      expect(component.isIdle()).toBe(true);
      expect(host.querySelector('.idle-icon')).toBeTruthy();
      expect(host.querySelector('.icon-btn')).toBeNull();
    });

    it('oculta el icono idle y muestra controles con un clip', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      expect(host.querySelector('.idle-icon')).toBeNull();
      expect(host.querySelector('.seek-bar')).toBeTruthy();
      expect(host.querySelectorAll('.icon-btn').length).toBeGreaterThan(0);
    });

    it('muestra el icono grande de play al pausar', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      expect(videoEl.paused).toBe(true);
      expect(host.querySelector('.center-tap svg')).toBeTruthy();
    });

    it('arranca con los controles ocultos y los muestra al cargar pausado', () => {
      expect(component.controlsVisible()).toBe(false);
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      // En jsdom el video queda pausado → los controles se muestran.
      expect(component.controlsVisible()).toBe(true);
      expect(host.querySelector('.controls')?.classList.contains('hide')).toBe(false);
    });

    it('oculta los controles al iniciar la reproducción (sin interacción del usuario)', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      expect(component.controlsVisible()).toBe(true);
      // El video empieza a reproducir: los controles deben ocultarse solos.
      component.onVideoPlay();
      expect(component.paused()).toBe(false);
      expect(component.controlsVisible()).toBe(false);
    });

    it('mantiene los controles si el usuario interactúa al reproducir', () => {
      vi.useFakeTimers();
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      component.pokeControls();
      component.onVideoPlay();
      expect(component.controlsVisible()).toBe(true);
    });

    it('muestra el scrim-top siempre, incluso con los controles ocultos', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      component.onVideoPlay();
      fixture.detectChanges();
      const scrim = host.querySelector('.scrim-top') as HTMLElement;
      expect(scrim).toBeTruthy();
      expect(scrim.classList.contains('hide')).toBe(false);
    });

    it('oculta los controles solos tras la inactividad mientras reproduce', () => {
      vi.useFakeTimers();
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      Object.defineProperty(videoEl, 'paused', { configurable: true, value: false });
      component.pokeControls();
      expect(component.controlsVisible()).toBe(true);
      vi.advanceTimersByTime(2800);
      expect(component.controlsVisible()).toBe(false);
    });
  });

  describe('modo bajo demanda', () => {
    it('carga el clip CON mute por defecto y reproduce', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      expect(videoEl.muted).toBe(true);
      expect(component.muted()).toBe(true);
      expect(videoEl.src).toContain('clip1.mp4');
      expect(videoEl.play).toHaveBeenCalled();
    });

    it('si el usuario desilencia, el siguiente clip conserva el sonido', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      expect(videoEl.muted).toBe(true);
      // El usuario activa el sonido con el botón de mute.
      component.toggleMute();
      expect(videoEl.muted).toBe(false);
      expect(component.muted()).toBe(false);
      // Cambia a otro clip: el estado de mute se conserva automáticamente.
      const other = { ...makeVideo(), id: 2, original_url: 'https://example.com/clips/clip2.mp4' };
      fixture.componentRef.setInput('video', other);
      fixture.detectChanges();
      expect(videoEl.src).toContain('clip2.mp4');
      expect(videoEl.muted).toBe(false);
      expect(component.muted()).toBe(false);
    });

    it('togglePlay pausa y reanuda', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      component.togglePlay();
      expect(videoEl.play).toHaveBeenCalled();
      Object.defineProperty(videoEl, 'paused', { configurable: true, value: false });
      component.togglePlay();
      expect(videoEl.pause).toHaveBeenCalled();
    });

    it('seek: pointerdown sobre la barra mueve currentTime', () => {
      fixture.componentRef.setInput('video', makeVideo());
      fixture.detectChanges();
      Object.defineProperty(videoEl, 'duration', { configurable: true, value: 60 });
      Object.defineProperty(videoEl, 'currentTime', { configurable: true, writable: true, value: 0 });
      const bar = host.querySelector('.seek-bar') as HTMLElement;
      bar.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 100, bottom: 16, width: 100, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      bar.setPointerCapture = vi.fn();
      bar.releasePointerCapture = vi.fn();
      const e = { clientX: 50, pointerId: 1, currentTarget: bar } as unknown as PointerEvent;
      component.onSeekDown(e);
      expect(videoEl.currentTime).toBeCloseTo(30);
      component.onSeekUp(e);
    });

    it('descarga el clip vía fetch → blob → <a download>', async () => {
      const vid = makeVideo();
      fixture.componentRef.setInput('video', vid);
      fixture.detectChanges();
      const blob = new Blob(['fake'], { type: 'video/mp4' });
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
      vi.stubGlobal('fetch', fetchSpy);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
      vi.useFakeTimers();
      component.downloadClip();
      await vi.waitFor(() => expect(clickSpy).toHaveBeenCalled());
      expect(fetchSpy).toHaveBeenCalledWith(vid.original_url);
      // El revoke del object URL se hace con retardo (4 s) para no romper la descarga
      vi.advanceTimersByTime(4000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    });

    it('emite el output favorite con el Video', () => {
      const vid = makeVideo();
      fixture.componentRef.setInput('video', vid);
      fixture.detectChanges();
      let fav: Video | null = null;
      component.favorite.subscribe((v) => (fav = v));
      component.toggleFavorite();
      expect(fav).toBe(vid);
    });

    describe('favorito: estado controlado por el padre', () => {
      function favButton(): HTMLElement {
        return host.querySelector('button[aria-label="Marcar como favorito"], button[aria-label="Quitar de favoritos"]') as HTMLElement;
      }

      it('sin isFavorite (por defecto) el botón queda sin marcar (estrella vacía)', () => {
        fixture.componentRef.setInput('video', makeVideo());
        fixture.detectChanges();
        const btn = favButton();
        expect(btn).toBeTruthy();
        expect(btn.classList.contains('fav-active')).toBe(false);
        expect(btn.querySelector('svg')!.getAttribute('fill')).toBe('none');
      });

      it('con isFavorite=true el botón queda marcado (estrella rellena)', () => {
        fixture.componentRef.setInput('video', makeVideo());
        fixture.componentRef.setInput('isFavorite', true);
        fixture.detectChanges();
        const btn = favButton();
        expect(btn).toBeTruthy();
        expect(btn.classList.contains('fav-active')).toBe(true);
        expect(btn.querySelector('svg')!.getAttribute('fill')).toBe('currentColor');
      });

      it('al pulsar emite favorite y NO cambia el marcado si el padre no actualiza el input', () => {
        const vid = makeVideo();
        fixture.componentRef.setInput('video', vid);
        fixture.detectChanges();
        let fav: Video | null = null;
        component.favorite.subscribe((v) => (fav = v));
        component.toggleFavorite();
        fixture.detectChanges();
        expect(fav).toBe(vid);
        // Componente 100% controlado: sin isFavorite=true del padre, sin marcado.
        expect(host.querySelector('button.fav-active')).toBeNull();
      });
    });

    describe('autoplay del siguiente clip', () => {
      function autoButton(): HTMLElement {
        return host.querySelector('button[aria-label="Desactivar reproducción automática"], button[aria-label="Activar reproducción automática"]') as HTMLElement;
      }

      it('muestra el botón de autoplay en modo on-demand, activo por defecto', () => {
        fixture.componentRef.setInput('video', makeVideo());
        fixture.detectChanges();
        const btn = autoButton();
        expect(btn).toBeTruthy();
        expect(component.autoplay()).toBe(true);
        expect(btn.classList.contains('autoplay-active')).toBe(true);
      });

      it('al terminar un clip con autoplay activo emite nextVideo con el Video', () => {
        const vid = makeVideo();
        fixture.componentRef.setInput('video', vid);
        fixture.detectChanges();
        let next: Video | null = null;
        component.nextVideo.subscribe((v) => (next = v));
        component.onVideoEnded();
        expect(next).toBe(vid);
      });

      it('toggleAutoplay desactiva el autoplay y el botón pierde el marcado', () => {
        fixture.componentRef.setInput('video', makeVideo());
        fixture.detectChanges();
        component.toggleAutoplay();
        fixture.detectChanges();
        expect(component.autoplay()).toBe(false);
        expect(host.querySelector('button.autoplay-active')).toBeNull();
      });

      it('con autoplay desactivado NO emite nextVideo al terminar el clip', () => {
        fixture.componentRef.setInput('video', makeVideo());
        fixture.detectChanges();
        component.toggleAutoplay();
        let next: Video | null = null;
        component.nextVideo.subscribe((v) => (next = v));
        component.onVideoEnded();
        expect(next).toBeNull();
      });
    });
  });

  describe('modo live', () => {
    it('arranca silenciado y emite loading/error (sin WHEP ni MSE en jsdom)', async () => {
      const statuses: string[] = [];
      component.liveStatus.subscribe((s) => statuses.push(s));
      fixture.componentRef.setInput('liveUrl', 'https://example.com/whep');
      fixture.detectChanges();
      // RTCPeerConnection no existe en jsdom → WHEP falla → sin mseUrl → error
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
      expect(videoEl.muted).toBe(true);
      expect(statuses).toContain('loading');
      expect(statuses).toContain('error');
    });

    it('takeSnapshot dibuja en canvas y descarga PNG local', async () => {
      Object.defineProperty(videoEl, 'videoWidth', { configurable: true, value: 320 });
      Object.defineProperty(videoEl, 'videoHeight', { configurable: true, value: 240 });
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any);
      const toBlob = vi.fn((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })));
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlob as any);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click');
      vi.useFakeTimers();
      component.takeSnapshot();
      await vi.waitFor(() => expect(clickSpy).toHaveBeenCalled());
      expect(drawImage).toHaveBeenCalled();
      vi.advanceTimersByTime(4000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    });
  });

  describe('pantalla completa', () => {
    it('entra en fullscreen sobre el contenedor del player', () => {
      const playerEl = host.querySelector('.player') as HTMLElement;
      const reqSpy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(playerEl, 'requestFullscreen', { configurable: true, value: reqSpy });
      component.toggleFullscreen();
      expect(reqSpy).toHaveBeenCalled();
    });
  });
});
