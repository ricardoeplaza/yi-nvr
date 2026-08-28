import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Camera, CameraStatus } from '../models/camera.model';

export interface CommandResult {
  success: boolean;
  applied: boolean;
  key: string;
  value: string;
}

@Injectable({ providedIn: 'root' })
export class CameraService {
  private readonly http = inject(HttpClient);

  getCameras(): Observable<{ success: boolean; count: number; data: Camera[] }> {
    return this.http.get<{ success: boolean; count: number; data: Camera[] }>('/api/cameras');
  }

  getCamerasStatus(): Observable<{ success: boolean; count: number; data: Camera[] }> {
    return this.http.get<{ success: boolean; count: number; data: Camera[] }>('/api/cameras/status');
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

  getCameraStatus(cameraId: string): Observable<{ success: boolean; data: CameraStatus }> {
    return this.http.get<{ success: boolean; data: CameraStatus }>(`/api/cameras/${cameraId}/status`);
  }

  rebootCamera(cameraId: string): Observable<{ success: boolean; rebooted: boolean }> {
    return this.http.post<{ success: boolean; rebooted: boolean }>(`/api/cameras/${cameraId}/reboot`, {});
  }

  setPush(cameraId: string, enabled: boolean): Observable<{ success: boolean; push_enabled: boolean }> {
    return this.http.post<{ success: boolean; push_enabled: boolean }>(`/api/cameras/${cameraId}/push`, { enabled });
  }

  setSdRecording(cameraId: string, enabled: boolean): Observable<{ success: boolean; rec_without_cloud: string; applied: string }> {
    return this.http.post<{ success: boolean; rec_without_cloud: string; applied: string }>(`/api/cameras/${cameraId}/sd-recording`, { enabled });
  }
}
