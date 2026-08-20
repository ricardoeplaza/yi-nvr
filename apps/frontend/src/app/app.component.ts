import { Component, inject, signal } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';

@Component({
  selector: 'yi-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <main class="app-main">
      <router-outlet />
    </main>
    @if (showTabs()) {
      <nav class="tab-bar">
        <a class="tab" routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{exact: true}">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2" fill="currentColor" opacity=".15"/><path d="M2 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m20 9 2-1.3v8.6L20 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          <span class="tab-label">Inicio</span>
        </a>
        <a class="tab" routerLink="/cameras" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h1.2l.9-1.6A1 1 0 0 1 9 4h6a1 1 0 0 1 .9.6L16.8 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3.3"/></svg>
          <span class="tab-label">Cámaras</span>
        </a>
        <a class="tab" routerLink="/videos" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>
          <span class="tab-label">Galería</span>
        </a>
        <a class="tab" routerLink="/settings" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>
          <span class="tab-label">Ajustes</span>
        </a>
      </nav>
    }
  `,
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private router = inject(Router);
  showTabs = signal(true);

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.showTabs.set(event.urlAfterRedirects !== '/login');
      }
    });
  }
}
