import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Video } from '../models/video.model';

@Injectable({ providedIn: 'root' })
export class VideoService {
  private readonly http = inject(HttpClient);

  getVideos(params: {
    camera?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Observable<{ success: boolean; count: number; data: Video[] }> {
    let httpParams = new HttpParams();
    if (params.camera !== undefined) httpParams = httpParams.set('camera', params.camera);
    if (params.startDate !== undefined) httpParams = httpParams.set('startDate', params.startDate);
    if (params.endDate !== undefined) httpParams = httpParams.set('endDate', params.endDate);
    if (params.limit !== undefined) httpParams = httpParams.set('limit', params.limit.toString());
    return this.http.get<{ success: boolean; count: number; data: Video[] }>('/api/videos', {
      params: httpParams,
    });
  }

  getVideo(id: number): Observable<{ success: boolean; data: Video }> {
    return this.http.get<{ success: boolean; data: Video }>(`/api/videos/${id}`);
  }

  setFavorite(id: number, favorite: boolean): Observable<{ success: boolean; favorite: boolean }> {
    return this.http.post<{ success: boolean; favorite: boolean }>(`/api/videos/${id}/favorite`, { favorite });
  }

  deleteVideo(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`/api/videos/${id}`);
  }
}
