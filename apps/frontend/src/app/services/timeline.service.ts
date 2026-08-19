import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { TimelineDay } from '../models/timeline.model';

@Injectable({ providedIn: 'root' })
export class TimelineService {
  private readonly http = inject(HttpClient);

  getTimeline(): Observable<{ success: boolean; data: TimelineDay[] }> {
    return this.http.get<{ success: boolean; data: TimelineDay[] }>('/api/timeline');
  }
}
