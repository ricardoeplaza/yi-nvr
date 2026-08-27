import { Component, inject } from '@angular/core';
import { ToastService } from './toast.service';

@Component({
  selector: 'yi-toast',
  template: `
    <div class="toast"
         [class.show]="state() !== null"
         [class.success]="type() === 'success'"
         [class.error]="type() === 'error'"
         [class.info]="type() === 'info'">
      @if (type() === 'success') {
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      } @else if (type() === 'error') {
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      } @else {
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 12v4"/></svg>
      }
      <span class="toast-message">{{ message() }}</span>
    </div>
  `,
  styleUrl: './toast.component.scss',
})
export class ToastComponent {
  private readonly service = inject(ToastService);

  protected readonly state = this.service.state;
  protected readonly message = () => this.state()?.message ?? '';
  protected readonly type = () => this.state()?.type ?? 'info';
}
