import { Component, inject, OnInit, signal } from '@angular/core';
import { TimelineService } from '../../services/timeline.service';
import { TimelineDay } from '../../models/timeline.model';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';

@Component({
  selector: 'yi-timeline-page',
  standalone: true,
  imports: [EmptyStateComponent],
  template: `
    <div class="timeline-page">
      <header class="tl-header">
        <h1>Línea de tiempo</h1>
      </header>

      @if (loading()) {
        <div class="loading">Cargando…</div>
      } @else if (days().length) {
        <div class="day-list">
          @for (day of days(); track day.date) {
            <div class="day-card">
              <div class="day-header">
                <span class="day-label">{{ formatDayLabel(day.date) }}</span>
                <span class="day-total">{{ day.total }} video{{ day.total !== 1 ? 's' : '' }}</span>
              </div>
              @if (day.total > 0) {
                <div class="cam-breakdown">
                  @for (camName of camNames(day); track camName) {
                    <div class="cam-row">
                      <span class="cam-name">{{ camName }}</span>
                      <span class="cam-count">{{ day.cameras[camName] }}</span>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      } @else {
        <yi-empty-state icon="📅" title="Sin actividad" subtitle="Aún no hay grabaciones registradas" />
      }
    </div>
  `,
  styleUrl: './timeline.page.scss'
})
export class TimelinePage implements OnInit {
  private timelineService = inject(TimelineService);

  days = signal<TimelineDay[]>([]);
  loading = signal(true);

  ngOnInit() {
    this.timelineService.getTimeline().subscribe({
      next: (res) => {
        this.days.set(res.data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  camNames(day: TimelineDay): string[] {
    return Object.keys(day.cameras);
  }

  formatDayLabel(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const isToday = date.toDateString() === today.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();

    if (isToday) return 'Hoy';
    if (isYesterday) return 'Ayer';
    return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
}
