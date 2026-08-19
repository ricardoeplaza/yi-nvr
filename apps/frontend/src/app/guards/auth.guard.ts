import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const isAuthenticated = localStorage.getItem('yi-nvr-auth') === 'true';
  if (!isAuthenticated) {
    return router.createUrlTree(['/login']);
  }
  return true;
};
