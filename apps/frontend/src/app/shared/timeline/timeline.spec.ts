import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Timeline } from './timeline';
import type { Video } from '../../models/video.model';
import { I18nService } from '../i18n/i18n.service';
import { I18N_KEYS } from '../../../i18n/keys';

// Stub en español: las aserciones de este spec esperan el texto en español.
const i18nStub = {
  lang: 'es' as const,
  t: (key: string, params?: Record<string, string | number>) =>
    String(I18N_KEYS[key as keyof typeof I18N_KEYS]).replace(
      /\{\{(\w+)\}\}/g,
      (_m, name: string) => String(params?.[name] ?? ''),
    ),
  translateApiError: (err: unknown) => {
    const e = err as { error?: { error?: string }; message?: string } | null;
    return e?.error?.error || e?.message || 'Error desconocido';
  },
};

describe('Timeline', () => {
  let component: Timeline;
  let fixture: ComponentFixture<Timeline>;

  const video: Video = {
    id: 1,
    name: null,
    camera_name: 'cam1',
    timestamp: new Date().toISOString(),
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

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Timeline],
      providers: [{ provide: I18nService, useValue: i18nStub }],
    }).compileComponents();

    fixture = TestBed.createComponent(Timeline);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('videos', [video]);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
