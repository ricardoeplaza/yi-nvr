import { CameraSd } from './camera.model';

// Contrato de la gestión de almacenamiento (SD): ver cabecera de
// apps/api/src/routes/storage.js. SOLO yi-hack (generic → 409).

// GET /cameras/:id/storage
export interface StorageInfo {
  id: string;
  sd: CameraSd | null;
  // Nombres de directorio de eventos (14 chars: YYYY Y MM M DD D HH H,
  // p. ej. "2020Y01M01D01H"). null si la cámara no expone el listado.
  dirs: string[] | null;
}

// GET /cameras/:id/storage/ftp — config de push FTP (claves system.sh).
// Valores 'yes'/'no' para los switches; null si la clave no está en la config.
// Los campos fijos (HOST/DIR/USERNAME/PASSWORD) NO son parámetros libres:
// los determina el NVR (bloque `suggested`); `in_sync` indica si la cámara
// los tiene ya aplicados.
export interface StorageFtpSuggested {
  FTP_HOST: string;
  FTP_DIR: string;
  FTP_USERNAME: string;
  FTP_PASSWORD: string;
}

export interface StorageFtpConfig {
  FTP_UPLOAD: string | null;
  FTP_HOST: string | null;
  FTP_DIR: string | null;
  FTP_DIR_TREE: string | null;
  FTP_USERNAME: string | null;
  FTP_PASSWORD: string | null;
  FTP_FILE_DELETE_AFTER_UPLOAD: string | null;
  suggested: StorageFtpSuggested;
  in_sync: boolean;
}

// POST /cameras/:id/storage/ftp — solo switches; los campos fijos los
// fuerza el backend con los derivados (el frontend no los envía).
export interface StorageFtpUpdate {
  FTP_UPLOAD?: 'yes' | 'no';
  FTP_DIR_TREE?: 'yes' | 'no';
  FTP_FILE_DELETE_AFTER_UPLOAD?: 'yes' | 'no';
}

// GET /cameras/:id/storage/dirs/:dir/files — ficheros de evento dentro de
// un directorio (eventsfile.sh, bajo demanda).
export interface StorageDirFile {
  // Formateado por el firmware, p. ej. "Time: 13:27"
  time: string;
  // p. ej. "27M00S60.mp4"
  filename: string;
  // Nombre del thumbnail .jpg; "" si no existe
  thumbfilename: string;
}

export interface StorageDirFiles {
  dir: string;
  // p. ej. "2026-08-23"
  date: string | null;
  files: StorageDirFile[];
}

// POST /cameras/:id/storage/purge — body: {scope: "all"} | {scope: "last", count}
// | {scope: "range", from, to}. Respuesta con los directorios borrados.
export interface StoragePurgeRequest {
  scope: 'all' | 'last' | 'range';
  from?: string;
  to?: string;
  count?: number;
}

export interface StoragePurgeResult {
  success: boolean;
  purged: string[];
  count: number;
}
