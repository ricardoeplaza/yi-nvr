import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject, of, throwError } from 'rxjs';

import { GalleryPage } from './gallery.page';
import { Player } from '../../shared/player/player';
import { CameraService } from '../../services/camera.service';
import { VideoService } from '../../services/video.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../shared/toast/toast.service';
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
    status: null,
    latest_video: null,
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

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('GalleryPage', () => {
  let getVideosSpy: ReturnType<typeof vi.fn>;
  let setFavoriteSpy: ReturnType<typeof vi.fn>;
  let renameVideoSpy: ReturnType<typeof vi.fn>;
  let deleteVideoSpy: ReturnType<typeof vi.fn>;
  let countVideosSpy: ReturnType<typeof vi.fn>;
  let purgeVideosSpy: ReturnType<typeof vi.fn>;
  let bulkDeleteSpy: ReturnType<typeof vi.fn>;
  let bulkFavoriteSpy: ReturnType<typeof vi.fn>;
  let confirmShowSpy: ReturnType<typeof vi.fn>;
  let toastShowSpy: ReturnType<typeof vi.fn>;

  async function createPage(overrides?: { videos?: Video[] }) {
    const videos = overrides?.videos ?? [
      makeVideo(1, '2026-08-20T10:00:00Z'),
      makeVideo(2, '2026-08-20T09:00:00Z'),
    ];
    getVideosSpy = vi.fn(() => of({ success: true, count: videos.length, data: videos }));
    setFavoriteSpy = vi.fn(() => of({ success: true, favorite: true }));
    renameVideoSpy = vi.fn();
    deleteVideoSpy = vi.fn(() => of({ success: true, message: '' }));
    countVideosSpy = vi.fn(() => of({ success: true, count: 0 }));
    purgeVideosSpy = vi.fn(() => of({ success: true, expected: 0, purged: [], failed: [] }));
    bulkDeleteSpy = vi.fn(() => of({ success: true, deleted: [], failed: [] }));
    bulkFavoriteSpy = vi.fn(() => of({ success: true, updated: [], failed: [] }));
    confirmShowSpy = vi.fn(() => Promise.resolve(true));
    toastShowSpy = vi.fn();
    await TestBed.configureTestingModule({
      imports: [GalleryPage],
      providers: [
        {
          provide: CameraService,
          useValue: { getCameras: () => of({ success: true, data: [makeCamera()] }) },
        },
        {
          provide: VideoService,
          useValue: {
            getVideos: getVideosSpy,
            setFavorite: setFavoriteSpy,
            renameVideo: renameVideoSpy,
            deleteVideo: deleteVideoSpy,
            countVideos: countVideosSpy,
            purgeVideos: purgeVideosSpy,
            bulkDelete: bulkDeleteSpy,
            bulkFavorite: bulkFavoriteSpy,
          },
        },
        { provide: ConfirmDialogService, useValue: { show: confirmShowSpy, state: () => null } },
        { provide: ToastService, useValue: { show: toastShowSpy, state: () => null } },
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
      expect(fixture.nativeElement.querySelectorAll('.card').length).toBe(2);
      expect(fixture.nativeElement.querySelectorAll('.day-group').length).toBe(1);
      fixture.destroy();
    });

    it('agrupa por día local: Hoy/Ayer/fecha corta', async () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const localIso = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00`;
      const today = new Date(now);
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const older = new Date(now);
      older.setDate(now.getDate() - 10);
      const fixture = await createPage({
        videos: [
          makeVideo(1, localIso(today)),
          makeVideo(2, localIso(yesterday)),
          makeVideo(3, localIso(older)),
        ],
      });
      const c = fixture.componentInstance;
      const groups = c.dayGroups();
      expect(groups).toHaveLength(3);
      expect(groups[0].label).toBe('Hoy');
      expect(groups[1].label).toBe('Ayer');
      expect(groups[2].label).not.toBe('Hoy');
      expect(groups[2].label).not.toBe('Ayer');
      expect(groups[2].label).toContain(String(older.getFullYear()));
      expect(groups[0].videos).toHaveLength(1);
      fixture.destroy();
    });

    it('muestra el header sticky y el contador de clips', async () => {
      const fixture = await createPage();
      const header = fixture.nativeElement.querySelector('.day-header') as HTMLElement;
      expect(header.textContent).toContain('2026');
      const count = fixture.nativeElement.querySelector('.result-count') as HTMLElement;
      expect(count.textContent).toContain('2 clips');
      fixture.destroy();
    });
  });

  describe('filtros', () => {
    it('los chips de cámara usan value=ftp_dir y label=name', async () => {
      const fixture = await createPage();
      const chips = fixture.nativeElement.querySelectorAll(
        '.chip',
      ) as NodeListOf<HTMLButtonElement>;
      expect(chips.length).toBe(2); // "Todas" + Cámara 1
      expect(chips[0].textContent).toBe('Todas');
      expect(chips[0].classList.contains('is-selected')).toBe(true);
      expect(chips[1].textContent).toBe('Cámara 1');
      expect(chips[1].getAttribute('data-ftp-dir')).toBe('cam1');
      fixture.destroy();
    });

    it('cambiar de chip recarga con el param ftp_dir y offset 0', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.selectCamera('cam1');
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.camera).toBe('cam1');
      expect(last.offset).toBe(0);
      fixture.detectChanges();
      const chips = fixture.nativeElement.querySelectorAll(
        '.chip',
      ) as NodeListOf<HTMLButtonElement>;
      expect(chips[1].classList.contains('is-selected')).toBe(true);
      expect(chips[0].classList.contains('is-selected')).toBe(false);
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
      c.toggleFavoritesOnly();
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.favorite).toBe(1);
      expect(last.offset).toBe(0);
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '.topbar-actions .icon-btn',
      ) as HTMLButtonElement;
      expect(btn.classList.contains('active')).toBe(true);
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

  describe('popover de fechas', () => {
    it('abre y cierra el popover', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      expect(c.datePopoverOpen()).toBe(false);
      c.toggleDatePopover();
      fixture.detectChanges();
      expect(c.datePopoverOpen()).toBe(true);
      expect(fixture.nativeElement.querySelector('.date-popover-panel')).toBeTruthy();
      c.closeDatePopover();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.date-popover-panel')).toBeNull();
      fixture.destroy();
    });

    it('el botón muestra el rango activo o "Cualquier fecha"', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const btn = () =>
        fixture.nativeElement.querySelector('.date-popover .util-btn') as HTMLButtonElement;
      expect(btn().textContent).toContain('Cualquier fecha');
      c.onStartDateChange({ target: { value: '2026-08-01' } } as unknown as Event);
      c.onEndDateChange({ target: { value: '2026-08-07' } } as unknown as Event);
      fixture.detectChanges();
      expect(btn().textContent).toContain('01/08');
      expect(btn().textContent).toContain('07/08');
      fixture.destroy();
    });

    it('limpiar borra el rango, recarga y cierra', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.onStartDateChange({ target: { value: '2026-08-01' } } as unknown as Event);
      c.toggleDatePopover();
      c.clearDateRange();
      expect(c.startDate()).toBe('');
      expect(c.datePopoverOpen()).toBe(false);
      const last = getVideosSpy.mock.calls.at(-1)![0];
      expect(last.startDate).toBeUndefined();
      fixture.destroy();
    });

    it('cierra el popover con un pointerdown fuera del contenedor', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.toggleDatePopover();
      fixture.detectChanges();
      document.body.dispatchEvent(new PointerEvent('pointerdown'));
      expect(c.datePopoverOpen()).toBe(false);
      fixture.detectChanges();
      fixture.destroy();
    });

    it('no cierra el popover con un pointerdown dentro de .date-popover', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.toggleDatePopover();
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('.date-popover-panel') as HTMLElement;
      panel.dispatchEvent(new PointerEvent('pointerdown'));
      expect(c.datePopoverOpen()).toBe(true);
      c.closeDatePopover();
      fixture.detectChanges();
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
      renameVideoSpy.mockReturnValue(
        of({ success: true, video: makeVideo(1, '2026-08-20T10:00:00Z', { name: null }) }),
      );
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

    it('rollback del input si la API falla (con toast de error)', async () => {
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
      expect(toastShowSpy).toHaveBeenCalledWith('No se pudo renombrar', 'error');
      fixture.destroy();
    });

    it('muestra el error bajo el título cuando la API falla', async () => {
      const fixture = await createPage();
      renameVideoSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('.card-title-input') as HTMLInputElement;
      input.value = 'nuevo nombre';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      const err = fixture.nativeElement.querySelector('.card-error') as HTMLElement;
      expect(err.textContent).toContain('No se pudo renombrar');
      fixture.destroy();
    });

    it('Enter en el input confirma y llama a renameVideo', async () => {
      const fixture = await createPage();
      renameVideoSpy.mockReturnValue(
        of({
          success: true,
          video: makeVideo(1, '2026-08-20T10:00:00Z', { name: 'Desde teclado' }),
        }),
      );
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.startRename(vid);
      fixture.detectChanges();
      const input = fixture.nativeElement.querySelector('.card-title-input') as HTMLInputElement;
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
      const input = fixture.nativeElement.querySelector('.card-title-input') as HTMLInputElement;
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
    it('con confirm=true llama a deleteVideo, quita el video y muestra toast', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.deleteVideo(vid);
      await flushAsync();
      expect(confirmShowSpy).toHaveBeenCalledWith(
        expect.objectContaining({ danger: true, confirmLabel: 'Eliminar' }),
      );
      expect(deleteVideoSpy).toHaveBeenCalledWith(vid.id);
      expect(c.videos().find((v) => v.id === vid.id)).toBeUndefined();
      expect(c.videos()).toHaveLength(1);
      expect(toastShowSpy).toHaveBeenCalledWith('Grabación eliminada', 'success');
      fixture.destroy();
    });

    it('con confirm=false no llama a la API', async () => {
      const fixture = await createPage();
      confirmShowSpy.mockReturnValue(Promise.resolve(false));
      const c = fixture.componentInstance;
      c.deleteVideo(c.videos()[0]);
      await flushAsync();
      expect(deleteVideoSpy).not.toHaveBeenCalled();
      expect(c.videos()).toHaveLength(2);
      fixture.destroy();
    });

    it('error de la API muestra toast de error', async () => {
      const fixture = await createPage();
      deleteVideoSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      c.deleteVideo(c.videos()[0]);
      await flushAsync();
      expect(c.videos()).toHaveLength(2); // la lista no se toca
      expect(toastShowSpy).toHaveBeenCalledWith('Error al eliminar', 'error');
      fixture.destroy();
    });
  });

  describe('purge (bottom sheet)', () => {
    it('openPurgeSheet abre la hoja, carga storageCount con countVideos({}) y recalcula el conteo', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      fixture.detectChanges();
      expect(c.purgeOpen()).toBe(true);
      expect(c.purgeScope()).toBe('month'); // default
      // 3 llamadas: storage ({}), total (endDate), favoritos (endDate + favorite=1)
      expect(countVideosSpy).toHaveBeenCalledTimes(3);
      const [storageCall, totalCall, favCall] = countVideosSpy.mock.calls.map((call) => call[0]);
      expect(storageCall).toEqual({});
      expect(totalCall.endDate).toBeTruthy(); // retención: ahora - 1 mes
      expect(totalCall.favorite).toBeUndefined();
      expect(favCall.endDate).toBe(totalCall.endDate);
      expect(favCall.favorite).toBe(1);
      expect(c.storageCount()).toBe(0);
      expect(c.purgeExpected()).toBe(0);
      const backdrop = fixture.nativeElement.querySelector('.sheet-backdrop') as HTMLElement;
      const sheet = fixture.nativeElement.querySelector('.sheet') as HTMLElement;
      expect(backdrop.classList.contains('show')).toBe(true);
      expect(sheet.classList.contains('show')).toBe(true);
      fixture.destroy();
    });

    it('closePurgeSheet cierra la hoja y el click en el backdrop también', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      fixture.detectChanges();
      const backdrop = fixture.nativeElement.querySelector('.sheet-backdrop') as HTMLElement;
      backdrop.dispatchEvent(new MouseEvent('click'));
      expect(c.purgeOpen()).toBe(false);
      c.openPurgeSheet();
      c.closePurgeSheet();
      fixture.detectChanges();
      expect(c.purgeOpen()).toBe(false);
      const sheet = fixture.nativeElement.querySelector('.sheet') as HTMLElement;
      expect(sheet.classList.contains('show')).toBe(false);
      fixture.destroy();
    });

    it('la hoja muestra los 4 scopes y marca el seleccionado', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      fixture.detectChanges();
      const buttons = fixture.nativeElement.querySelectorAll(
        '.segmented button',
      ) as NodeListOf<HTMLButtonElement>;
      expect(buttons.length).toBe(4);
      expect(buttons[2].classList.contains('is-selected')).toBe(true); // default 'month'
      c.selectPurgeScope('all');
      fixture.detectChanges();
      expect(buttons[3].classList.contains('is-selected')).toBe(true);
      expect(buttons[2].classList.contains('is-selected')).toBe(false);
      fixture.destroy();
    });

    it('selectPurgeScope("all") recalcula con params {} (sin endDate)', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 2 : 9 }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.selectPurgeScope('all');
      const calls = countVideosSpy.mock.calls.map((call) => call[0]);
      expect(calls.at(-2)).toEqual({});
      expect(calls.at(-1)).toEqual({ favorite: 1 });
      expect(c.purgeScope()).toBe('all');
      expect(c.purgeExpected()).toBe(7);
      fixture.destroy();
    });

    it('selectPurgeScope("day") recalcula con endDate = ahora - 1 día', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 1 : 5 }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.selectPurgeScope('day');
      const calls = countVideosSpy.mock.calls.map((call) => call[0]);
      const totalCall = calls.at(-2)!;
      expect(totalCall.endDate).toBeTruthy();
      expect(totalCall.favorite).toBeUndefined();
      expect(c.purgeExpected()).toBe(4);
      fixture.destroy();
    });

    it('purgeExpected = max(0, total - favoritos)', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 10 : 3 }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      expect(c.purgeExpected()).toBe(0);
      fixture.destroy();
    });

    it('onPurge no hace nada si purgeExpected es 0', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.openPurgeSheet(); // expected = 0 (mock default count 0)
      c.onPurge();
      await flushAsync();
      expect(confirmShowSpy).not.toHaveBeenCalled();
      expect(purgeVideosSpy).not.toHaveBeenCalled();
      fixture.destroy();
    });

    it('onPurge con confirm=false no purga', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 0 : 4 }),
      );
      confirmShowSpy.mockReturnValue(Promise.resolve(false));
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.onPurge();
      await flushAsync();
      expect(confirmShowSpy).toHaveBeenCalled();
      expect(purgeVideosSpy).not.toHaveBeenCalled();
      expect(c.purging()).toBe(false);
      fixture.destroy();
    });

    it('onPurge muestra confirm danger con el mensaje de "toda la biblioteca" para scope all', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 1 : 6 }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.selectPurgeScope('all');
      c.onPurge();
      await flushAsync();
      expect(confirmShowSpy).toHaveBeenCalledWith({
        title: 'Purgar 5 clips',
        message:
          'Se eliminarán de forma permanente todos los clips de la biblioteca. Los favoritos no se borran.',
        confirmLabel: 'Purgar 5',
        danger: true,
      });
      fixture.destroy();
    });

    it('onPurge usa el mensaje de antigüedad para los scopes de fecha', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 0 : 3 }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.onPurge(); // scope default 'month'
      await flushAsync();
      expect(confirmShowSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Purgar 3 clips',
          message:
            'Se eliminarán de forma permanente los clips con más de 1 mes de antigüedad. Los favoritos no se borran.',
          confirmLabel: 'Purgar 3',
          danger: true,
        }),
      );
      fixture.destroy();
    });

    it('onPurge exitoso: purgeVideos({scope}), toast con el conteo, cierra la hoja y recarga', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 2 : 8 }),
      );
      purgeVideosSpy.mockReturnValue(
        of({ success: true, expected: 6, purged: ['a', 'b', 'c', 'd', 'e', 'f'], failed: [] }),
      );
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.selectPurgeScope('week');
      const getVideosBefore = getVideosSpy.mock.calls.length;
      c.onPurge();
      await flushAsync();
      expect(purgeVideosSpy).toHaveBeenCalledWith({ scope: 'week' });
      expect(toastShowSpy).toHaveBeenCalledWith('6 clips purgados', 'success');
      expect(c.purging()).toBe(false);
      expect(c.purgeOpen()).toBe(false);
      expect(getVideosSpy.mock.calls.length).toBeGreaterThan(getVideosBefore); // reload
      fixture.destroy();
    });

    it('onPurge exitoso con 1 clip usa el singular', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 0 : 1 }),
      );
      purgeVideosSpy.mockReturnValue(of({ success: true, expected: 1, purged: ['a'], failed: [] }));
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.onPurge();
      await flushAsync();
      expect(toastShowSpy).toHaveBeenCalledWith('1 clip purgado', 'success');
      expect(c.purgeOpen()).toBe(false);
      fixture.destroy();
    });

    it('onPurge con 0 purgados muestra toast info y cierra la hoja', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 0 : 4 }),
      );
      purgeVideosSpy.mockReturnValue(of({ success: true, expected: 4, purged: [], failed: [] }));
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.onPurge();
      await flushAsync();
      expect(toastShowSpy).toHaveBeenCalledWith('No había clips en ese alcance', 'info');
      expect(c.purgeOpen()).toBe(false);
      fixture.destroy();
    });

    it('onPurge con error: toast de error, hoja abierta y purging reseteado', async () => {
      const fixture = await createPage();
      countVideosSpy.mockImplementation((params: { favorite?: 0 | 1 }) =>
        of({ success: true, count: params.favorite === 1 ? 0 : 3 }),
      );
      purgeVideosSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      c.openPurgeSheet();
      c.onPurge();
      await flushAsync();
      expect(toastShowSpy).toHaveBeenCalledWith('Error al purgar', 'error');
      expect(c.purging()).toBe(false);
      expect(c.purgeOpen()).toBe(true);
      fixture.destroy();
    });

    it('storageUsedLabel formatea GB', async () => {
      const fixture = await createPage({
        videos: [makeVideo(1, '2026-08-20T10:00:00Z', { file_size: 2 * 1073741824 })],
      });
      expect(fixture.componentInstance.storageUsedLabel()).toBe('2.0 GB');
      fixture.destroy();
    });

    it('storageUsedLabel formatea MB', async () => {
      const fixture = await createPage({
        videos: [makeVideo(1, '2026-08-20T10:00:00Z', { file_size: 5 * 1048576 })],
      });
      expect(fixture.componentInstance.storageUsedLabel()).toBe('5 MB');
      fixture.destroy();
    });

    it('storageUsedLabel formatea KB', async () => {
      const fixture = await createPage({
        videos: [makeVideo(1, '2026-08-20T10:00:00Z', { file_size: 51200 })],
      });
      expect(fixture.componentInstance.storageUsedLabel()).toBe('50 KB');
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

  describe('estados de carga y vacíos', () => {
    it('muestra "Cargando…" mientras la API responde', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const pending = new Subject<{ success: boolean; count: number; data: Video[] }>();
      getVideosSpy.mockReturnValue(pending.asObservable());
      c.reload();
      fixture.detectChanges();
      expect(c.loading()).toBe(true);
      const el = fixture.nativeElement.querySelector('.loading') as HTMLElement;
      expect(el.textContent).toContain('Cargando…');
      pending.next({ success: true, count: c.videos().length, data: c.videos() });
      fixture.detectChanges();
      expect(c.loading()).toBe(false);
      expect(fixture.nativeElement.querySelectorAll('.card').length).toBe(2);
      fixture.destroy();
    });

    it('sin filtros muestra "Sin grabaciones"', async () => {
      const fixture = await createPage({ videos: [] });
      fixture.detectChanges();
      expect(fixture.componentInstance.hasFilters()).toBe(false);
      const empty = fixture.nativeElement.querySelector('.empty-state') as HTMLElement;
      expect(empty).toBeTruthy();
      expect(empty.querySelector('h3')!.textContent).toBe('Sin grabaciones');
      expect(empty.querySelector('p')!.textContent).toContain('Esperando nuevas grabaciones');
      fixture.destroy();
    });

    it('con filtros muestra "Sin resultados"', async () => {
      const fixture = await createPage({ videos: [] });
      const c = fixture.componentInstance;
      c.toggleFavoritesOnly();
      fixture.detectChanges();
      expect(c.hasFilters()).toBe(true);
      const empty = fixture.nativeElement.querySelector('.empty-state') as HTMLElement;
      expect(empty).toBeTruthy();
      expect(empty.querySelector('h3')!.textContent).toBe('Sin resultados');
      expect(empty.querySelector('p')!.textContent).toContain('Ninguna grabación coincide');
      fixture.destroy();
    });
  });

  describe('scroll infinito', () => {
    const originalScrollY = window.scrollY;
    const originalInnerHeight = window.innerHeight;
    const originalScrollHeight = document.documentElement.scrollHeight;

    // jsdom no tiene layout: se emula la geometría de scroll.
    function setGeometry(scrollY: number, innerHeight: number, scrollHeight: number) {
      Object.defineProperty(window, 'scrollY', {
        configurable: true,
        writable: true,
        value: scrollY,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: innerHeight,
      });
      Object.defineProperty(document.documentElement, 'scrollHeight', {
        configurable: true,
        writable: true,
        value: scrollHeight,
      });
    }

    afterEach(() => {
      setGeometry(originalScrollY, originalInnerHeight, originalScrollHeight);
    });

    function makeFullPage(): Video[] {
      return Array.from({ length: 24 }, (_, i) => makeVideo(i + 1, '2026-08-20T10:00:00Z'));
    }

    it('cerca del fondo dispara loadMore con offset = LIMIT', async () => {
      const full = makeFullPage();
      const fixture = await createPage({ videos: full });
      // Página corta en la 2ª llamada para que la cadena de auto-carga termine.
      getVideosSpy.mockImplementation((params: { offset?: number }) =>
        of({
          success: true,
          count: params.offset === 0 ? 24 : 5,
          data: params.offset === 0 ? full : full.slice(0, 5),
        }),
      );
      setGeometry(1000, 800, 1800); // 1000 + 800 >= 1800 - 300
      const callsBefore = getVideosSpy.mock.calls.length;
      window.dispatchEvent(new Event('scroll'));
      expect(getVideosSpy.mock.calls.length).toBe(callsBefore + 1);
      expect(getVideosSpy.mock.calls.at(-1)![0].offset).toBe(24);
      fixture.destroy();
    });

    it('lejos del fondo no dispara loadMore', async () => {
      const fixture = await createPage({ videos: makeFullPage() });
      setGeometry(0, 800, 5000); // 0 + 800 < 5000 - 300
      const callsBefore = getVideosSpy.mock.calls.length;
      window.dispatchEvent(new Event('scroll'));
      expect(getVideosSpy.mock.calls.length).toBe(callsBefore);
      fixture.destroy();
    });

    it('no dispara loadMore mientras loadingMore es true', async () => {
      const fixture = await createPage({ videos: makeFullPage() });
      fixture.componentInstance.loadingMore.set(true);
      setGeometry(1000, 800, 1800);
      const callsBefore = getVideosSpy.mock.calls.length;
      window.dispatchEvent(new Event('scroll'));
      expect(getVideosSpy.mock.calls.length).toBe(callsBefore);
      fixture.destroy();
    });

    it('no dispara loadMore con el player abierto', async () => {
      const fixture = await createPage({ videos: makeFullPage() });
      fixture.componentInstance.onPlay(fixture.componentInstance.videos()[0]);
      setGeometry(1000, 800, 1800);
      const callsBefore = getVideosSpy.mock.calls.length;
      window.dispatchEvent(new Event('scroll'));
      expect(getVideosSpy.mock.calls.length).toBe(callsBefore);
      fixture.destroy();
    });
  });

  describe('player overlay', () => {
    it('no renderiza el overlay cuando playingVideo es null', async () => {
      const fixture = await createPage();
      expect(fixture.nativeElement.querySelector('.player-overlay')).toBeNull();
      expect(fixture.debugElement.query(By.directive(Player))).toBeNull();
      fixture.destroy();
    });

    it('onPlay(vid) renderiza el overlay y el yi-player recibe el video', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.onPlay(vid);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.player-overlay')).toBeTruthy();
      const playerDe = fixture.debugElement.query(By.directive(Player));
      expect(playerDe).toBeTruthy();
      const player = playerDe.componentInstance as Player;
      expect(player.video()).toBe(vid);
      expect(player.title()).toBe(vid.camera_name);
      expect(player.isFavorite()).toBe(false);
      fixture.destroy();
    });

    it('closePlayer() pone playingVideo en null y quita el overlay', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.onPlay(c.videos()[0]);
      fixture.detectChanges();
      c.closePlayer();
      fixture.detectChanges();
      expect(c.playingVideo()).toBeNull();
      expect(fixture.nativeElement.querySelector('.player-overlay')).toBeNull();
      fixture.destroy();
    });

    it('click en el fondo cierra; click dentro del player no (stopPropagation)', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.onPlay(c.videos()[0]);
      fixture.detectChanges();
      const host = fixture.nativeElement.querySelector('.player-host') as HTMLElement;
      host.dispatchEvent(new MouseEvent('click'));
      expect(c.playingVideo()).not.toBeNull();
      const overlay = fixture.nativeElement.querySelector('.player-overlay') as HTMLElement;
      overlay.dispatchEvent(new MouseEvent('click'));
      expect(c.playingVideo()).toBeNull();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.player-overlay')).toBeNull();
      fixture.destroy();
    });

    it('el output favorite del player alterna favorito y sincroniza playingVideo', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.onPlay(vid);
      fixture.detectChanges();
      const player = fixture.debugElement.query(By.directive(Player)).componentInstance as Player;
      player.toggleFavorite(); // emite favorite con el video actual
      expect(setFavoriteSpy).toHaveBeenCalledWith(vid.id, true);
      expect(c.videos()[0].favorite).toBe(true);
      expect(c.playingVideo()?.favorite).toBe(true);
      fixture.destroy();
    });
  });

  describe('selección múltiple', () => {
    it('onCardClick reproduce el video cuando no hay modo selección', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.onCardClick(vid);
      expect(c.playingVideo()).toBe(vid);
      expect(c.selectedCount()).toBe(0);
      fixture.destroy();
    });

    it('onCardClick alterna la selección cuando hay modo selección', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      const vid = c.videos()[0];
      c.onCardClick(vid);
      expect(c.selected().has(vid.id)).toBe(true);
      expect(c.selectedCount()).toBe(1);
      expect(c.playingVideo()).toBeNull();
      c.onCardClick(vid);
      expect(c.selected().has(vid.id)).toBe(false);
      expect(c.selectedCount()).toBe(0);
      fixture.destroy();
    });

    it('toggleSelectMode entra en selección y al salir limpia selected', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      expect(c.selecting()).toBe(false);
      c.toggleSelectMode();
      expect(c.selecting()).toBe(true);
      c.toggleSelect(c.videos()[0]);
      expect(c.selectedCount()).toBe(1);
      c.toggleSelectMode();
      expect(c.selecting()).toBe(false);
      expect(c.selectedCount()).toBe(0);
      fixture.destroy();
    });

    it('toggleSelectMode alterna la clase .show de la selection-bar', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const bar = () => fixture.nativeElement.querySelector('.selection-bar') as HTMLElement;
      expect(bar().classList.contains('show')).toBe(false);
      c.toggleSelectMode();
      fixture.detectChanges();
      expect(bar().classList.contains('show')).toBe(true);
      c.exitSelection();
      fixture.detectChanges();
      expect(bar().classList.contains('show')).toBe(false);
      fixture.destroy();
    });

    it('la barra muestra el conteo en singular y plural', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.toggleSelect(c.videos()[0]);
      fixture.detectChanges();
      const count = () => fixture.nativeElement.querySelector('.sel-count') as HTMLElement;
      expect(count().textContent).toContain('1 seleccionado');
      c.toggleSelect(c.videos()[1]);
      fixture.detectChanges();
      expect(count().textContent).toContain('2 seleccionados');
      fixture.destroy();
    });

    it('bulkFavorite marca favorito a todos si no todos lo son y sigue en selección', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1, 2]));
      c.bulkFavorite();
      expect(bulkFavoriteSpy).toHaveBeenCalledWith([1, 2], true);
      expect(c.videos()[0].favorite).toBe(true);
      expect(c.videos()[1].favorite).toBe(true);
      expect(c.selecting()).toBe(true);
      expect(toastShowSpy).toHaveBeenCalledWith('Añadidos a favoritos', 'success');
      fixture.destroy();
    });

    it('bulkFavorite quita de favoritos a todos si todos lo son', async () => {
      const fixture = await createPage({
        videos: [
          makeVideo(1, '2026-08-20T10:00:00Z', { favorite: true }),
          makeVideo(2, '2026-08-20T09:00:00Z', { favorite: true }),
        ],
      });
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1, 2]));
      c.bulkFavorite();
      expect(bulkFavoriteSpy).toHaveBeenCalledWith([1, 2], false);
      expect(c.videos()[0].favorite).toBe(false);
      expect(c.videos()[1].favorite).toBe(false);
      expect(toastShowSpy).toHaveBeenCalledWith('Quitados de favoritos', 'success');
      fixture.destroy();
    });

    it('bulkFavorite revierte el update optimista si la API falla', async () => {
      const fixture = await createPage({
        videos: [
          makeVideo(1, '2026-08-20T10:00:00Z', { favorite: true }),
          makeVideo(2, '2026-08-20T09:00:00Z', { favorite: false }),
        ],
      });
      bulkFavoriteSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1, 2]));
      c.bulkFavorite();
      expect(c.videos()[0].favorite).toBe(true); // rollback
      expect(c.videos()[1].favorite).toBe(false); // rollback
      expect(c.selecting()).toBe(true);
      expect(toastShowSpy).toHaveBeenCalledWith('Error al actualizar favoritos', 'error');
      fixture.destroy();
    });

    it('bulkDelete elimina los videos, sale de selección y muestra toast', async () => {
      const fixture = await createPage();
      // El API devuelve los ids como string.
      bulkDeleteSpy.mockReturnValue(of({ success: true, deleted: ['1', '2'], failed: [] }));
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1, 2]));
      c.bulkDelete();
      await flushAsync();
      expect(confirmShowSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          danger: true,
          confirmLabel: 'Eliminar 2',
          title: 'Eliminar 2 clips',
        }),
      );
      expect(bulkDeleteSpy).toHaveBeenCalledWith([1, 2]);
      expect(c.videos()).toHaveLength(0);
      expect(c.selecting()).toBe(false);
      expect(c.selectedCount()).toBe(0);
      expect(toastShowSpy).toHaveBeenCalledWith('2 clips eliminados', 'success');
      fixture.destroy();
    });

    it('bulkDelete usa el fallback a ids si la API no devuelve deleted', async () => {
      const fixture = await createPage();
      bulkDeleteSpy.mockReturnValue(of({ success: true, deleted: [], failed: [] }));
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1]));
      c.bulkDelete();
      await flushAsync();
      expect(c.videos()).toHaveLength(1);
      expect(c.videos()[0].id).toBe(2);
      expect(c.selecting()).toBe(false);
      expect(toastShowSpy).toHaveBeenCalledWith('1 clip eliminado', 'success');
      fixture.destroy();
    });

    it('bulkDelete con error de API se queda en selección y no toca la lista', async () => {
      const fixture = await createPage();
      bulkDeleteSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1, 2]));
      c.bulkDelete();
      await flushAsync();
      expect(c.videos()).toHaveLength(2);
      expect(c.selecting()).toBe(true);
      expect(c.selectedCount()).toBe(2);
      expect(toastShowSpy).toHaveBeenCalledWith('Error al eliminar', 'error');
      fixture.destroy();
    });

    it('bulkDelete con confirm=false no llama a la API', async () => {
      const fixture = await createPage();
      confirmShowSpy.mockReturnValue(Promise.resolve(false));
      const c = fixture.componentInstance;
      c.toggleSelectMode();
      c.selected.set(new Set([1]));
      c.bulkDelete();
      await flushAsync();
      expect(bulkDeleteSpy).not.toHaveBeenCalled();
      expect(c.videos()).toHaveLength(2);
      fixture.destroy();
    });
  });

  describe('favoritos con player abierto', () => {
    it('toggleFavorite sincroniza playingVideo', async () => {
      const fixture = await createPage();
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.onPlay(vid);
      c.toggleFavorite(vid);
      expect(c.playingVideo()?.favorite).toBe(true);
      expect(c.playingVideo()).not.toBe(vid); // nuevo objeto
      fixture.destroy();
    });

    it('toggleFavorite revierte playingVideo si la API falla', async () => {
      const fixture = await createPage();
      setFavoriteSpy.mockReturnValue(throwError(() => new Error('boom')));
      const c = fixture.componentInstance;
      const vid = c.videos()[0];
      c.onPlay(vid);
      c.toggleFavorite(vid);
      expect(c.playingVideo()?.favorite).toBe(false);
      fixture.destroy();
    });
  });
});
