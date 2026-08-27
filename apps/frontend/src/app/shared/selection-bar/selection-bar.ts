import { Component, input, output } from '@angular/core';

@Component({
  selector: 'yi-selection-bar',
  templateUrl: './selection-bar.html',
  styleUrl: './selection-bar.scss',
})
export class SelectionBar {
  /* ---------- inputs ---------- */
  readonly show = input(false);
  readonly count = input(0);

  /* ---------- outputs ---------- */
  readonly favorite = output<void>();
  readonly remove = output<void>();
}
