import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { VideoService } from './video.service';
import { Video } from '../models/video.model';

describe('VideoService', () => {
  let service: VideoService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(VideoService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  describe('getVideos', () => {
    it('pasa q, favorite y offset como query params cuando están definidos', () => {
      service.getVideos({ q: 'perro', favorite: 1, limit: 24, offset: 24 }).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos');
      expect(req.request.params.get('q')).toBe('perro');
      expect(req.request.params.get('favorite')).toBe('1');
      expect(req.request.params.get('limit')).toBe('24');
      expect(req.request.params.get('offset')).toBe('24');
      req.flush({ success: true, count: 0, data: [] });
    });

    it('pasa camera/startDate/endDate cuando están definidos', () => {
      service
        .getVideos({ camera: 'cam1', startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-08-07T23:59:59.999Z' })
        .subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos');
      expect(req.request.params.get('camera')).toBe('cam1');
      expect(req.request.params.get('startDate')).toBe('2026-08-01T00:00:00.000Z');
      expect(req.request.params.get('endDate')).toBe('2026-08-07T23:59:59.999Z');
      req.flush({ success: true, count: 0, data: [] });
    });

    it('no añade query params cuando no están definidos', () => {
      service.getVideos({}).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos');
      expect(req.request.params.keys()).toEqual([]);
      req.flush({ success: true, count: 0, data: [] });
    });
  });

  describe('countVideos', () => {
    it('GET /api/videos/count con params', () => {
      service.countVideos({ q: 'perro', favorite: 1 }).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/count');
      expect(req.request.method).toBe('GET');
      expect(req.request.params.get('q')).toBe('perro');
      expect(req.request.params.get('favorite')).toBe('1');
      req.flush({ success: true, count: 5 });
    });

    it('GET /api/videos/count sin params', () => {
      service.countVideos({}).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/count');
      expect(req.request.params.keys()).toEqual([]);
      req.flush({ success: true, count: 0 });
    });
  });

  describe('renameVideo', () => {
    it('PATCH /api/videos/:id con body {name}', () => {
      service.renameVideo(12, 'nuevo nombre').subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/12' && r.method === 'PATCH');
      expect(req.request.body).toEqual({ name: 'nuevo nombre' });
      const video: Video = {
        id: 12,
        name: 'nuevo nombre',
        camera_name: 'cam1',
        timestamp: '2026-08-20T10:00:00Z',
        original_path: '',
        thumbnail_path: '',
        preview_path: '',
        duration: 60,
        file_size: 1024,
        favorite: false,
        original_url: '',
        thumbnail_url: '',
        preview_url: '',
      };
      req.flush({ success: true, video });
    });

    it('envía name null para limpiar el nombre', () => {
      service.renameVideo(12, null).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/12' && r.method === 'PATCH');
      expect(req.request.body).toEqual({ name: null });
      req.flush({ success: true, video: {} as Video });
    });
  });

  describe('purgeVideos', () => {
    it('POST /api/videos/purge con scope range (from/to)', () => {
      const body = { scope: 'range' as const, from: '2026-08-01T00:00:00.000Z', to: '2026-08-07T23:59:59.999Z' };
      service.purgeVideos(body).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/purge' && r.method === 'POST');
      expect(req.request.body).toEqual(body);
      req.flush({ success: true, expected: 3, purged: ['a', 'b', 'c'], failed: [] });
    });

    it('POST /api/videos/purge con scope simple (sin from/to)', () => {
      service.purgeVideos({ scope: 'week' }).subscribe();
      const req = http.expectOne((r) => r.url === '/api/videos/purge' && r.method === 'POST');
      expect(req.request.body).toEqual({ scope: 'week' });
      req.flush({ success: true, expected: 0, purged: [], failed: [] });
    });
  });
});
