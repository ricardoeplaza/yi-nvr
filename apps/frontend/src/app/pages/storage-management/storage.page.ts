import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CameraService } from '../../services/camera.service';
import { StorageService } from '../../services/storage.service';
import { Camera, CameraSd } from '../../models/camera.model';
import { StorageDirFile, StorageFtpSuggested, StorageFtpUpdate, StoragePurgeRequest } from '../../models/storage.model';

// Directorio de eventos yi-hack: 14 chars "YYYY Y MM M DD D HH H".
// Se interpreta como hora local de la cámara (mismo criterio que el API:
// Date.UTC de los dígitos, ver dirNameToDate en storage.js).
interface DirItem {
  name: string;
  y: number | null;
  mo: number | null;
  d: number | null;
  h: number | null;
  ts: number | null;
}

const DIR_RE = /^\d{4}Y\d{2}M\d{2}D\d{2}H$/;

function parseDir(name: string): DirItem {
  if (!DIR_RE.test(name)) {
    return { name, y: null, mo: null, d: null, h: null, ts: null };
  }
  const y = parseInt(name.slice(0, 4), 10);
  const mo = parseInt(name.slice(5, 7), 10);
  const d = parseInt(name.slice(8, 10), 10);
  const h = parseInt(name.slice(11, 13), 10);
  const ts = Date.UTC(y, mo - 1, d, h);
  return { name, y, mo, d, h, ts: isNaN(ts) ? null : ts };
}

type PurgeScope = 'day' | 'week' | 'month';

const SCOPE_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000
};

const SCOPE_LABEL: Record<string, string> = {
  day: 'de más de un día',
  week: 'de más de 1 semana',
  month: 'de más de 30 días'
};

interface PurgeOutcome {
  expected: number;
  purged: string[];
  failed: number;
}

@Component({
  selector: 'yi-storage-page',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="storage-page">
      <header class="storage-header">
        <a class="back-link" [routerLink]="['/cameras', cameraId]">← Volver</a>
        <h1>Almacenamiento</h1>
        @if (camera()) {
          <span class="cam-name">{{ camera()!.name }}</span>
        }
      </header>

      @if (loading()) {
        <div class="state-box">Cargando…</div>
      } @else if (loadError()) {
        <div class="state-box error">
          <p>{{ loadError() }}</p>
          <button class="btn" (click)="loadStorage()">Reintentar</button>
        </div>
      } @else {
        <div class="storage-body">
        <section class="section">
          <div class="section-head">
            <h2>Grabación cloud (FTP)</h2>
            <button class="ghost-btn" (click)="ftpOpen.set(!ftpOpen())" [attr.aria-expanded]="ftpOpen()">
              {{ ftpOpen() ? 'Ocultar' : 'Mostrar' }}
            </button>
          </div>
          @if (ftpLoading()) {
            <p class="muted">Cargando configuración…</p>
          } @else if (ftpError()) {
            <div class="inline-error">{{ ftpError() }}
              <button class="link-btn" (click)="loadFtp()">Reintentar</button>
            </div>
          } @else if (!ftpOpen()) {
            <p class="ftp-summary">
              {{ ftpUpload() ? 'Activada' : 'Desactivada' }}
            </p>
            @if (!ftpInSync()) {
              <div class="ftp-warning">
                Configuración incorrecta: el push FTP no está configurado contra el NVR
              </div>
            }
          } @else {
            <div class="ftp-form">
              <label class="switch-row">
                <span class="field-label">Subir eventos a FTP</span>
                <input type="checkbox" [checked]="ftpUpload()" (change)="onFtpUploadChange($event)" />
              </label>

              <div class="ftp-fixed">
                <p class="fixed-label">Configurado por el NVR (solo lectura)</p>

                <div class="field">
                  <label class="field-label" for="ftp-host">Servidor (host)</label>
                  <input id="ftp-host" type="text" [value]="ftpSuggested()?.FTP_HOST || ''" readonly />
                </div>

                <div class="field">
                  <label class="field-label" for="ftp-dir">Carpeta de destino</label>
                  <input id="ftp-dir" type="text" [value]="ftpSuggested()?.FTP_DIR || ''" readonly />
                </div>

                <div class="field">
                  <label class="field-label" for="ftp-user">Usuario</label>
                  <input id="ftp-user" type="text" [value]="ftpSuggested()?.FTP_USERNAME || ''" readonly />
                </div>

                <div class="field">
                  <label class="field-label" for="ftp-pass">Contraseña</label>
                  <div class="pw-row">
                    <input id="ftp-pass" [type]="showPassword() ? 'text' : 'password'" [value]="ftpSuggested()?.FTP_PASSWORD || ''" readonly />
                    <button type="button" class="ghost-btn" (click)="showPassword.set(!showPassword())">
                      {{ showPassword() ? 'Ocultar' : 'Mostrar' }}
                    </button>
                  </div>
                </div>
              </div>

              @if (!ftpInSync()) {
                <div class="out-of-sync">
                  Configuración incorrecta: el push FTP no está configurado contra el
                  NVR (los valores actuales de la cámara difieren de los derivados).
                  Pulsa «Guardar» para aplicarlos.
                </div>
              }

              <label class="switch-row">
                <span class="field-label">Carpeta con árbol de fechas</span>
                <input type="checkbox" [checked]="ftpDirTree()" (change)="onFtpDirTreeChange($event)" />
              </label>

              <label class="switch-row">
                <span class="field-label">Borrar de la SD tras subir</span>
                <input type="checkbox" [checked]="ftpDeleteAfter()" (change)="onFtpDeleteAfterChange($event)" />
              </label>

              @if (ftpSaved()) {
                <p class="saved-ok">{{ ftpSaved() }}</p>
              }
              @if (ftpRebootNotice()) {
                <div class="reboot-notice">
                  <p>El cambio de subida FTP requiere reiniciar la cámara para aplicarse.</p>
                  @if (rebootMsg()) {
                    <p class="saved-ok">{{ rebootMsg() }}</p>
                  } @else {
                    <button class="btn" (click)="rebootCamera()">Reiniciar cámara</button>
                  }
                </div>
              }
              @if (rebootError()) {
                <p class="inline-error">{{ rebootError() }}</p>
              }

              <button class="btn primary" [disabled]="ftpSaving()" (click)="saveFtp()">
                {{ ftpSaving() ? 'Guardando…' : 'Guardar' }}
              </button>
            </div>
          }
        </section>

        <section class="section files-top">
          <div class="section-head">
            <h2>Ficheros de la tarjeta</h2>
            <button class="ghost-btn" (click)="loadStorage()">Actualizar</button>
          </div>

          <div class="purge-box">
            <h3>Borrar ficheros</h3>
            <div class="purge-controls">
              <select [value]="purgeScope()" (change)="onScopeChange($event)" aria-label="Alcance del borrado">
                <option value="day">De más de un día</option>
                <option value="week">De más de 1 semana</option>
                <option value="month">De más de 30 días</option>
              </select>
              <button class="danger-btn" [disabled]="purging()" (click)="onPurge()">
                {{ purging() ? 'Borrando…' : 'Borrar' }}
              </button>
            </div>

            @if (purgeError()) {
              <p class="inline-error">{{ purgeError() }}</p>
            }
            @if (purgeOutcome()) {
              <div class="purge-result" [class.partial]="purgeOutcome()!.failed > 0">
                @if (purgeOutcome()!.expected === 0) {
                  <p>No había directorios en ese alcance.</p>
                } @else {
                  <p>Borrados {{ purgeOutcome()!.purged.length }} de {{ purgeOutcome()!.expected }} directorios.</p>
                  @if (purgeOutcome()!.failed > 0) {
                    <p class="warn">{{ purgeOutcome()!.failed }} no pudieron borrarse.</p>
                  }
                }
              </div>
            }
          </div>
        </section>

        <div class="sd-panel">
          @if (sd()) {
            <div class="sd-box">
              <div class="sd-header">
                <span class="sd-label">Tarjeta SD</span>
                <span class="sd-value">{{ formatMb(sd()!.used_mb) }} / {{ formatMb(sd()!.total_mb) }} · {{ sd()!.free_pct }}% libre</span>
              </div>
              <div class="sd-bar">
                <div class="sd-fill" [style.width.%]="sdUsedPct()"></div>
              </div>
            </div>
          } @else {
            <p class="muted">Información de la SD no disponible.</p>
          }
        </div>

        <section class="section files-list">
          @if (dirError()) {
            <p class="inline-error">{{ dirError() }}</p>
          }

          @if (dirs().length) {
            <ul class="dir-list">
              @for (d of dirs(); track d.name) {
                <li class="dir-row" [class.open]="isDirOpen(d.name)" (click)="toggleDir(d.name)">
                  <span class="dir-chevron">{{ isDirOpen(d.name) ? '▾' : '▸' }}</span>
                  <span class="dir-date">{{ formatDirDate(d) }}</span>
                  <span class="dir-name">{{ d.name }}</span>
                  <button class="danger-ghost" [disabled]="deletingDir() === d.name"
                    (click)="$event.stopPropagation(); deleteDir(d.name)">
                    {{ deletingDir() === d.name ? 'Borrando…' : 'Borrar' }}
                  </button>
                </li>
                @if (isDirOpen(d.name)) {
                  <li class="dir-files">
                    @if (filesLoading() === d.name) {
                      <p class="muted">Cargando ficheros…</p>
                    } @else if (filesError() === d.name) {
                      <p class="inline-error">No se pudo cargar el listado de ficheros.
                        <button class="link-btn" (click)="loadDirFiles(d.name)">Reintentar</button>
                      </p>
                    } @else {
                      @for (f of filesOf(d.name); track f.filename) {
                        <div class="file-row">
                          <span class="file-time">{{ f.time }}</span>
                          <span class="file-name">{{ f.filename }}</span>
                          <button class="danger-ghost"
                            [disabled]="deletingFile() === d.name + '/' + f.filename"
                            (click)="deleteFile(d.name, f.filename)">
                            {{ deletingFile() === d.name + '/' + f.filename ? 'Borrando…' : 'Borrar' }}
                          </button>
                        </div>
                      } @empty {
                        <p class="muted">Sin ficheros de evento en este directorio.</p>
                      }
                    }
                  </li>
                }
              }
            </ul>
          } @else {
            <p class="muted">Sin directorios de eventos en la tarjeta.</p>
          }
        </section>
        </div>
      }
    </div>
  `,
  styleUrl: './storage.page.scss'
})
export class StoragePage implements OnInit {
  private route = inject(ActivatedRoute);
  private cameraService = inject(CameraService);
  private storageService = inject(StorageService);

  cameraId = '';
  camera = signal<Camera | null>(null);

  loading = signal(true);
  loadError = signal<string | null>(null);
  sd = signal<CameraSd | null>(null);
  dirs = signal<DirItem[]>([]);

  ftpLoading = signal(true);
  ftpError = signal<string | null>(null);
  ftpSaving = signal(false);
  ftpSaved = signal<string | null>(null);
  ftpRebootNotice = signal(false);
  rebootMsg = signal<string | null>(null);
  rebootError = signal<string | null>(null);

  // La sección FTP nace colapsada: el resumen (activada/desactivada) se ve
  // en la cabecera; el formulario solo se expande a demanda.
  ftpOpen = signal(false);
  ftpUpload = signal(false);
  // Campos fijos: los deriva el NVR (no editables desde la UI)
  ftpSuggested = signal<StorageFtpSuggested | null>(null);
  ftpInSync = signal(true);
  ftpDirTree = signal(false);
  ftpDeleteAfter = signal(false);
  showPassword = signal(false);

  // Directorio expandido (acordeón: uno a la vez) y sus ficheros
  openDir = signal<string | null>(null);
  filesByDir = signal<Record<string, StorageDirFile[]>>({});
  filesLoading = signal<string | null>(null);
  filesError = signal<string | null>(null);
  deletingFile = signal<string | null>(null);

  purgeScope = signal<PurgeScope>('day');
  purging = signal(false);
  purgeError = signal<string | null>(null);
  purgeOutcome = signal<PurgeOutcome | null>(null);

  deletingDir = signal<string | null>(null);
  dirError = signal<string | null>(null);

  ngOnInit() {
    this.cameraId = this.route.snapshot.paramMap.get('id') || '';
    this.loadCamera();
    this.loadStorage();
    this.loadFtp();
  }

  private loadCamera() {
    this.cameraService.getCameras().subscribe({
      next: (res) => {
        const cam = res.data.find(c => c.id === this.cameraId);
        this.camera.set(cam || null);
      },
      error: () => {}
    });
  }

  loadStorage() {
    this.loading.set(true);
    this.loadError.set(null);
    this.storageService.getStorage(this.cameraId).subscribe({
      next: (res) => {
        const list = (res.data.dirs || [])
          .map(parseDir)
          .sort((a, b) => (b.ts ?? -1) - (a.ts ?? -1));
        this.dirs.set(list);
        this.sd.set(res.data.sd);
        this.loading.set(false);
      },
      error: (err) => {
        this.loadError.set(this.extractError(err));
        this.loading.set(false);
      }
    });
  }

  loadFtp() {
    this.ftpLoading.set(true);
    this.ftpError.set(null);
    this.storageService.getFtpConfig(this.cameraId).subscribe({
      next: (res) => {
        const c = res.data;
        this.ftpUpload.set(c.FTP_UPLOAD === 'yes');
        this.ftpSuggested.set(c.suggested);
        this.ftpInSync.set(c.in_sync);
        this.ftpDirTree.set(c.FTP_DIR_TREE === 'yes');
        this.ftpDeleteAfter.set(c.FTP_FILE_DELETE_AFTER_UPLOAD === 'yes');
        this.ftpLoading.set(false);
      },
      error: (err) => {
        this.ftpError.set(this.extractError(err));
        this.ftpLoading.set(false);
      }
    });
  }

  onFtpUploadChange(e: Event) { this.ftpUpload.set((e.target as HTMLInputElement).checked); }
  onFtpDirTreeChange(e: Event) { this.ftpDirTree.set((e.target as HTMLInputElement).checked); }
  onFtpDeleteAfterChange(e: Event) { this.ftpDeleteAfter.set((e.target as HTMLInputElement).checked); }
  onScopeChange(e: Event) { this.purgeScope.set((e.target as HTMLSelectElement).value as PurgeScope); }

  saveFtp() {
    // Solo switches: los campos fijos (host/usuario/contraseña/carpeta) los
    // fuerza el backend con los valores derivados del NVR.
    const payload: StorageFtpUpdate = {
      FTP_UPLOAD: this.ftpUpload() ? 'yes' : 'no',
      FTP_DIR_TREE: this.ftpDirTree() ? 'yes' : 'no',
      FTP_FILE_DELETE_AFTER_UPLOAD: this.ftpDeleteAfter() ? 'yes' : 'no'
    };
    this.ftpSaving.set(true);
    this.ftpSaved.set(null);
    this.rebootError.set(null);
    this.storageService.saveFtpConfig(this.cameraId, payload).subscribe({
      next: (res) => {
        this.ftpSaving.set(false);
        this.ftpSaved.set('Configuración guardada.');
        this.ftpInSync.set(true);
        this.ftpRebootNotice.set(res.requires_reboot);
      },
      error: (err) => {
        this.ftpSaving.set(false);
        this.ftpError.set(this.extractError(err));
      }
    });
  }

  rebootCamera() {
    if (!window.confirm('¿Reiniciar la cámara? Perderás la conexión en unos segundos.')) {
      return;
    }
    this.rebootError.set(null);
    this.cameraService.rebootCamera(this.cameraId).subscribe({
      next: () => this.rebootMsg.set('Cámara reiniciando…'),
      error: (err) => this.rebootError.set(this.extractError(err))
    });
  }

  deleteDir(dir: string) {
    if (!window.confirm(`¿Borrar el directorio de eventos "${dir}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    this.deletingDir.set(dir);
    this.dirError.set(null);
    this.storageService.deleteDir(this.cameraId, dir).subscribe({
      next: () => {
        this.deletingDir.set(null);
        // Actualización local: el API ya invalidó su cache, no hace falta
        // re-pedir el listado (eventsdir.sh tarda ~12 s en la cámara)
        if (this.openDir() === dir) this.openDir.set(null);
        this.dirs.update(list => list.filter(x => x.name !== dir));
      },
      error: (err) => {
        this.deletingDir.set(null);
        this.dirError.set(this.extractError(err));
      }
    });
  }

  toggleDir(dir: string) {
    if (this.openDir() === dir) {
      this.openDir.set(null);
      return;
    }
    this.openDir.set(dir);
    this.loadDirFiles(dir);
  }

  isDirOpen(dir: string): boolean {
    return this.openDir() === dir;
  }

  filesOf(dir: string): StorageDirFile[] {
    return this.filesByDir()[dir] || [];
  }

  loadDirFiles(dir: string) {
    this.filesLoading.set(dir);
    this.filesError.set(null);
    this.storageService.getDirFiles(this.cameraId, dir).subscribe({
      next: (res) => {
        this.filesByDir.update(map => ({ ...map, [dir]: res.data.files }));
        this.filesLoading.set(null);
      },
      error: () => {
        this.filesLoading.set(null);
        this.filesError.set(dir);
      }
    });
  }

  deleteFile(dir: string, filename: string) {
    const file = `${dir}/${filename}`;
    if (!window.confirm(`¿Borrar el fichero "${file}"? Esta acción no se puede deshacer.`)) {
      return;
    }
    this.deletingFile.set(file);
    this.filesError.set(null);
    this.storageService.deleteFile(this.cameraId, file).subscribe({
      next: () => {
        this.deletingFile.set(null);
        this.loadDirFiles(dir);
      },
      error: () => {
        this.deletingFile.set(null);
        this.filesError.set(dir);
      }
    });
  }

  onPurge() {
    const scope = this.purgeScope();
    const ms = SCOPE_MS[scope];
    if (!window.confirm(`¿Borrar los eventos ${SCOPE_LABEL[scope]}? Esta acción no se puede deshacer.`)) {
      return;
    }
    // Retención: se borran los ficheros ANTERIORES a N días, nunca los
    // últimos N. En el contrato del API (range [from,to] inclusivo) eso es
    // from = época, to = ahora - N.
    this.doPurge({
      scope: 'range',
      from: new Date(0).toISOString(),
      to: new Date(Date.now() - ms).toISOString()
    });
  }

  private doPurge(req: StoragePurgeRequest) {
    this.purging.set(true);
    this.purgeError.set(null);
    this.purgeOutcome.set(null);
    const expected = this.expectedCount(req);
    this.storageService.purge(this.cameraId, req).subscribe({
      next: (res) => {
        this.purging.set(false);
        const purged = res.purged || [];
        this.purgeOutcome.set({ expected, purged, failed: Math.max(0, expected - purged.length) });
        // Actualización local (el API ya invalidó su cache): evita el
        // refetch de eventsdir.sh (~12 s en la cámara).
        if (purged.length) {
          const drop = new Set(purged);
          const open = this.openDir();
          if (open && drop.has(open)) this.openDir.set(null);
          this.dirs.update(list => list.filter(x => !drop.has(x.name)));
        }
      },
      error: (err) => {
        this.purging.set(false);
        this.purgeError.set(this.extractError(err));
      }
    });
  }

  // Cuántos directorios locales caen en el alcance pedido (mismo criterio de
  // fechas que el API: dígitos del nombre como hora UTC de referencia).
  private expectedCount(req: StoragePurgeRequest): number {
    const list = this.dirs();
    if (req.scope === 'range' && req.from && req.to) {
      const f = Date.parse(req.from);
      const t = Date.parse(req.to);
      return list.filter(x => x.ts !== null && x.ts >= f && x.ts <= t).length;
    }
    return 0;
  }

  sdUsedPct(): number {
    const sd = this.sd();
    return sd ? 100 - sd.free_pct : 0;
  }

  formatMb(mb: number): string {
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  }

  formatDirDate(d: DirItem): string {
    if (d.y === null || d.mo === null || d.d === null || d.h === null) return d.name;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.d)}/${p(d.mo)}/${d.y} · ${p(d.h)}:00 h`;
  }

  private extractError(err: unknown): string {
    const e = err as { error?: { error?: string }; message?: string };
    return e?.error?.error || e?.message || 'Error desconocido';
  }
}
