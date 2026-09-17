import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '../../shared/i18n/translate.pipe';

@Component({
  selector: 'yi-login-page',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    <div class="login-screen">
      <div class="login-card">
        <img class="login-icon" src="icons/icon.svg" alt="Yi NVR" />
        <h1>Yi NVR</h1>
        <p class="login-subtitle">{{ 'login.subtitle' | t }}</p>
        <button class="login-btn" (click)="login()">{{ 'login.signIn' | t }}</button>
      </div>
    </div>
  `,
  styleUrl: './login.page.scss'
})
export class LoginPage {
  private router = inject(Router);

  login() {
    localStorage.setItem('yi-nvr-auth', 'true');
    // replace: /login no queda en el historial (back desde / sale de la app).
    this.router.navigate(['/'], { replaceUrl: true });
  }
}
