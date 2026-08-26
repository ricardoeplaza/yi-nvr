import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { GalleryPage } from './gallery.page';
import { CameraService } from '../../services/camera.service';
import { VideoService } from '../../services/video.service';
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
    video_count: 2,
    last_video: '2026-08-20T10:00:00Z',
    mqtt: null,
  };
}

function makeVideo(id: number, ts: string, extra: Partial<Video> = {}): Video {
  return {
    id,
    name: null,
    camera_name: 'cam1',
    timestamp: ts,
    original_path: '',
    thumbnail_path: '',
    preview_path: '',
    duration: 60,
    file_size: 1024 * 1024,
    favorite: false,
    original_url: `https://example.com/clips/clip${id}.mp4`,
    thumbnail_url: `https://example.com/thumb${id}.jpg`,
    preview_url: `https://example.com/preview${id}.webp`,
    ...extra,
  };
}

describe('GalleryPage', () => {
  let getVideosSpy: ReturnType<typeof vi.fn>;
  let setFavoriteSpy: ReturnType<typeof vi.fn>;
  let renameVideoSpy: ReturnType<typeof vi.fn>;

  async function createPage() {
    getVideosSpy = vi.fn(() =>
      of({ success: true, count: 2, data: [makeVideo(1, '2026-08-20T10:00:00Z'), makeVideo(2, '2026-08-20T09:00:00Z')] })
    );
    setFavoriteSpy = vi.fn(() => of({ success: true, favorite: true }));
    renameVideoSpy = vi.fn();
    await TestBed.configureTestingModule({
      imports: [GalleryPage],
      providers: [
        { provide: CameraService, useValue: { getCameras: () => of({ success: true, data: [makeCamera()] }) } },
        {
          provide: VideoService,
          useValue: {
            getVideos: getVideosSpy,
            setFavorite: setFavoriteSpy,
            renameVideo: renameVideoSpy,
            deleteVideo: () => of({ success: true, message: '' }),
            countVideos: () => of({ success: true, count: 0 }),
            purgeVideos: () => of({ success: true, expected: 0, purged: [], failed: [] }),
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(GalleryPage);
    fixture.detectChanges();
    fixture.detectChanges();
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

  describe('favoritos', () => {
    it('marca favorito con actualización optimista y persiste', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.toggleFavorite(vid);
      expect(c.videos()[0].favorite).toBe(true);
      expect(setFavoriteSpy).toHaveBeenCalledWith(vid.id, true);
      fixture.destroy();
    });

    it('revierte el estado optimista si la API falla', async () => {
      const fixture = await createPage();
      setFavoriteSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.toggleFavorite(vid);
      expect(c.videos()[0].favorite).toBe(false);
      fixture.destroy();
    });
  });

  describe('rename', () => {
    it('confirma el rename y actualiza la lista', async () => {
      const fixture = await createPage();
      const updated = makeVideo(1, '2026-08-20T10:00:00Z', { name: 'Nuevo nombre' });
      renameVideoSpy.mockReturnValue(of({ success: true, video: updated }));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      c.renameValue.set('Nuevo nombre');
      c.commitRename(vid);
      expect(renameVideoSpy).toHaveBeenCalledWith(vid.id, 'Nuevo nombre');
      expect(c.videos()[0].name).toBe('Nuevo nombre');
      expect(c.renamingId()).toBeNull();
      fixture.destroy();
    });

    it('no llama a la API si el nombre no cambió', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      c.commitRename(vid); // sin cambios
      expect(renameVideoSpy).not.toHaveBeenCalled();
      expect(c.renamingId()).toBeNull();
      fixture.destroy();
    });

    it('rollback del input si la API falla', async () => {
      const fixture = await createPage();
      renameVideoSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      c.renameValue.set('otro nombre');
      c.commitRename(vid);
      expect(c.renameValue()).toBe(''); // rollback a name ?? ''
      expect(c.renameError()).toBeTruthy();
      expect(c.videos()[0].name).toBeNull(); // lista intacta
      fixture.destroy();
    });
  });

  describe('paginación', () => {
    it('hasMore solo si la página devuelta está completa', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      expect(c.hasMore()).toBe(false); // 2 < LIMIT
      fixture.destroy();
    });
  });

  describe('preview', () => {
    it('muestra thumbnail por defecto y preview tras el hover', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      expect(c.cardSrc(vid)).toBe(vid.thumbnail_url);
      c.onCardEnter(vid);
      fixture.detectChanges();
      expect(c.cardSrc(vid)).toBe(vid.preview_url);
      fixture.destroy();
    });

    it('si no hay preview_url se queda en thumbnail', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = { ...c.videos()[0], preview_url: '' };
      c.onCardEnter(vid);
      expect(c.cardSrc(vid)).toBe(vid.thumbnail_url);
      fixture.destroy();
    });
  });
});
