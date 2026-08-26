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
  let deleteVideoSpy: ReturnType<typeof vi.fn>;
  let countVideosSpy: ReturnType<typeof vi.fn>;
  let purgeVideosSpy: ReturnType<typeof vi.fn>;

  async function createPage() {
    getVideosSpy = vi.fn(() =>
      of({ success: true, count: 2, data: [makeVideo(1, '2026-08-20T10:00:00Z'), makeVideo(2, '2026-08-20T09:00:00Z')] })
    );
    setFavoriteSpy = vi.fn(() => of({ success: true, favorite: true }));
    renameVideoSpy = vi.fn();
    deleteVideoSpy = vi.fn(() => of({ success: true, message: '' }));
    countVideosSpy = vi.fn(() => of({ success: true, count: 0 }));
    purgeVideosSpy = vi.fn(() => of({ success: true, expected: 0, purged: [], failed: [] }));
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
            deleteVideo: deleteVideoSpy,
            countVideos: countVideosSpy,
            purgeVideos: purgeVideosSpy,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const fixture = await createPage();
    expect(fixture.componentInstance).toBeTruthy();
    fixture.destroy();
  });

  describe('carga inicial', () => {
    it('carga videos y cámaras en ngOnInit y los renderiza', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      expect(c.cameras()).toHaveLength(1);
      expect(c.videos()).toHaveLength(2);
      expect(c.loading()).toBe(false);
      expect(fixture.nativeElement.querySelectorAll('.video-card').length).toBe(2);
      const options = fixture.nativeElement.querySelectorAll('select[aria-label="Cámara"] option');
      expect(options.length).toBe(2); // "Todas las cámaras" + Cámara 1
      fixture.destroy();
    });
  });

  describe('filtros', () => {
    it('cambiar cámara recarga con el param y offset 0', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      // El select usa ftp_dir (valor crudo, igual que camera_name en la BD),
      // no el nombre de presentación.
      c.onCameraChange({ target: { value: 'cam1' } } as unknown as Event);
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.camera).toBe('cam1');
      expect(last.offset).toBe(0);
      fixture.destroy();
    });

    it('las opciones del select usan value=ftp_dir y label=name', async () => {
      const fixture = await createPage();
      const options = fixture.nativeElement.querySelectorAll(
        'select[aria-label="Cámara"] option'
      ) as NodeListOf<HTMLOptionElement>;
      expect(options[0].value).toBe('');
      expect(options[0].textContent).toBe('Todas las cámaras');
      expect(options[1].value).toBe('cam1');
      expect(options[1].textContent).toBe('Cámara 1');
      fixture.destroy();
    });

    it('cambiar fechas recarga con startDate/endDate ISO inclusivos', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.onStartDateChange({ target: { value: '2026-08-01' } } as unknown as Event);
      let last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.startDate).toBe('2026-08-01T00:00:00.000Z');
      c.onEndDateChange({ target: { value: '2026-08-07' } } as unknown as Event);
      last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.endDate).toBe('2026-08-07T23:59:59.999Z');
      fixture.destroy();
    });

    it('la búsqueda debounced (300ms) recarga con q', async () => {
      const fixture = await createPage();
      vi.useFakeTimers();
      const c = fixture.componentInstance;
      const callsBefore = getVideosSpy.mock.calls.length;
      c.onSearchInput({ target: { value: 'perro' } } as unknown as Event);
      expect(getVideosSpy.mock.calls.length).toBe(callsBefore); // aún no (debounce)
      vi.advanceTimersByTime(300);
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.q).toBe('perro');
      expect(last.offset).toBe(0);
      expect(c.search()).toBe('perro');
      fixture.destroy();
    });

    it('solo favoritos recarga con favorite=1', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.onFavoritesChange({ target: { checked: true } } as unknown as Event);
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.favorite).toBe(1);
      expect(last.offset).toBe(0);
      fixture.destroy();
    });

    it('loadMore usa offset incrementado y reload lo resetea a 0', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.loadMore();
      expect(getVideosSpy.mock.calls.at(-1)![0].offset).toBe(24);
      c.reload();
      expect(getVideosSpy.mock.calls.at(-1)![0].offset).toBe(0);
      fixture.destroy();
    });
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

    it('nombre vacío/espacios se envía como null', async () => {
      const fixture = await createPage();
      renameVideoSpy.mockReturnValue(of({ success: true, video: makeVideo(1, '2026-08-20T10:00:00Z', { name: null }) }));
      const c = fixture.componentInstance;
      // El video ya tiene nombre: limpiarlo es un cambio real (→ null).
      const vid = { ...c.videos()[0], name: 'antiguo' };
      c.videos.update((list) => list.map((v) => (v.id === vid.id ? vid : v)));
      c.startRename(vid);
      c.renameValue.set('   ');
      c.commitRename(vid);
      expect(renameVideoSpy).toHaveBeenCalledWith(vid.id, null);
      expect(c.videos()[0].name).toBeNull();
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

    it('Enter en el input confirma y llama a renameVideo', async () => {
      const fixture = await createPage();
      renameVideoSpy.mockReturnValue(of({ success: true, video: makeVideo(1, '2026-08-20T10:00:00Z', { name: 'Desde teclado' }) }));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('.rename-input') as HTMLInputElement;
      input.value = 'Desde teclado';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(renameVideoSpy).toHaveBeenCalledWith(vid.id, 'Desde teclado');
      expect(c.renamingId()).toBeNull();
      fixture.destroy();
    });

    it('Esc cancela sin llamar a la API', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('.rename-input') as HTMLInputElement;
      input.value = 'cancelado';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(renameVideoSpy).not.toHaveBeenCalled();
      expect(c.renamingId()).toBeNull();
      expect(c.videos()[0].name).toBeNull(); // lista intacta
      fixture.destroy();
    });
  });

  describe('eliminación', () => {
    it('con confirm=true llama a deleteVideo y quita el video de la lista', async () => {
      const fixture = await createPage();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.deleteVideo(vid);
      expect(deleteVideoSpy).toHaveBeenCalledWith(vid.id);
      expect(c.videos().find((v) => v.id === vid.id)).toBeUndefined();
      expect(c.videos()).toHaveLength(1);
      fixture.destroy();
    });

    it('con confirm=false no llama a la API', async () => {
      const fixture = await createPage();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const c = fixture.componentInstance;
      c.deleteVideo(c.videos()[0]);
      expect(deleteVideoSpy).not.toHaveBeenCalled();
      expect(c.videos()).toHaveLength(2);
      fixture.destroy();
    });
  });

  describe('purge', () => {
    it('calcula el conteo esperado con countVideos x2 (total - favoritos)', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation(
        (params: { favorite?: 0 | 1 }) => of({ success: true, count: params.favorite === 1 ? 3 : 10 })
      );
      const c = fixture.componentInstance;
      c.purgeOpen.set(true);
      c.onPurgeScopeChange({ target: { value: 'day' } } as unknown as Event);
      expect(countVideosSpy).toHaveBeenCalledTimes(2);
      const first = countVideosSpy.mock.calls[0][0];
      const second = countVideosSpy.mock.calls[1][0];
      expect(first.endDate).toBeTruthy(); // retención: ahora - 1 día
      expect(second.favorite).toBe(1);
      expect(c.purgeExpected()).toBe(7);
      fixture.destroy();
    });

    it('scope range: conteo con from/to y purge con el rango ISO correcto', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation(() => of({ success: true, count: 4 }));
      purgeVideosSpy.mockReturnValue(of({ success: true, expected: 4, purged: ['a', 'b'], failed: [] }));
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const c = fixture.componentInstance;
      c.purgeOpen.set(true);
      c.onPurgeScopeChange({ target: { value: 'range' } } as unknown as Event);
      c.onPurgeFromChange({ target: { value: '2026-08-01' } } as unknown as Event);
      c.onPurgeToChange({ target: { value: '2026-08-07' } } as unknown as Event);
      expect(c.purgeExpected()).toBe(0); // 4 - 4 = 0
      c.onPurge();
      expect(confirmSpy).toHaveBeenCalled();
      expect(purgeVideosSpy).toHaveBeenCalledWith({
        scope: 'range',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-07T23:59:59.999Z',
      });
      expect(c.purging()).toBe(false);
      expect(c.purgeOutcome()).toEqual({ expected: 4, purged: 2, failed: 0 });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.purge-result')?.textContent).toContain('Purgados 2 de 4 videos');
      fixture.destroy();
    });

    it('scope simple: purge sin from/to y resultado mostrado', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation(() => of({ success: true, count: 2 }));
      purgeVideosSpy.mockReturnValue(of({ success: true, expected: 2, purged: ['a'], failed: ['b'] }));
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const c = fixture.componentInstance;
      c.purgeOpen.set(true);
      c.onPurgeScopeChange({ target: { value: 'week' } } as unknown as Event);
      c.onPurge();
      expect(purgeVideosSpy).toHaveBeenCalledWith({ scope: 'week' });
      expect(c.purgeOutcome()).toEqual({ expected: 2, purged: 1, failed: 1 });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.purge-result')?.textContent).toContain('1 no pudieron purgarse');
      fixture.destroy();
    });

    it('con confirm=false no purga', async () => {
      const fixture = await createPage();
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      const c = fixture.componentInstance;
      c.purgeOpen.set(true);
      c.onPurgeScopeChange({ target: { value: 'day' } } as unknown as Event);
      c.onPurge();
      expect(purgeVideosSpy).not.toHaveBeenCalled();
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

    it('el binding del DOM usa cardSrc (thumbnail por defecto, preview tras mouseenter)', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      const img = () => fixture.nativeElement.querySelector('.video-card .thumb img') as HTMLImageElement;
      expect(img().getAttribute('src')).toBe(vid.thumbnail_url);
      const card = fixture.nativeElement.querySelector('.video-card') as HTMLElement;
      card.dispatchEvent(new MouseEvent('mouseenter'));
      fixture.detectChanges();
      expect(img().getAttribute('src')).toBe(vid.preview_url);
      fixture.destroy();
    });
  });
});
