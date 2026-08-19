import { Component, input } from '@angular/core';

@Component({
  selector: 'yi-empty-state',
  standalone: true,
  template: `
    <div class="empty-state">
      <div class="empty-icon">{{ icon() }}</div>
      <div class="empty-title">{{ title() }}</div>
      @if (subtitle()) {
        <div class="empty-subtitle">{{ subtitle() }}</div>
      }
    </div>
  `,
  styleUrl: './empty-state.component.scss'
})
export class EmptyStateComponent {
  icon = input('📹');
  title = input('Sin contenido');
  subtitle = input('');
}
