import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Camera } from '../models/camera.model';

export interface CommandResult {
  success: boolean;
  published: boolean;
  payload: any;
}

@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly http = inject(HttpClient);

  getCameras(): Observable<{ success: boolean; count: number; data: Camera[] }> {
    return this.http.get<{ success: boolean; count: number; data: Camera[] }>('/api/cameras');
  }

  setPower(cameraId: string, enabled: boolean): Observable<CommandResult> {
    return this.http.post<CommandResult>(`/api/cameras/${cameraId}/power`, { enabled });
  }

  setLed(cameraId: string, enabled: boolean): Observable<CommandResult> {
    return this.http.post<CommandResult>(`/api/cameras/${cameraId}/led`, { enabled });
  }

  setNightVision(cameraId: string, enabled: boolean): Observable<CommandResult> {
    return this.http.post<CommandResult>(`/api/cameras/${cameraId}/night-vision`, { enabled });
  }

  setRecMode(cameraId: string, mode: 'motion' | 'off'): Observable<CommandResult> {
    return this.http.post<CommandResult>(`/api/cameras/${cameraId}/rec-mode`, { mode });
  }

  setGroupPower(cameraIds: string[], enabled: boolean): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>('/api/cameras/group/power', {
      cameraIds,
      enabled,
    });
  }

  reloadCamera(cameraId: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`/api/cameras/${cameraId}/reload`, {});
  }
}
