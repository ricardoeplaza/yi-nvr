import { Component, input } from '@angular/core';
import { TranslatePipe } from '../i18n/translate.pipe';

@Component({
  selector: 'yi-empty-state',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div class="empty-state">
      <div class="empty-icon">{{ icon() }}</div>
      <div class="empty-title">{{ title() ?? ('common.empty.title' | t) }}</div>
      @if (subtitle()) {
        <div class="empty-subtitle">{{ subtitle() }}</div>
      }
    </div>
  `,
  styleUrl: './empty-state.scss'
})
export class EmptyState {
  icon = input('📹');
  title = input<string | null>(null);
  subtitle = input('');
}
