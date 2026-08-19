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
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{exact: true}">
          <span class="tab-icon">🏠</span>
          <span class="tab-label">Inicio</span>
        </a>
        <a routerLink="/videos" routerLinkActive="active">
          <span class="tab-icon">🎬</span>
          <span class="tab-label">Galería</span>
        </a>
        <a routerLink="/settings" routerLinkActive="active">
          <span class="tab-icon">⚙️</span>
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
