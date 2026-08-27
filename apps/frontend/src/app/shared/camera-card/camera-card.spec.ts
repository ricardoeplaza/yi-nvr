import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { CameraCard } from './camera-card';
import { Camera, CameraStatus } from '../../models/camera.model';

function makeCamera(extra: Partial<Camera> = {}): Camera {
  return {
    id: 'cam1',
    name: 'Salón',
    host: '192.168.1.50',
    ecosystem: 'yi-hack',
    ftp_dir: '/media/cam1',
    capabilities: { led: true, ircut: true, rec_mode: true, power: true },
    has_videos: true,
    video_count: 12,
    last_video: null,
    status: null,
    latest_video: null,
    ...extra,
  };
}

function makeStatus(extra: Partial<CameraStatus> = {}): CameraStatus {
  return {
    id: 'cam1',
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
    state: 'on',
    http: true,
    mqtt: null,
    status: null,
    camera_config: null,
    system_config: null,
    sd: null,
    video_count: 12,
    last_video: null,
    push_enabled: false,
    last_event: null,
    last_motion: null,
    ...extra,
  };
}

@Component({
  imports: [CameraCard],
  template: `
    <yi-camera-card
      [camera]="camera()"
      [status]="status()"
      [powerOn]="powerOn()"
      [thumbnailUrl]="thumbnailUrl()"
      [lastEventAt]="lastEventAt()"
      (togglePower)="onToggle($event)"
    />
  `,
})
class HostComponent {
  camera = signal<Camera>(makeCamera());
  status = signal<CameraStatus | null>(null);
  powerOn = signal<boolean | null>(null);
  thumbnailUrl = signal<string | null>(null);
  lastEventAt = signal<string | null>(null);
  onToggle = vi.fn();
}

describe('CameraCard', () => {
  async function createHost() {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('renderiza el nombre y el badge de ecosistema', async () => {
    const fixture = await createHost();
    expect(fixture.nativeElement.querySelector('.camera-name')!.textContent).toContain('Salón');
    expect(fixture.nativeElement.querySelector('.eco-badge')!.textContent).toContain('yi-hack');
    fixture.destroy();
  });

  it('generic no muestra pill de estado, fila 2 ni toggle', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.camera.set(makeCamera({ ecosystem: 'generic', name: 'Puerta' }));
    host.status.set(makeStatus({ ecosystem: 'generic', state: null, http: null }));
    host.powerOn.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.state-pill')).toBeNull();
    expect(fixture.nativeElement.querySelector('.meta-row-2')).toBeNull();
    expect(fixture.nativeElement.querySelector('.power-toggle')).toBeNull();
    expect(fixture.nativeElement.querySelector('.eco-badge')!.textContent).toContain('genérica');
    fixture.destroy();
  });

  it("yi-hack state 'on' con http true muestra pill 'En línea'", async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.status.set(makeStatus({ state: 'on', http: true }));
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector('.state-pill') as HTMLElement;
    expect(pill.textContent).toContain('En línea');
    expect(pill.classList.contains('online')).toBe(true);
    fixture.destroy();
  });

  it("state 'off' desatura la imagen", async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    host.thumbnailUrl.set('https://example.com/thumb.jpg');
    host.status.set(makeStatus({ state: 'off', http: false }));
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('.camera-thumb img') as HTMLImageElement;
    expect(img.classList.contains('desaturated')).toBe(true);
    const pill = fixture.nativeElement.querySelector('.state-pill') as HTMLElement;
    expect(pill.textContent).toContain('Apagada');
    fixture.destroy();
  });

  it('powerOn true muestra el toggle Encendido ON activo; null muestra OFF', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    let btn = fixture.nativeElement.querySelector('.power-toggle') as HTMLElement;
    expect(btn.textContent).toContain('Encendido');
    expect(btn.textContent).toContain('OFF');
    expect(btn.classList.contains('active')).toBe(false);

    host.powerOn.set(true);
    fixture.detectChanges();
    btn = fixture.nativeElement.querySelector('.power-toggle') as HTMLElement;
    expect(btn.textContent).toContain('ON');
    expect(btn.classList.contains('active')).toBe(true);
    fixture.destroy();
  });

  it('click en el toggle emite togglePower con la cámara', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    (fixture.nativeElement.querySelector('.power-toggle') as HTMLElement).click();
    expect(host.onToggle).toHaveBeenCalledWith(host.camera());
    fixture.destroy();
  });

  it('click en la thumb no dispara el toggle', async () => {
    const fixture = await createHost();
    const host = fixture.componentInstance;
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockReturnValue(Promise.resolve(false));
    (fixture.nativeElement.querySelector('.camera-thumb') as HTMLElement).click();
    expect(host.onToggle).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
