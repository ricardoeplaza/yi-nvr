import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { DashboardPage } from './dashboard.page';
import { CameraService } from '../../services/camera.service';
import { VideoService } from '../../services/video.service';
import { StreamService } from '../../services/stream.service';
import { Camera } from '../../models/camera.model';
import { Video } from '../../models/video.model';

function makeCamera(): Camera {
  return {
    id: 'cam1',
    name: 'Cámara 1',
    host: '192.168.1.50',
    ecosystem: 'yi-hack',
    ftp_dir: 'cam1',
    capabilities: { led: true, ircut: true, rec_mode: true, power: true },
    has_videos: true,
    video_count: 4,
    last_video: '2026-08-20T10:00:00Z',
    mqtt: null,
  };
}

function makeVideo(id: number, ts: string): Video {
  return {
    id,
    name: null,
    camera_name: 'cam1',
    timestamp: ts,
    original_path: '',
    thumbnail_path: '',
    preview_path: '',
    duration: 60,
    file_size: 1024,
    favorite: false,
    original_url: `https://example.com/clips/clip${id}.mp4`,
    thumbnail_url: '',
    preview_url: '',
  };
}

describe('DashboardPage', () => {
  // Clips con horas distintas: A(10:00) > B(09:00) > C(08:00) > D(07:00).
  const A = makeVideo(1, '2026-08-20T10:00:00Z');
  const B = makeVideo(2, '2026-08-20T09:00:00Z');
  const C = makeVideo(3, '2026-08-20T08:00:00Z');
  const D = makeVideo(4, '2026-08-20T07:00:00Z');

  let setFavoriteSpy: ReturnType<typeof vi.fn>;

  async function createPage() {
    setFavoriteSpy = vi.fn(() => of({ success: true, favorite: true }));
    await TestBed.configureTestingModule({
      imports: [DashboardPage],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } } } },
        { provide: CameraService, useValue: { getCameras: () => of({ success: true, count: 1, data: [makeCamera()] }) } },
        // Intencionalmente desordenado: el dashboard debe ordenar DESC.
        { provide: VideoService, useValue: { getVideos: () => of({ success: true, count: 4, data: [D, B, A, C] }), setFavorite: setFavoriteSpy } },
        { provide: StreamService, useValue: {} },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(DashboardPage);
    fixture.detectChanges();
    fixture.detectChanges();
    // jsdom no implementa la reproducción: se sustituyen los métodos del <video>.
    const videoEl = fixture.nativeElement.querySelector('video') as HTMLVideoElement | null;
    if (videoEl) {
      videoEl.play = vi.fn(() => Promise.resolve());
      videoEl.pause = vi.fn();
      videoEl.load = vi.fn();
    }
    return fixture;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const fixture = await createPage();
    expect(fixture.componentInstance).toBeTruthy();
    fixture.destroy();
  });

  it('ordena los clips DESC (más reciente primero)', async () => {
    const fixture = await createPage();
    const c = fixture.componentInstance;
    expect(c.videos().map((v) => v.id)).toEqual([1, 2, 3, 4]);
    fixture.destroy();
  });

  it('no selecciona ningún clip al cargar (sin autoplay inicial)', async () => {
    const fixture = await createPage();
    expect(fixture.componentInstance.selectedVideo()).toBeNull();
    fixture.destroy();
  });

  describe('autoplay: siguiente clip más nuevo', () => {
    it('al terminar un clip avanza al siguiente más nuevo (índice anterior)', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo(C); // índice 2
      c.onVideoEnded(C);
      expect(c.selectedVideo()?.id).toBe(2); // B
      fixture.destroy();
    });

    it('sigue avanzando hasta el clip más reciente', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo(C);
      c.onVideoEnded(C); // → B
      c.onVideoEnded(B); // → A
      expect(c.selectedVideo()?.id).toBe(1); // A (más reciente)
      fixture.destroy();
    });

    it('se detiene en el clip más reciente (no avanza más)', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo(A); // índice 0
      c.onVideoEnded(A);
      expect(c.selectedVideo()?.id).toBe(1); // sigue A
      fixture.destroy();
    });

    it('no hace nada si el clip no está en la lista', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo(A);
      const unknown = makeVideo(99, '2026-08-20T06:00:00Z');
      c.onVideoEnded(unknown);
      expect(c.selectedVideo()?.id).toBe(1); // sigue A
      fixture.destroy();
    });
  });

  describe('favoritos', () => {
    it('marca el clip como favorito, actualiza el estado y persiste', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo(A);
      c.onFavoriteToggle(c.selectedVideo()!);
      expect(c.selectedVideo()?.favorite).toBe(true);
      expect(c.videos().find((v) => v.id === 1)?.favorite).toBe(true);
      expect(setFavoriteSpy).toHaveBeenCalledWith(1, true);
      fixture.destroy();
    });

    it('desmarca si el clip ya estaba marcado', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectVideo({ ...A, favorite: true });
      c.onFavoriteToggle(c.selectedVideo()!);
      expect(c.selectedVideo()?.favorite).toBe(false);
      expect(c.videos().find((v) => v.id === 1)?.favorite).toBe(false);
      expect(setFavoriteSpy).toHaveBeenCalledWith(1, false);
      fixture.destroy();
    });

    it('muestra la estrella en el listado al marcar favorito y la quita al desmarcar', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      expect(fixture.nativeElement.querySelector('.ev-fav')).toBeNull();
      c.selectVideo(A);
      c.onFavoriteToggle(c.selectedVideo()!);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.ev-fav')).toBeTruthy();
      c.onFavoriteToggle(c.selectedVideo()!);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.ev-fav')).toBeNull();
      fixture.destroy();
    });

    it('revierte el estado optimista si la API falla', async () => {
      const fixture = await createPage();
      setFavoriteSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      c.selectVideo(A);
      c.onFavoriteToggle(c.selectedVideo()!);
      expect(c.selectedVideo()?.favorite).toBe(false);
      expect(c.videos().find((v) => v.id === 1)?.favorite).toBe(false);
      fixture.destroy();
    });
  });
});
