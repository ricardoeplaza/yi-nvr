import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '../i18n/translate.pipe';

@Component({
  selector: 'yi-selection-bar',
  standalone: true,
  templateUrl: './selection-bar.html',
  styleUrl: './selection-bar.scss',
  imports: [TranslatePipe],
})
export class SelectionBar {
  /* ---------- inputs ---------- */
  readonly show = input(false);
  readonly count = input(0);

  /* ---------- outputs ---------- */
  readonly favorite = output<void>();
  readonly remove = output<void>();
}
