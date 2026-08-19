import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'yi-login-page',
  standalone: true,
  template: `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-icon">📹</div>
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
    this.router.navigate(['/']);
  }
}
