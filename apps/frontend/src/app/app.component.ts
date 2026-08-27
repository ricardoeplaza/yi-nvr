import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppFooter } from './shared/app-footer/app-footer';

@Component({
  selector: 'yi-root',
  standalone: true,
  imports: [RouterOutlet, AppFooter],
  template: `
    <main class="app-main">
      <router-outlet />
    </main>
    <yi-app-footer />
  `,
  styleUrl: './app.component.scss'
})
export class AppComponent {}
