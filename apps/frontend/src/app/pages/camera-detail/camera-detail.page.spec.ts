import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { CameraDetailPage } from './camera-detail.page';
import { CameraService } from '../../services/camera.service';
import { StreamService } from '../../services/stream.service';
import { Camera, CameraStatus } from '../../models/camera.model';

const ALL_CAPS = {
  live_status: true,
  controls: true,
  sd: true,
  wifi: true,
  system: true,
  mqtt: true,
  push: true,
  videos: true,
};
const GENERIC_CAPS = {
  live_status: false,
  controls: false,
  sd: false,
  wifi: false,
  system: false,
  mqtt: false,
  push: true,
  videos: true,
};

function makeCamera(eco: 'yi-hack' | 'generic'): Camera {
  return {
    id: 'cam1',
    name: 'Cámara 1',
    host: '192.168.1.50',
    ecosystem: eco,
    ftp_dir: 'cam1',
    capabilities: { led: true, ircut: true, rec_mode: true, power: true },
    has_videos: true,
    video_count: 12,
    last_video: '2026-08-20T10:00:00Z',
    mqtt: null,
    status: null,
    latest_video: null,
  };
}

function makeStatus(eco: 'yi-hack' | 'generic'): CameraStatus {
  const nvr = {
    video_count: 12,
    last_video: '2026-08-20T10:00:00Z',
    push_enabled: true,
    last_event: { event_type: 'motion', received_at: '2026-08-20T10:05:00Z' },
    last_motion: { event_type: 'motion', received_at: '2026-08-20T10:05:00Z' },
  };
  if (eco === 'generic') {
    return {
      id: 'cam1',
      host: '192.168.1.50',
      ecosystem: 'generic',
      capabilities: GENERIC_CAPS,
      state: null,
      http: null,
      mqtt: null,
      status: null,
      camera_config: null,
      system_config: null,
      sd: null,
      ...nvr,
    };
  }
  return {
    id: 'cam1',
    host: '192.168.1.50',
    ecosystem: 'yi-hack',
    capabilities: ALL_CAPS,
    state: 'on',
    http: true,
    mqtt: { online: true, lastSeen: '2026-08-20T10:00:00Z' },
    status: {
      fw_version: '1.2.3',
      uptime: '3600',
      local_ip: '192.168.1.50',
      mac_addr: 'AA:BB:CC:DD:EE:FF',
      serial_number: 'SN123',
      wlan_essid: 'miwifi',
      wlan_strength: '-55',
    },
    camera_config: { SWITCH_ON: 'yes', LED: 'no', IR: 'yes', SAVE_VIDEO_ON_MOTION: 'yes' },
    system_config: { HTTPD: 'yes' },
    sd: { total_mb: 32768, free_mb: 16000, used_mb: 16768, free_pct: 49 },
    ...nvr,
  };
}

describe('CameraDetailPage', () => {
  let camera: Camera;
  let status: CameraStatus;
  let pushError: unknown;

  function cameraServiceMock() {
    return {
      getCameras: () => of({ success: true, count: 1, data: [camera] }),
      getCameraStatus: () => of({ success: true, data: status }),
      setPower: () => of({ success: true, published: true, payload: {} }),
      setLed: () => of({ success: true, published: true, payload: {} }),
      setNightVision: () => of({ success: true, published: true, payload: {} }),
      setRecMode: () => of({ success: true, published: true, payload: {} }),
      setGroupPower: () => of({ success: true }),
      setHttpd: () => of({ success: true, httpd: 'yes', applied: 'next_boot' }),
      setPush: () =>
        pushError ? throwError(() => pushError) : of({ success: true, push_enabled: false }),
      rebootCamera: () => of({ success: true, rebooted: true }),
    };
  }

  async function createPage(cam: Camera, st: CameraStatus) {
    camera = cam;
    status = st;
    pushError = null;
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [CameraDetailPage],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'cam1' } } } },
        { provide: CameraService, useValue: cameraServiceMock() },
        { provide: StreamService, useValue: { getStreamInfo: () => of({ success: false }) } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(CameraDetailPage);
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const fixture = await createPage(makeCamera('yi-hack'), makeStatus('yi-hack'));
    expect(fixture.componentInstance).toBeTruthy();
    fixture.destroy();
  });

  describe('yi-hack (capabilities completos)', () => {
    it('muestra estado, SD, controles de dispositivo y datos de sistema', async () => {
      const fixture = await createPage(makeCamera('yi-hack'), makeStatus('yi-hack'));
      const host = fixture.nativeElement;
      expect(host.querySelector('.cam-state')).toBeTruthy();
      expect(host.querySelector('.sd-section')).toBeTruthy();
      expect(host.querySelector('.danger-btn')).toBeTruthy();
      expect(host.textContent).toContain('Firmware');
      expect(host.textContent).toContain('WiFi');
      expect(host.textContent).toContain('Serie');
      expect(host.textContent).toContain('Push de movimiento');
      fixture.destroy();
    });
  });

  describe('generic (solo push y videos)', () => {
    it('oculta estado, SD, controles de dispositivo y datos de sistema', async () => {
      const fixture = await createPage(makeCamera('generic'), makeStatus('generic'));
      const host = fixture.nativeElement;
      expect(host.querySelector('.cam-state')).toBeNull();
      expect(host.querySelector('.sd-section')).toBeNull();
      expect(host.querySelector('.danger-btn')).toBeNull();
      expect(host.textContent).not.toContain('Firmware');
      expect(host.textContent).not.toContain('WiFi');
      expect(host.textContent).not.toContain('Serie');
      expect(host.textContent).not.toContain('Visión nocturna');
      fixture.destroy();
    });

    it('muestra host, videos, último video, eventos y el toggle de push', async () => {
      const fixture = await createPage(makeCamera('generic'), makeStatus('generic'));
      const host = fixture.nativeElement;
      expect(host.textContent).toContain('Host');
      expect(host.textContent).toContain('12');
      expect(host.textContent).toContain('Último video');
      expect(host.textContent).toContain('Último evento');
      expect(host.textContent).toContain('Push de movimiento');
      fixture.destroy();
    });
  });

  describe('errores de acción (409)', () => {
    it('un 409 en push muestra el mensaje y revierte el toggle', async () => {
      const fixture = await createPage(makeCamera('generic'), makeStatus('generic'));
      const component = fixture.componentInstance;
      pushError = {
        error: {
          success: false,
          error:
            'la cámara "cam1" es de ecosistema "generic": no admite controles remotos (solo datos del NVR)',
        },
      };
      component.togglePush();
      expect(component.pushEnabled()).toBe(true);
      expect(component.actionError()).toContain('no admite controles remotos');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.action-error')).toBeTruthy();
      fixture.destroy();
    });

    it('un éxito posterior limpia el error', async () => {
      const fixture = await createPage(makeCamera('generic'), makeStatus('generic'));
      const component = fixture.componentInstance;
      pushError = { error: { success: false, error: 'fallo' } };
      component.togglePush();
      expect(component.actionError()).toBe('fallo');
      pushError = null;
      component.togglePush();
      expect(component.actionError()).toBeNull();
      expect(component.pushEnabled()).toBe(false);
      fixture.destroy();
    });
  });
});
