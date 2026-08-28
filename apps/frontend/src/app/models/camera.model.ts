import { Video } from './video.model';

export interface CameraCapabilities {
  led: boolean;
  ircut: boolean;
  rec_mode: boolean;
  power: boolean;
}

// Ecosistema de la cámara (cameras.json; default "generic").
export type Ecosystem = 'yi-hack' | 'generic';

// Capabilities del contrato unificado de GET /cameras/:id/status: qué
// secciones puede renderizar el frontend. yi-hack: todo true. generic: solo
// push y videos (estado del NVR, no del dispositivo).
export interface StatusCapabilities {
  live_status: boolean;
  controls: boolean;
  sd: boolean;
  wifi: boolean;
  system: boolean;
  mqtt: boolean;
  push: boolean;
  videos: boolean;
}

export interface CameraMqttState {
  online: boolean;
  lastSeen: string | null;
}

export interface Camera {
  id: string;
  name: string;
  host: string;
  ecosystem: Ecosystem;
  ftp_dir: string;
  thumbnail_url?: string;
  capabilities: CameraCapabilities;
  has_videos: boolean;
  video_count: number;
  last_video: string | null;
  mqtt?: CameraMqttState | null;
  // Campos SOLO de GET /cameras/status (el listado rápido GET /cameras no
  // los trae): status: mismo objeto que GET /cameras/:id/status (null en
  // generic); latest_video: último clip de la cámara (null si no tiene).
  status?: CameraStatus | null;
  latest_video?: Video | null;
}

export interface CameraSd {
  total_mb: number;
  free_mb: number;
  used_mb: number;
  free_pct: number;
}

export interface CameraEventRef {
  event_type: string;
  received_at: string;
}

// Campos de status.json (CGI yi-hack). Opcionales: la cámara puede no
// exponer alguno según el modelo/firmware.
export interface CameraRawStatus {
  name?: string;
  hostname?: string;
  fw_version?: string;
  home_version?: string;
  model_suffix?: string;
  ptz?: string;
  go2rtc?: string;
  serial_number?: string;
  local_time?: string;
  uptime?: string;
  load_avg?: string;
  total_memory?: string;
  free_memory?: string;
  free_sd?: string;
  local_ip?: string;
  netmask?: string;
  gateway?: string;
  mac_addr?: string;
  wlan_essid?: string;
  wlan_strength?: string;
}

// Contrato unificado de GET /cameras/:id/status (ver cabecera de
// apps/api/src/routes/camera-status.js). Misma shape para ambos ecosistemas:
// lo NO disponible es SIEMPRE null (nunca ausente). El frontend decide qué
// secciones pintar con `capabilities`, sin hardcodear el ecosistema.
export interface CameraStatus {
  id: string;
  host: string;
  ecosystem: Ecosystem;
  capabilities: StatusCapabilities;
  // null en generic: el NVR no puede saber si la cámara está encendida.
  state: 'on' | 'off' | 'unreachable' | null;
  // true si el probe HTTP a la cámara respondió (CGIs yi-hack accesibles).
  // false → la cámara puede estar viva por MQTT (state "on") pero su httpd
  // está caído/desactivado: fw/uptime/SD/WiFi/serie no disponibles.
  // null en generic (no se hace probe).
  http: boolean | null;
  mqtt: CameraMqttState | null;
  status: CameraRawStatus | null;
  camera_config: Record<string, any> | null;
  system_config: Record<string, any> | null;
  sd: CameraSd | null;
  // Metadatos de clips del NVR (ambos ecosistemas).
  video_count: number;
  last_video: string | null;
  push_enabled: boolean;
  last_event: CameraEventRef | null;
  last_motion: CameraEventRef | null;
}
