import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

/**
 * Navegación por niveles: el footer (tabs) vive en el nivel 0 y cada
 * `routerLink`/`navigate` normal lo profundiza; el back (gesto o flecha)
 * lo reduce. Cambiar de tab reinicia la pila de historial al nivel 0 para
 * que el gesto "atrás" en nivel 0 salga de la app sin recorrer páginas.
 */
@Injectable({ providedIn: 'root' })
export class AppNavService {
  private router = inject(Router);

  /** Niveles de profundidad sobre la raíz de tabs (0 = nivel 0). */
  private depth = 0;

  /** Tab pendiente mientras se rebobina el historial. */
  private pendingTab: string | null = null;

  private unwinding = false;

  constructor() {
    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      const nav = this.router.getCurrentNavigation();
      if (nav?.trigger === 'popstate') {
        this.depth = Math.max(0, this.depth - 1);
      } else if (nav?.trigger === 'imperative' && !nav.extras.replaceUrl) {
        this.depth++;
      }
      if (this.pendingTab !== null) {
        // El rebobinado llegó a la raíz: sustituir la entrada base por la tab.
        if (this.depth === 0) {
          const url = this.pendingTab;
          this.pendingTab = null;
          this.router.navigateByUrl(url, { replaceUrl: true });
        }
      } else if (this.unwinding) {
        this.setUnwinding(false);
      }
    });
  }

  /** Navegación por tab: deja la pila de historial en nivel 0. */
  goToTab(url: string) {
    if ((this.router.url || '/') === url) return;
    if (this.depth > 0) {
      this.pendingTab = url;
      this.setUnwinding(true);
      window.history.go(-this.depth);
      // Fallback por si el rebobinado no termina (p. ej. historial desincronizado).
      window.setTimeout(() => {
        if (this.pendingTab !== null) {
          this.pendingTab = null;
          this.depth = 0;
          this.router.navigateByUrl(url, { replaceUrl: true });
        }
      }, 400);
    } else {
      this.router.navigateByUrl(url, { replaceUrl: true });
    }
  }

  /**
   * Flecha de volver: sube un nivel si hay historial propio de la app;
   * si no (p. ej. recarga directa en una URL profunda), va al nivel padre.
   */
  goBack(fallback: string[]) {
    if (this.depth > 0) {
      window.history.back();
    } else {
      this.router.navigate(fallback, { replaceUrl: true });
    }
  }

  private setUnwinding(value: boolean) {
    this.unwinding = value;
    document.body.classList.toggle('app-nav-unwind', value);
  }
}
