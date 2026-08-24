import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { StorageInfo, StorageDirFiles, StorageFtpConfig, StorageFtpUpdate, StoragePurgeRequest, StoragePurgeResult } from '../models/storage.model';

// Endpoints de la gestión de almacenamiento (SD) de una cámara yi-hack.
// Ver cabecera de apps/api/src/routes/storage.js (contrato completo).
@Injectable({ providedIn: 'root' })
export class StorageService {
  private readonly http = inject(HttpClient);

  getStorage(cameraId: string): Observable<{ success: boolean; data: StorageInfo }> {
    return this.http.get<{ success: boolean; data: StorageInfo }>(`/api/cameras/${cameraId}/storage`);
  }

  deleteDir(cameraId: string, dir: string): Observable<{ success: boolean; deleted: string }> {
    return this.http.delete<{ success: boolean; deleted: string }>(`/api/cameras/${cameraId}/storage/dirs`, { body: { dir } });
  }

  deleteFile(cameraId: string, file: string): Observable<{ success: boolean; deleted: string }> {
    return this.http.delete<{ success: boolean; deleted: string }>(`/api/cameras/${cameraId}/storage/files`, { body: { file } });
  }

  getDirFiles(cameraId: string, dir: string): Observable<{ success: boolean; data: StorageDirFiles }> {
    return this.http.get<{ success: boolean; data: StorageDirFiles }>(`/api/cameras/${cameraId}/storage/dirs/${dir}/files`);
  }

  purge(cameraId: string, req: StoragePurgeRequest): Observable<StoragePurgeResult> {
    return this.http.post<StoragePurgeResult>(`/api/cameras/${cameraId}/storage/purge`, req);
  }

  getFtpConfig(cameraId: string): Observable<{ success: boolean; data: StorageFtpConfig }> {
    return this.http.get<{ success: boolean; data: StorageFtpConfig }>(`/api/cameras/${cameraId}/storage/ftp`);
  }

  saveFtpConfig(cameraId: string, update: StorageFtpUpdate): Observable<{ success: boolean; requires_reboot: boolean }> {
    return this.http.post<{ success: boolean; requires_reboot: boolean }>(`/api/cameras/${cameraId}/storage/ftp`, update);
  }
}
