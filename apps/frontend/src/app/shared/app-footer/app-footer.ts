import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { AppNavService } from '../app-nav/app-nav.service';

@Component({
  selector: 'yi-app-footer',
  standalone: true,
  template: `
    @if (visible()) {
      <nav class="tab-bar" aria-label="Secciones">
        <button type="button" class="tab" [class.active]="activeTab() === 'home'" [attr.aria-current]="activeTab() === 'home' ? 'page' : null" (click)="goTo('/')">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2" fill="currentColor" opacity=".15"/><path d="M2 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m20 9 2-1.3v8.6L20 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          <span class="tab-label">Inicio</span>
        </button>
        <button type="button" class="tab" [class.active]="activeTab() === 'cameras'" [attr.aria-current]="activeTab() === 'cameras' ? 'page' : null" (click)="goTo('/cameras')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h1.2l.9-1.6A1 1 0 0 1 9 4h6a1 1 0 0 1 .9.6L16.8 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3.3"/></svg>
          <span class="tab-label">Cámaras</span>
        </button>
        <button type="button" class="tab" [class.active]="activeTab() === 'videos'" [attr.aria-current]="activeTab() === 'videos' ? 'page' : null" (click)="goTo('/videos')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>
          <span class="tab-label">Galería</span>
        </button>
        <button type="button" class="tab" [class.active]="activeTab() === 'settings'" [attr.aria-current]="activeTab() === 'settings' ? 'page' : null" (click)="goTo('/settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          <span class="tab-label">Ajustes</span>
        </button>
      </nav>
    }
  `,
  styleUrl: './app-footer.scss'
})
export class AppFooter {
  private router = inject(Router);
  private nav = inject(AppNavService);

  readonly url = signal('');

  readonly visible = computed(() => this.url() !== '/login');

  // Los niveles profundos de cámaras pertenecen a la rama de su tab.
  readonly activeTab = computed(() => {
    const url = this.url();
    if (url.startsWith('/cameras')) return 'cameras';
    if (url.startsWith('/videos')) return 'videos';
    if (url === '/settings') return 'settings';
    return 'home';
  });

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.url.set(event.urlAfterRedirects || '/');
      }
    });
  }

  goTo(path: string) {
    this.nav.goToTab(path);
  }
}
