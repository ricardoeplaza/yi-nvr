import { Component, inject, input } from '@angular/core';
import { AppNavService } from '../app-nav/app-nav.service';

@Component({
  selector: 'yi-app-header',
  standalone: true,
  template: `
    <header class="app-header">
      <div class="app-header-row">
        @if (backTo()) {
          <button type="button" class="app-header-back" (click)="onBack()" aria-label="Volver">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
          </button>
        }
        <h1 class="app-header-title">{{ title() }}</h1>
        <div class="app-header-end">
          <ng-content select="[appHeaderEnd]" />
        </div>
      </div>
      <ng-content />
    </header>
  `,
  styleUrl: './app-header.scss'
})
export class AppHeader {
  readonly title = input.required<string>();
  // Ruta del nivel padre; si se omite no se muestra la flecha de volver.
  readonly backTo = input<string[] | null>(null);

  private nav = inject(AppNavService);

  onBack() {
    const target = this.backTo();
    if (target) this.nav.goBack(target);
  }
}
