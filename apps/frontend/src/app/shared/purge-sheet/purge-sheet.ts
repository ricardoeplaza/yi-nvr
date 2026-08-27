import { Component, input, output } from '@angular/core';

export type PurgeScope = 'day' | 'week' | 'month' | 'all';

@Component({
  selector: 'yi-purge-sheet',
  templateUrl: './purge-sheet.html',
  styleUrl: './purge-sheet.scss',
})
export class PurgeSheet {
  /* ---------- inputs ---------- */
  readonly open = input(false);
  readonly scope = input<PurgeScope>('month');
  // Clips que se eliminarían con el alcance actual (null = cargando).
  readonly expected = input<number | null>(null);
  readonly purging = input(false);
  readonly usedLabel = input('');
  readonly storageCount = input<number | null>(null);

  /* ---------- outputs ---------- */
  readonly scopeChange = output<PurgeScope>();
  readonly purge = output<void>();
  readonly close = output<void>();
}
