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
    q?: string;
    favorite?: 0 | 1;
    limit?: number;
    offset?: number;
  }): Observable<{ success: boolean; count: number; data: Video[] }> {
    let httpParams = new HttpParams();
    if (params.camera !== undefined) httpParams = httpParams.set('camera', params.camera);
    if (params.startDate !== undefined) httpParams = httpParams.set('startDate', params.startDate);
    if (params.endDate !== undefined) httpParams = httpParams.set('endDate', params.endDate);
    if (params.q !== undefined) httpParams = httpParams.set('q', params.q);
    if (params.favorite !== undefined)
      httpParams = httpParams.set('favorite', params.favorite.toString());
    if (params.limit !== undefined) httpParams = httpParams.set('limit', params.limit.toString());
    if (params.offset !== undefined)
      httpParams = httpParams.set('offset', params.offset.toString());
    return this.http.get<{ success: boolean; count: number; data: Video[] }>('/api/videos', {
      params: httpParams,
    });
  }

  countVideos(params: {
    camera?: string;
    startDate?: string;
    endDate?: string;
    q?: string;
    favorite?: 0 | 1;
  }): Observable<{ success: boolean; count: number }> {
    let httpParams = new HttpParams();
    if (params.camera !== undefined) httpParams = httpParams.set('camera', params.camera);
    if (params.startDate !== undefined) httpParams = httpParams.set('startDate', params.startDate);
    if (params.endDate !== undefined) httpParams = httpParams.set('endDate', params.endDate);
    if (params.q !== undefined) httpParams = httpParams.set('q', params.q);
    if (params.favorite !== undefined)
      httpParams = httpParams.set('favorite', params.favorite.toString());
    return this.http.get<{ success: boolean; count: number }>('/api/videos/count', {
      params: httpParams,
    });
  }

  renameVideo(id: number, name: string | null): Observable<{ success: boolean; video: Video }> {
    return this.http.patch<{ success: boolean; video: Video }>(`/api/videos/${id}`, { name });
  }

  purgeVideos(req: {
    scope: 'day' | 'week' | 'month' | 'range' | 'all';
    from?: string;
    to?: string;
  }): Observable<{ success: boolean; expected: number; purged: string[]; failed: string[] }> {
    return this.http.post<{
      success: boolean;
      expected: number;
      purged: string[];
      failed: string[];
    }>('/api/videos/purge', req);
  }

  getVideo(id: number): Observable<{ success: boolean; data: Video }> {
    return this.http.get<{ success: boolean; data: Video }>(`/api/videos/${id}`);
  }

  setFavorite(id: number, favorite: boolean): Observable<{ success: boolean; favorite: boolean }> {
    return this.http.post<{ success: boolean; favorite: boolean }>(`/api/videos/${id}/favorite`, {
      favorite,
    });
  }

  deleteVideo(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(`/api/videos/${id}`);
  }

  // El API devuelve los ids como string (ver routes/videos.js).
  bulkDelete(ids: number[]): Observable<{ success: boolean; deleted: string[]; failed: string[] }> {
    return this.http.post<{ success: boolean; deleted: string[]; failed: string[] }>(
      '/api/videos/bulk-delete',
      {
        ids,
      },
    );
  }

  bulkFavorite(
    ids: number[],
    favorite: boolean,
  ): Observable<{ success: boolean; updated: string[]; failed: string[] }> {
    return this.http.post<{ success: boolean; updated: string[]; failed: string[] }>(
      '/api/videos/bulk-favorite',
      {
        ids,
        favorite,
      },
    );
  }
}
