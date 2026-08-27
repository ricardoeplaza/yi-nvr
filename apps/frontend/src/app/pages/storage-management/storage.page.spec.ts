import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of, throwError } from 'rxjs';

import { StoragePage } from './storage.page';
import { CameraService } from '../../services/camera.service';
import { StorageService } from '../../services/storage.service';
import { Camera } from '../../models/camera.model';

function makeCamera(): Camera {
  return {
    id: 'cam1',
    name: 'Cámara 1',
    host: '192.168.1.50',
    ecosystem: 'yi-hack',
    ftp_dir: 'cam1',
    capabilities: { led: true, ircut: true, rec_mode: true, power: true },
    has_videos: false,
    video_count: 0,
    last_video: null,
    mqtt: null,
    status: null,
    latest_video: null,
  };
}

function makeStorageResponse() {
  return {
    success: true,
    data: {
      id: 'cam1',
      sd: { total_mb: 32768, free_mb: 16000, used_mb: 16768, free_pct: 49 },
      dirs: ['2020Y01M01D01H', '2020Y01M02D03H', '2019Y12M31D23H'],
    },
  };
}

let ftpInSyncValue = true;

function makeFtpResponse() {
  return {
    success: true,
    data: {
      FTP_UPLOAD: 'no',
      FTP_HOST: '192.168.1.10',
      FTP_DIR: 'cam1',
      FTP_DIR_TREE: 'no',
      FTP_USERNAME: 'user',
      FTP_PASSWORD: 'pass',
      FTP_FILE_DELETE_AFTER_UPLOAD: 'no',
      suggested: {
        FTP_HOST: '192.168.1.10',
        FTP_DIR: 'cam1',
        FTP_USERNAME: 'user',
        FTP_PASSWORD: 'pass',
      },
      in_sync: ftpInSyncValue,
    },
  };
}

describe('StoragePage', () => {
  let storageError: unknown;
  let ftpError: unknown;
  let deletedDirs: string[];
  let deletedFiles: string[];
  let purgeCalls: unknown[];
  let savedFtp: unknown[];

  function storageServiceMock() {
    return {
      getStorage: () => (storageError ? throwError(() => storageError) : of(makeStorageResponse())),
      deleteDir: (id: string, dir: string) => {
        deletedDirs.push(dir);
        return of({ success: true, deleted: dir });
      },
      getDirFiles: (id: string, dir: string) =>
        of({
          success: true,
          data: {
            dir,
            date: '2020-01-01',
            files: [
              { time: 'Time: 01:27', filename: '27M00S60.mp4', thumbfilename: '' },
              { time: 'Time: 00:05', filename: '05M12S33.mp4', thumbfilename: '05M12S33.jpg' },
            ],
          },
        }),
      deleteFile: (id: string, file: string) => {
        deletedFiles.push(file);
        return of({ success: true, deleted: file });
      },
      purge: (id: string, req: unknown) => {
        purgeCalls.push(req);
        return of({ success: true, purged: ['2020Y01M01D01H'], count: 1 });
      },
      getFtpConfig: () => (ftpError ? throwError(() => ftpError) : of(makeFtpResponse())),
      saveFtpConfig: (id: string, cfg: unknown) => {
        savedFtp.push(cfg);
        return of({ success: true, requires_reboot: true });
      },
    };
  }

  async function createPage() {
    storageError = null;
    ftpError = null;
    ftpInSyncValue = true;
    deletedDirs = [];
    deletedFiles = [];
    purgeCalls = [];
    savedFtp = [];
    window.confirm = vi.fn(() => true);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [StoragePage],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'cam1' } } } },
        {
          provide: CameraService,
          useValue: {
            getCameras: () => of({ success: true, count: 1, data: [makeCamera()] }),
            rebootCamera: () => of({ success: true, rebooted: true }),
          },
        },
        { provide: StorageService, useValue: storageServiceMock() },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(StoragePage);
    fixture.detectChanges();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('should create', async () => {
    const fixture = await createPage();
    expect(fixture.componentInstance).toBeTruthy();
    fixture.destroy();
  });

  it('muestra info SD, cámara y directorios ordenados por fecha (recientes primero)', async () => {
    const fixture = await createPage();
    const host = fixture.nativeElement;
    expect(host.textContent).toContain('Cámara 1');
    expect(host.textContent).toContain('Tarjeta SD');
    expect(host.textContent).toContain('49% libre');
    const rows = host.querySelectorAll('.dir-row');
    expect(rows.length).toBe(3);
    // El más reciente (2020Y01M02D03H) va primero
    expect(rows[0].querySelector('.dir-name').textContent).toContain('2020Y01M02D03H');
    expect(rows[2].querySelector('.dir-name').textContent).toContain('2019Y12M31D23H');
    // Fecha legible parseada del nombre de 14 chars
    expect(rows[0].querySelector('.dir-date').textContent).toContain('02/01/2020');
    fixture.destroy();
  });

  it('un error de carga (502) muestra el mensaje y no rompe la página', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    storageError = { error: { success: false, error: 'cámara no alcanzable' } };
    component.loadStorage();
    fixture.detectChanges();
    const host = fixture.nativeElement;
    expect(host.querySelector('.state-box.error')).toBeTruthy();
    expect(host.textContent).toContain('cámara no alcanzable');
    expect(host.querySelector('.dir-list')).toBeNull();
    fixture.destroy();
  });

  it('un 409 (ecosistema no soportado) se muestra como error sin romper', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    storageError = {
      error: {
        success: false,
        error:
          'la cámara "cam1" es de ecosistema "generic": la gestión de SD requiere firmware yi-hack',
      },
    };
    component.loadStorage();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      'la gestión de SD requiere firmware yi-hack',
    );
    fixture.destroy();
  });

  it('carga la config FTP: switches desde la cámara y campos fijos derivados del NVR', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    expect(component.ftpUpload()).toBe(false);
    expect(component.ftpSuggested()).toEqual({
      FTP_HOST: '192.168.1.10',
      FTP_DIR: 'cam1',
      FTP_USERNAME: 'user',
      FTP_PASSWORD: 'pass',
    });
    expect(component.ftpInSync()).toBe(true);
    fixture.destroy();
  });

  it('la sección FTP nace colapsada: muestra el resumen, no el formulario', async () => {
    const fixture = await createPage();
    const host = fixture.nativeElement;
    expect(host.querySelector('.ftp-form')).toBeNull();
    expect(host.querySelector('.ftp-summary')).toBeTruthy();
    expect(host.textContent).toContain('Desactivada');
    expect(host.textContent).toContain('Mostrar');
    fixture.destroy();
  });

  it('expandir la sección FTP muestra el formulario y el resumen desaparece', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.ftpOpen.set(true);
    fixture.detectChanges();
    const host = fixture.nativeElement;
    expect(host.querySelector('.ftp-form')).toBeTruthy();
    expect(host.querySelector('.ftp-summary')).toBeNull();
    expect(host.textContent).toContain('Ocultar');
    fixture.destroy();
  });

  it('guardar FTP envía SOLO los switches (los fijos los fuerza el NVR) y muestra el aviso de reboot', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.ftpOpen.set(true);
    component.ftpUpload.set(true);
    component.saveFtp();
    expect(savedFtp.length).toBe(1);
    expect(savedFtp[0]).toEqual({
      FTP_UPLOAD: 'yes',
      FTP_DIR_TREE: 'no',
      FTP_FILE_DELETE_AFTER_UPLOAD: 'no',
    });
    expect(savedFtp[0]).not.toHaveProperty('FTP_HOST');
    expect(savedFtp[0]).not.toHaveProperty('FTP_DIR');
    expect(savedFtp[0]).not.toHaveProperty('FTP_USERNAME');
    expect(savedFtp[0]).not.toHaveProperty('FTP_PASSWORD');
    expect(component.ftpRebootNotice()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.reboot-notice')).toBeTruthy();
    fixture.destroy();
  });

  it('in_sync false muestra el aviso de desincronización y guardar lo resuelve', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    ftpInSyncValue = false;
    component.loadFtp();
    component.ftpOpen.set(true);
    fixture.detectChanges();
    expect(component.ftpInSync()).toBe(false);
    expect(fixture.nativeElement.querySelector('.out-of-sync')).toBeTruthy();
    component.saveFtp();
    expect(component.ftpInSync()).toBe(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.out-of-sync')).toBeNull();
    fixture.destroy();
  });

  it('in_sync false con la sección colapsada muestra el warning visible', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    ftpInSyncValue = false;
    component.loadFtp();
    fixture.detectChanges();
    const host = fixture.nativeElement;
    expect(host.querySelector('.ftp-form')).toBeNull();
    expect(host.querySelector('.ftp-warning')).toBeTruthy();
    expect(host.textContent).toContain(
      'Configuración incorrecta: el push FTP no está configurado contra el NVR',
    );
    fixture.destroy();
  });

  it('un error de la config FTP (502) se muestra en su sección', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    ftpError = { error: { success: false, error: 'cámara no alcanzable' } };
    component.loadFtp();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('cámara no alcanzable');
    expect(fixture.nativeElement.querySelector('.ftp-form')).toBeNull();
    fixture.destroy();
  });

  it('borrar un directorio pide confirmación y llama al servicio', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.deleteDir('2020Y01M01D01H');
    expect(deletedDirs).toEqual(['2020Y01M01D01H']);
    expect(window.confirm).toHaveBeenCalled();
    fixture.destroy();
  });

  it('borrar un directorio sin confirmar no llama al servicio', async () => {
    const fixture = await createPage();
    window.confirm = vi.fn(() => false);
    const component = fixture.componentInstance;
    component.deleteDir('2020Y01M01D01H');
    expect(deletedDirs).toEqual([]);
    fixture.destroy();
  });

  it('borrar un directorio lo quita de la lista sin re-pedir el listado', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.deleteDir('2020Y01M01D01H');
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('.dir-row');
    expect(rows.length).toBe(2);
    expect(component.dirs().map((d) => d.name)).not.toContain('2020Y01M01D01H');
    fixture.destroy();
  });

  it('expandir un directorio carga y muestra sus ficheros', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.toggleDir('2020Y01M01D01H');
    fixture.detectChanges();
    const host = fixture.nativeElement;
    const rows = host.querySelectorAll('.file-row');
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain('27M00S60.mp4');
    expect(host.textContent).toContain('Time: 01:27');
    // Colapsar de nuevo oculta los ficheros
    component.toggleDir('2020Y01M01D01H');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.file-row').length).toBe(0);
    fixture.destroy();
  });

  it('borrar un fichero llama al servicio con la ruta dirname/filename', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.deleteFile('2020Y01M01D01H', '27M00S60.mp4');
    expect(deletedFiles).toEqual(['2020Y01M01D01H/27M00S60.mp4']);
    fixture.destroy();
  });

  it('purge "de más de un día" borra lo ANTERIOR a 24 h (retención), no la última hora/día', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.purgeScope.set('day');
    component.onPurge();
    expect(purgeCalls.length).toBe(1);
    const req = purgeCalls[0] as { scope: string; from: string; to: string };
    expect(req.scope).toBe('range');
    // from = época (cubre todo lo antiguo), to = ahora - 24 h
    expect(Date.parse(req.from)).toBe(0);
    const diffH = (Date.now() - Date.parse(req.to)) / 3600_000;
    expect(diffH).toBeGreaterThan(23.9);
    expect(diffH).toBeLessThan(24.1);
    fixture.destroy();
  });

  it('purge "de más de 1 semana" usa to = ahora - 7 días', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.purgeScope.set('week');
    component.onPurge();
    expect(purgeCalls.length).toBe(1);
    const req = purgeCalls[0] as { scope: string; from: string; to: string };
    expect(req.scope).toBe('range');
    expect(Date.parse(req.from)).toBe(0);
    const diffDays = (Date.now() - Date.parse(req.to)) / 86_400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
    fixture.destroy();
  });

  it('purge "de más de 30 días" borra lo ANTERIOR a 30 días (retención), no los últimos 30', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    component.purgeScope.set('month');
    component.onPurge();
    expect(purgeCalls.length).toBe(1);
    const req = purgeCalls[0] as { scope: string; from: string; to: string };
    expect(req.scope).toBe('range');
    const from = Date.parse(req.from);
    const to = Date.parse(req.to);
    // from = época (cubre todo lo antiguo), to = ahora - 30 días
    expect(from).toBe(0);
    const diffDays = (Date.now() - to) / 86_400_000;
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
    fixture.destroy();
  });

  it('muestra el resultado del purge (parcial si algún directorio falla)', async () => {
    const fixture = await createPage();
    const component = fixture.componentInstance;
    // El mock purga 1 de los 3 esperados (los 3 dirs del mock son de 2019/2020)
    component.purgeScope.set('day');
    component.onPurge();
    expect(component.purgeOutcome()).toEqual({
      expected: 3,
      purged: ['2020Y01M01D01H'],
      failed: 2,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.purge-result.partial')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('no pudieron borrarse');
    fixture.destroy();
  });
});
