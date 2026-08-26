import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Timeline } from './timeline';
import type { Video } from '../../models/video.model';

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
