import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Cameras } from './cameras';
import { CameraService } from '../../services/camera.service';

describe('Cameras', () => {
  let component: Cameras;
  let fixture: ComponentFixture<Cameras>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Cameras],
      providers: [
        {
          provide: CameraService,
          useValue: { getCameras: () => of({ success: true, count: 0, data: [] }) }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(Cameras);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
