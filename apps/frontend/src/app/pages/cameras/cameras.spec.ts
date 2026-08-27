import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { Cameras } from './cameras';
import { CameraService } from '../../services/camera.service';
import { PowerService } from '../../services/power.service';
import { Camera, CameraStatus } from '../../models/camera.model';
import { Video } from '../../models/video.model';

function makeStatus(id: string, state: 'on' | 'off' | 'unreachable'): CameraStatus {
  return {
    id,
    host: '192.168.1.50',
    ecosystem: 'yi-hack',
    capabilities: {
      live_status: true,
      controls: true,
      sd: true,
      wifi: true,
      system: true,
      mqtt: true,
      push: true,
      videos: true,
    },
    state,
    http: true,
    mqtt: { online: true, lastSeen: '2026-08-20T10:00:00Z' },
    status: null,
    camera_config: { SWITCH_ON: 'yes', SAVE_VIDEO_ON_MOTION: 'yes' },
    system_config: null,
    sd: null,
    video_count: 2,
    last_video: '2026-08-20T10:00:00Z',
    push_enabled: true,
    last_event: { event_type: 'motion', received_at: '2026-08-20T10:05:00Z' },
    last_motion: null,
  };
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 1,
    name: null,
    camera_name: 'cam1',
    timestamp: '2026-08-20T10:00:00Z',
    original_path: '/videos/cam1/1.mp4',
    thumbnail_path: '/videos/cam1/1.jpg',
    preview_path: '/videos/cam1/1.webm',
    duration: 10,
    file_size: 123456,
    favorite: false,
    original_url: '/media/videos/cam1/1.mp4',
    thumbnail_url: '/media/videos/cam1/1.jpg',
    preview_url: '/media/videos/cam1/1.webm',
    ...overrides,
  };
}

function makeCamera(overrides: Partial<Camera> = {}): Camera {
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
    status: makeStatus('cam1', 'on'),
    latest_video: makeVideo(),
    ...overrides,
  };
}

describe('Cameras', () => {
  let getCamerasSpy: ReturnType<typeof vi.fn>;
  let powerSeedSpy: ReturnType<typeof vi.fn>;
  let powerToggleSpy: ReturnType<typeof vi.fn>;

  async function createPage(overrides?: { cameras?: Camera[]; camerasError?: boolean }) {
    const cameras = overrides?.cameras ?? [
      makeCamera(),
      makeCamera({
        id: 'cam2',
        name: 'Cámara 2',
        host: '192.168.1.51',
        ecosystem: 'generic',
        ftp_dir: 'cam2',
        status: null,
        latest_video: null,
      }),
    ];
    getCamerasSpy = vi.fn(() =>
      overrides?.camerasError
        ? throwError(() => new Error('boom'))
        : of({ success: true, count: cameras.length, data: cameras }),
    );
    powerSeedSpy = vi.fn();
    powerToggleSpy = vi.fn();
    await TestBed.configureTestingModule({
      imports: [Cameras],
      providers: [
        provideRouter([]),
        { provide: CameraService, useValue: { getCameras: getCamerasSpy } },
        {
          provide: PowerService,
          useValue: { isOn: () => null, seed: powerSeedSpy, toggle: powerToggleSpy },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(Cameras);
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const fixture = await createPage();
    expect(fixture.componentInstance).toBeTruthy();
    fixture.destroy();
  });

  it('un solo getCameras: renderiza una card por cámara', async () => {
    const fixture = await createPage();
    const c = fixture.componentInstance;
    expect(getCamerasSpy).toHaveBeenCalledTimes(1);
    expect(c.cameras()).toHaveLength(2);
    expect(c.loading()).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('yi-camera-card').length).toBe(2);
    fixture.destroy();
  });

  it('siembra el encendido desde status.camera_config (solo yi-hack)', async () => {
    await createPage();
    expect(powerSeedSpy).toHaveBeenCalledTimes(1);
    expect(powerSeedSpy).toHaveBeenCalledWith('cam1', true);
  });

  it('la card recibe la fecha de latest_video.timestamp y su thumbnail', async () => {
    const video = makeVideo({ timestamp: '2026-08-20T10:00:00Z' });
    const fixture = await createPage({ cameras: [makeCamera({ latest_video: video })] });
    const c = fixture.componentInstance;
    expect(c.lastClipAt(c.cameras()[0])).toBe('2026-08-20T10:00:00Z');
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('.camera-thumb img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(video.thumbnail_url);
    // Chip OSD y fila de meta formatean la misma fecha.
    const osd = fixture.nativeElement.querySelector('.osd-chip') as HTMLElement;
    const meta = fixture.nativeElement.querySelector('.camera-last') as HTMLElement;
    expect(osd.textContent).toBeTruthy();
    expect(osd.textContent).toBe(meta.textContent.trim());
    fixture.destroy();
  });

  it('yi-hack sin clips: lastClipAt null y la card muestra "Sin grabaciones"', async () => {
    const fixture = await createPage({
      cameras: [makeCamera({ latest_video: null })],
    });
    const c = fixture.componentInstance;
    expect(c.lastClipAt(c.cameras()[0])).toBeNull();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.osd-chip')).toBeNull();
    expect(fixture.nativeElement.querySelector('.camera-last')!.textContent).toContain(
      'Sin grabaciones',
    );
    fixture.destroy();
  });

  it('con yi-hack y status "on" la card muestra la pill de estado', async () => {
    const fixture = await createPage();
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('.state-pill') as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain('En línea');
    fixture.destroy();
  });

  it('el click en el toggle llama a powerService.toggle(id)', async () => {
    const fixture = await createPage();
    const btn = fixture.nativeElement.querySelector('.power-toggle') as HTMLButtonElement;
    btn.dispatchEvent(new MouseEvent('click'));
    expect(powerToggleSpy).toHaveBeenCalledWith('cam1');
    fixture.destroy();
  });

  it('error de getCameras: loading false sin crash', async () => {
    const fixture = await createPage({ camerasError: true });
    const c = fixture.componentInstance;
    expect(c.loading()).toBe(false);
    expect(c.cameras()).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('yi-empty-state')).toBeTruthy();
    fixture.destroy();
  });

  it('generic: sin controles ni pill de estado', async () => {
    const fixture = await createPage();
    fixture.detectChanges();
    const cards = fixture.nativeElement.querySelectorAll('yi-camera-card');
    const genericCard = cards[1];
    // La generic no muestra botón de encendido ni pill de estado.
    expect(genericCard.querySelectorAll('.power-toggle').length).toBe(0);
    expect(genericCard.querySelector('.state-pill')).toBeNull();
    // Solo la yi-hack (cam1) muestra el botón de encendido.
    expect(fixture.nativeElement.querySelectorAll('.power-toggle').length).toBe(1);
    fixture.destroy();
  });
});
