import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'yi-login-page',
  standalone: true,
  template: `
    <div class="login-screen">
      <div class="login-card">
        <img class="login-icon" src="icons/icon.svg" alt="Yi NVR" />
        <h1>Yi NVR</h1>
        <p class="login-subtitle">Inicia sesión para continuar</p>
        <button class="login-btn" (click)="login()">Entrar</button>
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
