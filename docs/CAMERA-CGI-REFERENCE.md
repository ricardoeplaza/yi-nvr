# Referencia de opciones y controles remotos — Cámara Yi (y211ga)

Referencia completa de las opciones y controles remotos disponibles en la cámara real
investigada, para no tener que volver a investigar si se implementan en el futuro.

## Datos de la cámara investigada

| Campo | Valor |
|---|---|
| Modelo | Yi 1080p Home (`y211ga`) |
| IP | `192.168.14.30` |
| Firmware | `yi-hack-allwinner-v2` v0.3.6 |
| Hostname | `yi-oficina` |
| PTZ hardware | **NO** (la UI expone los endpoints, pero esta cámara no los ejecuta) |
| go2rtc | Sí (solo RTSP) |

Fecha de la investigación: 2026-08-21.

> Convención de marcas:
> - *(no verificado)* = deducido de la documentación oficial del firmware (yi-hack), no visto en la UI real.
> - *(verificado en repo)* = confirmado en el código de yi-nvr (whitelist MQTT / REST).
> - Todo lo demás fue verificado en vivo contra la UI de la cámara (`js/all.js` + páginas HTML).

---

## 1. Estado / Información

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Estado completo (fw, IP, memoria, SD, WiFi, uptime) | `/cgi-bin/status.json` | GET | — |
| Nombre del host | `/cgi-bin/hostname.js` | GET | — |
| URLs de stream/snapshot | `/cgi-bin/links.sh` | GET | — |
| Leer configuración por sección | `/cgi-bin/get_configs.sh` | GET | `conf=camera\|system\|mqtt\|mqtt_advertise\|proxychains\|ptz_presets` |
| Escribir configuración por sección | `/cgi-bin/set_configs.sh` | POST | `conf=<sección>` · body JSON (ver §7) |

**Campos de `status.json` (verificados en vivo):** `name`, `hostname`, `fw_version`,
`home_version`, `model_suffix`, `ptz`, `go2rtc`, `serial_number`, `local_time`, `uptime`
(segundos, string), `load_avg`, `total_memory` (KB), `free_memory` (KB), `free_sd`,
`local_ip`, `netmask`, `gateway`, `mac_addr`, `wlan_essid`, `wlan_strength` (dBm).

> **SD:** `free_sd` es un **porcentaje libre** (p. ej. `"71%"`), NO bytes. Ningún CGI
> expone la capacidad total de la SD. yi-nvr guarda el total en `sd_total_mb`
> (opcional) en `cameras.json` y el API calcula usado/libre en MB; si la cámara no
> lo configura, el API usa un default de 32 GB (`SD_TOTAL_MB_DEFAULT`).
>
> **`get_configs.sh`:** la respuesta JSON cierra con el sentinel `"NULL":"NULL"`
> (hay que quitarlo tras `JSON.parse`). Los valores de las secciones son
> `yes`/`no` (NO `on`/`off`), p. ej. `SWITCH_ON`, `LED`, `IR`,
> `SAVE_VIDEO_ON_MOTION`, `HTTPD`.

**Campos de `links.sh` (verificados):** `high_res_stream`, `low_res_snapshot`, `high_res_snapshot`.

---

## 2. Video

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Stream RTSP alta resolución | `rtsp://192.168.14.30/ch0_0.h264` | RTSP | — |
| Stream RTSP baja resolución | `rtsp://192.168.14.30/ch0_1.h264` | RTSP | — |
| Stream RTSP solo audio | `rtsp://192.168.14.30/ch0_2.h264` | RTSP | — |
| Snapshot (alta/baja res, watermark, base64) | `/cgi-bin/snapshot.sh` | GET | `res=high\|low` · `watermark=yes\|no` · `base64=yes` · `file=<nombre>` |
| Grabar video a demanda | `/cgi-bin/record.sh` | GET | `time=<segundos>` *(no verificado)* |
| Privacidad (ocultar/ver) | `/cgi-bin/privacy.sh` | GET | `value=on\|off\|status` *(no verificado)* |
| Último video grabado | `/cgi-bin/getlastrecordedvideo.sh` | GET | `oldness=<n>` · `type=1\|2\|3\|4` *(no verificado)* |
| Audio en RTSP | vía `set_configs.sh?conf=system` | POST | `RTSP_AUDIO=no\|pcm\|alaw\|ulaw\|aac` |

Notas:
- RTSP disponible porque `RTSP=yes` en system.
- `RTSP_ALT` admite `standard` (rRTSPServer), `alternative` (h264grabber+rtsp_server_yi), `go2rtc`.

---

## 3. PTZ (⚠️ esta cámara NO tiene PTZ — endpoints presentes en UI pero inoperativos)

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Mover cámara | `/cgi-bin/ptz.sh` | GET | `dir=left\|right\|up\|down\|up_left\|up_right\|down_left\|down_right` · `time=<seg>` |
| Ir a preset | `/cgi-bin/preset.sh` | GET/POST | `action=go_preset` · `num=<n>` |
| Añadir preset | `/cgi-bin/preset.sh` | GET/POST | `action=add_preset` · `name=<nombre>` |
| Borrar preset | `/cgi-bin/preset.sh` | GET/POST | `action=del_preset` · `num=<n>\|all` |
| Listar presets | `/cgi-bin/get_configs.sh` | GET | `conf=ptz_presets` |
| Modo crucero (presets/360) | `/cgi-bin/camera_settings.sh` | GET | `cruise=no\|presets\|360` |

> Si en el futuro se incorpora una cámara con PTZ real (p. ej. Yi Dome), esta sección
> es directamente aplicable sin investigar de nuevo.

---

## 4. Audio

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| TTS (texto a voz, varios idiomas) | `/cgi-bin/speak.sh` | POST | `lang=es-ES\|en-US\|...` · `voldb=<dB>` · body = texto |
| Reproducir audio crudo (16 kHz 16-bit mono S16LE) | `/cgi-bin/speaker.sh` | POST | `voldb=<dB>` · body = bytes WAV (o multipart `file`) |
| Reproducir archivo pre-cargado | `/cgi-bin/speaker_file.sh` | POST | `voldb=<dB>` · body = nombre de archivo en `/tmp/sd/audio` *(no verificado)* |
| Detección de sonido (alarmas) | ver §5 | | `sound_detection`, `sound_sensitivity` |

---

## 5. Alarmas / Detección

Todos vía `/cgi-bin/camera_settings.sh` (GET):

| Opción | Parámetro |
|---|---|
| Detección de movimiento | `motion_detection=yes\|no` |
| Sensibilidad de movimiento | `sensitivity=low\|medium\|high` |
| Detección de humano (IA) | `ai_human_detection=yes\|no` |
| Detección de vehículo (IA) | `ai_vehicle_detection=yes\|no` |
| Detección de animal (IA) | `ai_animal_detection=yes\|no` |
| Detección de rostro | `face_detection=yes\|no` |
| Seguimiento de movimiento | `motion_tracking=yes\|no` |
| Detección de sonido | `sound_detection=yes\|no` |
| Sensibilidad de sonido | `sound_sensitivity=30..90` |
| Lloro de bebé (latchkey) | vía MQTT `cmnd/camera/baby_crying_detect` → `on\|off` *(verificado en repo)* |

**MQTT — eventos de alarma (input, cámara → nosotros):**
- `<prefix>/<motion>` → `motion_start`, `motion_stop`, `human`, `vehicle`, `animal`, `crying`
- `<prefix>/<sound_detection>` → `sound`
- `<prefix>/<motion_files>` → lista de archivos de eventos

---

## 6. Grabación / Eventos

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Grabar en SD al detectar movimiento | `/cgi-bin/camera_settings.sh` | GET | `save_video_on_motion=yes\|no` |
| Grabación local continua | vía MQTT `cmnd/camera/local_record` | MQTT | `on\|off` *(verificado en repo)* |
| Timelapse — listar | `/cgi-bin/timelapse.sh` | GET | `action=list` |
| Timelapse — borrar | `/cgi-bin/timelapse.sh` | GET | `action=delete` · `file=<nombre>` |
| Ver archivos timelapse | `/record/timelapse/<file>` | GET | — |
| Listar directorios de eventos | `/cgi-bin/eventsdir.sh` | GET | — |
| Listar archivos de un evento | `/cgi-bin/eventsfile.sh` | GET | `dirname=<dir>` |
| Borrar directorio de eventos | `/cgi-bin/eventsdirdel.sh` | GET | `dir=<dir>` |
| Borrar archivo de evento | `/cgi-bin/eventsfiledel.sh` | GET | `file=<file>` |
| Ver video de evento | `/record/<dirname>/<filename>` | GET | — |
| Grabar a demanda (segundos) | `/cgi-bin/record.sh` | GET | `time=<seg>` *(no verificado)* |

---

## 7. Configuración

### 7a. Cámara (`set_configs.sh?conf=camera` / `camera_settings.sh`)

`switch_on`, `save_video_on_motion`, `motion_detection`, `sensitivity`,
`ai_human_detection`, `ai_vehicle_detection`, `ai_animal_detection`, `face_detection`,
`motion_tracking`, `sound_detection`, `sound_sensitivity`, `led`, `ir`, `rotate`, `cruise`.

### 7b. Sistema (`set_configs.sh?conf=system`)

`HOSTNAME`, `TIMEZONE`, `DISABLE_CLOUD`, `REC_WITHOUT_CLOUD`, `RTSP`, `RTSP_ALT`,
`RTSP_STREAM` (high/low/both), `RTSP_AUDIO`, `RTSP_PORT`, `HTTPD_PORT`, `ONVIF`,
`ONVIF_PROFILE`, `ONVIF_NETIF`, `ONVIF_AUDIO_BC`, `TIME_OSD`, `CUSTOM_WATERMARK`,
`SNAPSHOT`, `SNAPSHOT_VIDEO`, `SNAPSHOT_LOW`, `TIMELAPSE`, `TIMELAPSE_DT`,
`TIMELAPSE_VDT`, `TIMELAPSE_FTP`, `TIMELAPSE_FTP_SAME_NAME`, `SSHD`, `FTPD`,
`BUSYBOX_FTPD`, `TELNETD`, `NTPD`, `NTP_SERVER`, `HTTPD`, `MDNSD`, `PROXYCHAINSNG`,
`SWAP_FILE`, `SWAP_SWAPPINESS`, `KERNEL_TUNING`, `USERNAME`, `PASSWORD`,
`SSH_PASSWORD`, `CRONTAB`, `DEBUG_LOG`, `MQTT`, `EVENTS_TIME`, `FREE_SPACE`,
`FTP_HOST`, `FTP_DIR`, `FTP_USERNAME`, `FTP_PASSWORD`, `STATIC_IP`, `STATIC_MASK`,
`STATIC_GW`, `STATIC_DNS1`, `STATIC_DNS2`, `PROXYCHAINS_SERVERS`.

### 7c. MQTT (`set_configs.sh?conf=mqtt`)

`MQTT_IP`, `MQTT_PORT`, `MQTT_TLS`, `MQTT_CLIENT_ID`, `MQTT_USER`, `MQTT_PASSWORD`,
`MQTT_PREFIX`, `MQTT_KEEPALIVE`, `MQTT_QOS`, `TOPIC_BIRTH_WILL`, `BIRTH_MSG`,
`WILL_MSG`, `TOPIC_MOTION`, `MOTION_START_MSG`, `MOTION_STOP_MSG`,
`AI_HUMAN_DETECTION_MSG`, `AI_VEHICLE_DETECTION_MSG`, `AI_ANIMAL_DETECTION_MSG`,
`TOPIC_MOTION_IMAGE`, `MOTION_IMAGE_DELAY`, `TOPIC_MOTION_FILES`,
`TOPIC_SOUND_DETECTION`, `SOUND_DETECTION_MSG`, `MQTT_RETAIN_*`.

### 7d. Home Assistant discovery (`set_configs.sh?conf=mqtt_advertise`)

`MQTT_ADV_INFO_GLOBAL_*`, `MQTT_ADV_LINK_*`, `MQTT_ADV_CAMERA_SETTING_*`,
`MQTT_ADV_TELEMETRY_*`, `HOMEASSISTANT_*`.

### 7e. WiFi

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Escanear redes | `/cgi-bin/wifi.sh` | GET | `action=scan` |
| Guardar red | `/cgi-bin/wifi.sh` | POST | `action=save` · JSON `WIFI_ESSID`, `WIFI_PASSWORD`, `WIFI_PASSWORD2` |

### 7f. IP estática

Vía `set_configs.sh?conf=system` → `STATIC_IP`, `STATIC_MASK`, `STATIC_GW`,
`STATIC_DNS1`, `STATIC_DNS2`.

### 7g. Proxy

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Activar/desactivar proxy | `/cgi-bin/proxy.sh` | GET | `proxy=0\|1` |
| Servidores proxy | `set_configs.sh?conf=proxychains` | POST | `PROXYCHAINS_SERVERS` |

---

## 8. Otros / Mantenimiento

| Opción | Endpoint | Método | Parámetros |
|---|---|---|---|
| Descargar backup de config | `/cgi-bin/save.sh` | GET | — (descarga `config.tar.bz2`) |
| Restaurar backup | `/cgi-bin/load.sh` | POST | multipart `files[]` |
| Reiniciar | `/cgi-bin/reboot.sh` | GET | — (sync×3, `killall mqttv4`, sleep 1, reboot; la cámara puede dejar de responder antes de responder) |
| Reset de fábrica | `/cgi-bin/reset.sh` | GET | — |
| Info de firmware | `/cgi-bin/fw_upgrade.sh` | GET | `get=info` |
| Subir firmware | `/cgi-bin/fw_upgrade.sh` | GET | `get=upgrade` |
| Controlar servicios | `/cgi-bin/service.sh` | GET | `name=rtsp\|onvif\|wsdd\|ftpd\|mqtt\|mp4record\|all` · `action=start\|stop\|status` · `param1`, `param2` *(verificado en repo `set-camera-rtsp.js`)* |

### MQTT — control (output, nosotros → cámara)

Publicar a `<prefix>/cmnd/camera/<cmd>`; respuesta en `<prefix>/stat/camera/<cmd>`.

`<cmd>` ∈ whitelist del repo (`commands.js`):
`led`, `ir`, `rotate`, `motion_detection`, `save_video_on_motion`, `sound_detection`,
`baby_crying_detect`, `ai_human_detection`, `ai_vehicle_detection`, `ai_animal_detection`,
`face_detection`, `motion_tracking`, `local_record`, `switch_on`, `sensitivity`,
`sound_sensitivity`, `cruise`.

Valores: `on`/`off` (o `yes`/`no`), `low`/`medium`/`high` (sensitivity),
`30..90` (sound_sensitivity), `no`/`presets`/`360` (cruise).

### MQTT — estado (input, cámara → nosotros)

- `<prefix>/<birth_will>` → `online` / `offline`
- `<prefix>/<motion>` → `motion_start`, `motion_stop`, `human`, `vehicle`, `animal`, `crying`
- `<prefix>/<sound_detection>` → `sound`
- `<prefix>/<motion_files>` → lista de archivos

---

## 9. API REST ya implementada en yi-nvr (`apps/api`)

| Ruta | Método | Acción |
|---|---|---|
| `/cameras` | GET | Listar cámaras |
| `/cameras/:id/reload` | POST | Recargar config |
| `/cameras/:id/power` | POST | Encender/apagar |
| `/cameras/:id/led` | POST | LED on/off |
| `/cameras/:id/night-vision` | POST | IR on/off |
| `/cameras/:id/rec-mode` | POST | Modo grabación |
| `/cameras/:id/command` | POST | Comando genérico |
| `/cameras/:id/status` | GET | Estado real (proxy HTTP a `status.json` + `get_configs.sh`): estado compuesto `on`/`off`/`unreachable`, SD calculada, últimos eventos MQTT, estado push |
| `/cameras/:id/reboot` | POST | Reinicia la cámara (CGI `reboot.sh`) |
| `/cameras/:id/httpd` | POST | `HTTPD` yes/no (persiste; **se aplica en el siguiente boot**, el firmware solo lee `HTTPD` al arrancar) |
| `/cameras/:id/push` | POST | Toggle de push de movimiento de la cámara (estado del NVR, tabla `camera_settings`) |

---

## Cobertura de la investigación

- **Verificados en la UI real** (js/all.js + páginas HTML): `status.json`,
  `hostname.js`, `links.sh`, `get/set_configs.sh`, `camera_settings.sh`, `ptz.sh`,
  `preset.sh`, `snapshot.sh`, `speak.sh`, `speaker.sh`, `wifi.sh`, `timelapse.sh`,
  `eventsdir.sh`/`eventsfile.sh`/`eventsdirdel.sh`/`eventsfiledel.sh`, `fw_upgrade.sh`,
  `save.sh`, `load.sh`, `reboot.sh`, `reset.sh`, `proxy.sh`, `service.sh`.
- **Solo de docs/wiki del firmware** (marcados *(no verificado)*): `record.sh`,
  `privacy.sh`, `getlastrecordedvideo.sh`, `speaker_file.sh`.
- **Del repo yi-nvr** (whitelist MQTT + REST): `baby_crying_detect`, `local_record`,
  y todas las rutas REST de §9.

## 10. Hallazgos del firmware (yi-hack-allwinner-v2 v0.3.6, del código fuente)

### 10.1 Cadena completa del comando IR (y por qué «on» no enciende los LEDs de día)

Cadena verificada en el código del firmware (repo `yi-hack-Allwinner-v2`):

1. MQTT: publicar `on`/`off` en `<prefix>/cmnd/camera/ir` (whitelist `mqtt-config/validate.c`:
   `{ "camera", "IR", "bool", ..., "ipc_cmd -i %s" }` — `bool` acepta `yes/no` Y `on/off`).
2. `ipc_cmd -i on/off` (`src/ipc_cmd/ipc_cmd/ipc_cmd.c`): parsea case-insensitive y envía el
   mensaje binario `IPC_IR_ON` / `IPC_IR_OFF` a la cola POSIX `/ipc_dispatch`
   (`ipc_cmd.h`: `\x02...\x24\x10\x01\x00\x04\x00\x00\x00` + parámetro `01`/`02`).
3. El proceso IPC (binario propietario, sin fuente) ejecuta el cambio.

**Conclusión:** el NVR envía EXACTAMENTE lo mismo que la UI web oficial de yi-hack
(`cgi-bin/camera_settings.sh`: `ir=yes → ipc_cmd -i on`, `ir=no → ipc_cmd -i off`).
La sintaxis MQTT (`ir: on/off`) es correcta; el bug NO está en yi-nvr.

**Causa más probable del «bug» (off apaga, on no enciende):** el parámetro `IR` habilita
los LEDs IR para visión nocturna, pero el LED es modulado por el auto día/noche del sensor
de luz ambiental dentro del proceso IPC: con `IR=yes` los LEDs solo se encienden cuando el
sensor detecta oscuridad. En una habitación iluminada (p. ej. la oficina de día), `ir=on`
no produce LEDs visibles; `ir=off` los corta siempre (por eso «off parece funcionar»).
La UI oficial de yi-hack tendría el mismo comportamiento. No hay otro parámetro ni otro
comando en el firmware para forzar el LED (no existe «IR force» separado del IR-cut).

### 10.2 Criterio de «requiere reinicio»

| Control | Aplicación | Por qué |
|---|---|---|
| HTTPD (`set_configs.sh?conf=system`) | **Siguiente boot** | `system.conf` solo se lee al arrancar (`system.sh`); no existe CGI de stop en runtime |
| `switch_on`, `led`, `ir`, `save_video_on_motion`, `sensitivity`, etc. (MQTT/`camera_settings.sh`) | **Inmediata** | `ipc_cmd` envía mensajes runtime a la cola IPC; además `load.sh` re-aplica la conf persistida en cada boot |

Regla de la UI: solo el control marcado con `*` requiere reinicio; el resto es inmediato.

---

## 11. Multi-ecosistema

`cameras.json` admite un campo `ecosystem` por cámara (`camera-registry.js`):

| Valor | Significado |
|---|---|
| `yi-hack` | Firmware Yi con yi-hack: el API puede consultarle TODO por HTTP (los CGIs de este documento) y MQTT (controles y eventos) |
| `generic` | Cualquier otra cámara (p. ej. Tuya): el NVR SOLO indexa sus clips por FTP; NO se le consulta ni envía nada por HTTP/MQTT (no sabe responder) |

- **Default**: si el campo falta, `"generic"` (default seguro: nunca se consulta
  a una cámara que no sabe responder; una yi-hack debe marcarse SIEMPRE
  explícitamente).
- **Validación**: cualquier otro valor → error al cargar/recargar `cameras.json`
  (el registro no se actualiza; `POST /cameras/:id/reload` → 400).

### Qué datos aporta cada ecosistema (`GET /api/cameras/:id/status`)

Contrato unificado: mismas claves para ambos ecosistemas; lo no disponible es
SIEMPRE `null` (nunca ausente) y el objeto `capabilities` dice al frontend qué
secciones renderizar (fuente de verdad: cabecera de `routes/camera-status.js` +
`models/camera.model.ts`):

| Dato | yi-hack | generic |
|---|---|---|
| `state` (`on`/`off`/`unreachable`) | Sí (probe HTTP + birth/will MQTT) | `null` (el NVR no puede saberlo) |
| `http` (probe al dispositivo) | Sí | `null` |
| `mqtt` (`{online, lastSeen}`) | Sí (null si aún no hay datos MQTT) | `null` |
| `status` (status.json: fw, IP, MAC, SD%, WiFi, uptime…) | Sí (null si no responde) | `null` |
| `camera_config` / `system_config` (get_configs.sh) | Sí (null si no responde) | `null` |
| `sd` (calculada: `free_sd` + `sd_total_mb`) | Sí (null si no responde) | `null` |
| `video_count`, `last_video` (BD `videos`) | Sí | **Sí** |
| `push_enabled` (BD `camera_settings`) | Sí | **Sí** |
| `last_event`, `last_motion` (BD `mqtt_events`) | Sí | `null` si no hay eventos |

`capabilities`: yi-hack → todos `true`; generic → solo `push` y `videos`
(estado del NVR, no del dispositivo).

**Controles**: `POST /cameras/:id/reboot`, `POST /cameras/:id/httpd` y todos los
controles MQTT de `routes/cameras.js` (power, led, night-vision, rec-mode,
command, group/power) devuelven **409** (`UNSUPPORTED_ECOSYSTEM`) para `generic`.
`POST /cameras/:id/push` funciona en AMBOS ecosistemas (es estado del NVR, no un
control del dispositivo).

### La BD del NVR es la metadata de las cámaras genéricas

Para una cámara `generic`, la única información que tiene el NVR es la que ya
indexó cuando el clip llegó por FTP. El enlace entre la cámara y la BD es
`ftp_dir` (cameras.json) = `camera_name` (BD).

Tabla `videos` (SQLite, `database.js`): una fila por clip indexado.

| Campo | Tipo | Contenido |
|---|---|---|
| `id` | INTEGER PK | Autoincremental |
| `camera_name` | TEXT | `ftp_dir` de la cámara (enlace a cameras.json) |
| `timestamp` | TEXT | Fecha/hora del evento (ISO 8601) |
| `original_path` | TEXT UNIQUE | Ruta absoluta del .mp4 original |
| `thumbnail_path` | TEXT | Ruta del thumbnail JPG generado |
| `preview_path` | TEXT | Ruta del preview WebP animado |
| `duration` | REAL | Duración en segundos |
| `file_size` | INTEGER | Tamaño en bytes |
| `created_at` | DATETIME | Momento del indexado (default `CURRENT_TIMESTAMP`) |

Derivados que expone el API: `video_count` = `COUNT(*)` por `camera_name` y
`last_video` = `MAX(timestamp)` (`getCameraStats`). El timeline (`/api/timeline`)
agrupa la misma tabla por `date(timestamp)`.

---

## 12. Gestión de almacenamiento (SD) — hallazgos del firmware

Investigación del código fuente de yi-hack-allwinner-v2 (repo
`roleoroleo/yi-hack-Allwinner-v2`, scripts en `src/www/httpd/cgi-bin/`).
Fecha: 2026-08-23.

### 12.1 Nomenclatura de archivos en la SD

| Elemento | Formato | Ejemplo | Longitud |
|---|---|---|---|
| Directorio de eventos | `YYYY` `Y` `MM` `M` `DD` `D` `HH` `H` | `2020Y01M01D01H` | 14 chars |
| Archivo de evento (base 8) | `MM` `M` `SS` `S` `XX` `.mp4` | `00M00S60.mp4` | 12 chars |
| Archivo de evento (base 10) | variante con 2 chars extra | `00M00S60XX.mp4` | 14 chars |
| Ruta para borrado | `<dirname>/<filename>` | `2020Y01M01D01H/00M00S60.mp4` | 27–29 chars |
| Timelapse | `YYYY-MM-DD_HH-MM-SS.avi` | `2020-01-01_01-00-00.avi` | variable |

- El directorio se crea por **hora** (la cámara agrupa todos los eventos de
  esa hora en un solo directorio).
- El nombre del archivo codifica **minuto:segundo:frame** dentro de esa hora.
- `eventsfiledel.sh` borra también el `.jpg` thumbnail correspondiente.
- Verificado con archivos reales en `apps/api/src/storage/ftp/oficina/`
  (88 archivos, todos base 8).

### 12.2 CGIs de gestión de eventos

| Script | Parámetro | Acción |
|---|---|---|
| `eventsdir.sh` | — | Lista directorios en `/tmp/sd/record/` (filtra por `grep H`) |
| `eventsfile.sh` | `dirname=<dir>` | Lista archivos en un directorio de eventos |
| `eventsdirdel.sh` | `dir=<dir>\|all` | Borra directorio (o TODO con `all`) |
| `eventsfiledel.sh` | `file=<dir>/<file>` | Borra un archivo + su `.jpg` |
| `timelapse.sh` | `action=list\|delete` · `file=<name>` | Timelapse |
| `clean_records.sh` | — | Cron horario: auto-limpieza por `FREE_SPACE` |

- **Formato real de la respuesta** (medido en vivo, 192.168.14.30):
  - `eventsdir.sh` → `{"records":[{"datetime":"2026-08-23","dirname":"2026Y08M23D15H"}, ...]}`
    (NO es un array plano; el NVR lo normaliza con `parseEventsDir()`).
  - `eventsfile.sh?dirname=X` → `{"records":[{"time":"Time: 17:21","filename":"21M02S58.mp4","thumbfilename":""}, ...]}`
    (`thumbfilename` suele llegar vacío).
- **Tiempos reales del firmware** (cámara Allwinner, ~95–98 directorios):
  - `eventsdir.sh`: **~13 s** (hace `ls -r` + `date -d @...` por cada
    directorio, en CPU ARM lenta).
  - `eventsfile.sh?dirname=X`: **~0,5 s** (un solo `ls`).
  - `status.json`: ~1 s; da `free_sd` como porcentaje (p. ej. `"53%"`).

### 12.3 Bugs y limitaciones del firmware

1. **`eventsdirdel.sh` validación ROTA**: el script usa `DIR = "none"`
   (con espacios) como default; en POSIX sh esto NO asigna la variable
   (es un comando `DIR` con args), así que la validación es un no-op.
   Solo `validateQueryString` protege (rechaza `'!\"@#$%^*(),:;` pero
   permite `/`, `.`, alfanuméricos). **El NVR debe sanitizar estrictamente.**
2. **`eventsfiledel.sh` validación OK**: usa `FILE="none"` (sin espacios),
   la validación funciona correctamente.
3. **Borrar la hora actual**: si `mp4record` está activo y se borra el
   directorio de la hora en curso, el comportamiento es indefinido
   (el proceso de grabación puede recrear el directorio o corromperse).
4. **`dir=all`** ejecuta `rm -rf /tmp/sd/record/*` (incluye `timelapse/`).
5. **`EVENTS_TIME`** (`autodetect`/`local`/`gmt`) afecta solo la
   representación de fecha en la UI; el nombre del directorio siempre
   usa la hora local de la cámara.

### 12.4 Push FTP (`ftppush.sh`)

Fuente: `src/static/static/yi-hack/script/ftppush.sh` (repo
`roleoroleo/yi-hack-Allwinner-v2`).

- Loop de 45 s; lee `system.conf` **en vivo** cada iteración
  (`get_config` por clave).
- El servicio solo **arranca** en el boot si `FTP_UPLOAD=yes`
  (controlado por `system.sh`).
- Claves de config: `FTP_UPLOAD`, `FTP_HOST`, `FTP_DIR`, `FTP_DIR_TREE`,
  `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_FILE_DELETE_AFTER_UPLOAD`.
- Watch de `/tmp/sd/record` buscando `*.mp4` (eventos recién grabados).
- Antes de subir hace `mkd ${FTP_DIR}` (crea la carpeta si no existe;
  relativa a la raíz FTP del servidor).
- `FTP_DIR_TREE=yes` añade un subdirectorio por hora (el nombre del
  directorio de eventos, p. ej. `2020Y01M01D01H`) dentro de `FTP_DIR`.
- `FTP_FILE_DELETE_AFTER_UPLOAD=yes` borra el `.mp4` **y** el `.jpg`
  de la SD tras subirlos.
- Nomenclatura de subida: `<FTP_DIR>/<[hora]/><archivo>.mp4`
  (p. ej. `oficina/2020Y01M01D01H/00M00S60.mp4`).
- Trackea el último archivo enviado en `/tmp/last_file_sent`.
- **El puerto es SIEMPRE 21 (hardcodeado)**: la comprobación de conexión
  usa `nc -w 5 ${FTP_HOST} 21` y la subida `ftpput -u <user> -p <pass>
  ${FTP_HOST} ...` (cliente ftp estándar, puerto 21). No existe ninguna
  clave de puerto en el firmware. Consecuencia (D25): el ftp-srv del NVR
  escucha en `FTP_PORT` **21 por defecto**, así el push funciona sin tocar
  la SD ni hacer forwards. 21 es un puerto privilegiado: el API debe
  correr como root/admin (o con `CAP_NET_BIND_SERVICE` en Linux). Para un
  puerto alternativo: parchear `ftppush.sh` en la SD (4 sitios; ver
  `docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md` §5.2.1) + `FTP_PORT` en el NVR.
- Cambio de `FTP_UPLOAD` no→yes **requiere reboot** (el servicio no
  arranca en caliente). Cambios de host/dir/user/pass se aplican en el
  siguiente ciclo de 45 s si el servicio ya corre.

### 12.5 Endpoints REST implementados (`routes/storage.js`)

| Ruta | Método | Acción |
|---|---|---|
| `/cameras/:id/storage` | GET | Info SD + directorios de eventos |
| `/cameras/:id/storage/files` | DELETE | Borrar archivo (`eventsfiledel.sh`) |
| `/cameras/:id/storage/dirs` | DELETE | Borrar directorio (`eventsdirdel.sh`) |
| `/cameras/:id/storage/dirs/:dir/files` | GET | Ficheros de un directorio (`eventsfile.sh`, bajo demanda) |
| `/cameras/:id/storage/purge` | POST | Purge por scope: `all` / `last` / `range` |
| `/cameras/:id/storage/ftp` | GET | Leer config push FTP + `suggested` + `in_sync` |
| `/cameras/:id/storage/ftp` | POST | Escribir switches; los fijos los fuerza el NVR |

SOLO yi-hack (generic → 409 `UNSUPPORTED_ECOSYSTEM`). Sanitización
estricta de nombres (regex + sin `..` ni path traversal). Purge
secuencial con retardo de 500 ms entre borrados.

**Rendimiento y cache** (medido en vivo): `eventsdir.sh` tarda ~13 s en la
cámara, así que `GET /cameras/:id/storage` usa un timeout propio de 30 s
(`EVENTSDIR_TIMEOUT_MS`; el resto del proxy sigue con 5 s) y cachea el
listado por cámara 60 s (`DIRS_CACHE_TTL_MS`); la segunda llamada responde
en ~0,6 s. La cache se invalida tras `DELETE .../storage/dirs` (los
directorios borrados) y tras `purge` (scope `all` limpia toda la cache).
El listado de ficheros por directorio es bajo demanda
(`GET .../storage/dirs/:dir/files`, ~0,6 s) para no encarecer la carga
inicial.

### 12.6 Parámetros FTP auto-derivados (el NVR es la fuente de verdad)

Los parámetros de push de la cámara **no son libres**: los determina el
NVR, porque el NVR es quien recibe y procesa los clips.

| Clave de la cámara | Valor derivado | Origen en el NVR |
|---|---|---|
| `FTP_HOST` | IP LAN del NVR | `getNvrPublicIp()` en `ftp.js`: env `NVR_PUBLIC_IP` → primera IPv4 no-internal de `os.networkInterfaces()` → `127.0.0.1` |
| `FTP_USERNAME` | usuario del ftp-srv | env `FTP_USER` (default `camera`) |
| `FTP_PASSWORD` | contraseña del ftp-srv | env `FTP_PASS` (default `surveillance123`) |
| `FTP_DIR` | `ftp_dir` de la cámara | `cameras.json` (`ftp_dir`); en la BD `videos.camera_name` = `ftp_dir`, así el NVR sabe de qué cámara es cada clip |

Contrato (ver cabecera de `routes/storage.js`):

- `GET /cameras/:id/storage/ftp` devuelve los valores actuales de la
  cámara + `suggested` (los 4 derivados) + `in_sync: boolean` (true si
  los campos fijos actuales de la cámara coinciden con los derivados).
- `POST /cameras/:id/storage/ftp` acepta **solo switches**
  (`FTP_UPLOAD`, `FTP_DIR_TREE`, `FTP_FILE_DELETE_AFTER_UPLOAD`;
  valores `"yes"`/`"no"`). Los campos fijos SIEMPRE se escriben con los
  derivados: el frontend no los envía y cualquier valor que llegue en el
  cuerpo se ignora. El POST es **auto-reparador**: un «Guardar»
  re-sincroniza la cámara aunque tenga valores viejos.
- Frontend: host/usuario/contraseña/carpeta en SOLO LECTURA (etiqueta
  «Configurado por el NVR»); editables solo los switches; aviso visible
  cuando `in_sync` es false.

---

## Decision log

| Fecha | Decisión |
|---|---|
| 2026-08-21 | Investigación completa de la cámara real (192.168.14.30) para la feature de `camera-detail`. Pendiente: decidir qué opciones se implementan en el componente. |
| 2026-08-21 | **Implementada la feature `camera-detail`**: proxy HTTP en el API (`routes/camera-status.js`) para `status`/`reboot`/`httpd`/`push`; el frontend nunca conoce la IP de la cámara. Estado compuesto: `unreachable` (no responde HTTP) / `off` (`SWITCH_ON=no`) / `on`. |
| 2026-08-21 | **HTTPD**: `set_configs.sh?conf=system` con `HTTPD=no` persiste en `etc/system.conf` pero NO para el httpd en caliente (solo se lee al arrancar, `system.sh`); no existe CGI de stop en runtime. El toggle del NVR persiste y avisa «se aplica en el siguiente reinicio». |
| 2026-08-21 | **SD**: como ningún CGI da la capacidad total, `cameras.json` admite `sd_total_mb` (opcional); el API calcula usado/libre. Sin el campo, la UI no muestra la sección SD. |
| 2026-08-21 | **Push por cámara**: tabla `camera_settings(camera_id, push_enabled)` en SQLite; default activado. Aplica a ambos triggers (evento MQTT `camera-motion` y clip indexado en FTP). |
| 2026-08-21 | **Bug IR investigado**: la cadena MQTT `ir: on/off` → `ipc_cmd -i on/off` → `IPC_IR_ON/OFF` es idéntica a la de la UI oficial yi-hack; yi-nvr no envía nada mal. Causa más probable: los LEDs IR son modulados por el auto día/noche del sensor (con `IR=yes` solo encienden en oscuridad). Ver §10.1. |
| 2026-08-21 | **Tamaño SD**: se mantiene `sd_total_mb` en `cameras.json` (nombre ya implementado y probado; no se renombra a `sd_size_gb` para no romper la config existente). Nuevo: si la cámara no lo configura, el API usa un default de 32 GB (`SD_TOTAL_MB_DEFAULT = 32768` MB, la tarjeta más común) en vez de ocultar la sección. |
| 2026-08-21 | **UI camera-detail**: se elimina el botón «Recargar cámara» (recarga de `cameras.json`; lo que importa es «Reiniciar cámara»). Se marca con `*` el único control que requiere reboot (Servidor HTTP, ver §10.2). |
| 2026-08-21 | **Estado compuesto HTTP + MQTT** (fix «Sin conexión» con la cámara viva): diagnóstico — el httpd de yi-hack de la oficina estaba caído (puerto 80 abierto pero 404 en TODAS las rutas: respondía el web server del firmware de fábrica; MQTT 100% operativo). El probe HTTP de `camera-status.js` marcaba la cámara `unreachable` aunque MQTT dijera online. Solución: (1) `mqtt/client.js` ahora rastrea por cámara el birth/will (`cameraMqttState`: online/lastSeen) y el feedback `stat/camera/<cmd>` (`cameraCommandState`); (2) `GET /cameras/:id/status` compone el estado: HTTP OK → `on`/`off` según `SWITCH_ON`; HTTP caído + MQTT online → **`on`** con `http: false`; HTTP caído + MQTT offline → `unreachable`. (3) Con HTTP caído, `camera_config` se rellena con el último feedback stat MQTT (on/off → yes/no) para que los toggles muestren el estado real; si aún no hay feedback, el API envía un **ping de sync** (payload vacío a `<prefix>/cmnd/camera`) y la cámara re-publica su estado (llega al siguiente poll). (4) `GET /cameras` incluye `mqtt: {online, lastSeen}` por cámara (punto MQTT en la lista). (5) Frontend: secciones Información/SD SIEMPRE visibles con «No disponible» cuando `http: false`; nota «HTTP de la cámara caído · estado por MQTT» en el badge; «Reiniciar cámara» deshabilitado (requiere httpd). Los controles power/LED/IR/grabación/push YA iban por MQTT (`cmnd/camera/<cmd>`) — no se tocó su vía; solo reboot/httpd siguen siendo HTTP (y se deshabilitan/marcan cuando httpd está caído). |
| 2026-08-21 | **Restaurar el HTTP de la cámara (httpd caído)**: el httpd de yi-hack solo arranca en `system.sh` (boot) si `HTTPD=yes` en `/tmp/sd/yi-hack/etc/system.conf`. Opciones: (a) SSH a la cámara: `sed -i 's/^HTTPD=.*/HTTPD=yes/' /tmp/sd/yi-hack/etc/system.conf && reboot`; (b) desde el NVR, el toggle «Servidor HTTP» (POST /cameras/:id/httpd) + «Reiniciar cámara»; (c) desde otra máquina con HTTP vivo: `curl "http://<cam>/set_configs.sh?conf=system" -d '{"HTTPD":"yes"}'` + reboot. Sin HTTPD, el NVR sigue funcionando por MQTT (estado, toggles, clips, push); solo faltan fw/uptime/SD/WiFi/serie y los controles HTTP (reboot, httpd). |
| 2026-08-23 | **Multi-ecosistema** (ver §11): nuevo campo `ecosystem` en `cameras.json` (`"yi-hack"` \| `"generic"`, default `"generic"`; cualquier otro valor → error de validación). Las cámaras `generic` (p. ej. Tuya) NUNCA se consultan por HTTP/MQTT: `GET /cameras/:id/status` devuelve el contrato unificado (mismas claves, no disponible = `null` nunca ausente) con `capabilities` que decide qué renderiza el frontend; sus únicos datos son los que el NVR ya indexa (tablas `videos`, `camera_settings`, `mqtt_events`; enlace `ftp_dir` = `camera_name`). Controles (reboot, httpd, MQTT) → 409 `UNSUPPORTED_ECOSYSTEM`; el toggle de push sigue funcionando en ambos (es estado del NVR). Frontend: `camera-detail` adaptativo por `capabilities` (sin hardcodear el ecosistema), badge de ecosistema en `camera-card`, tests de ambos ecosistemas. |
| 2026-08-23 | **Gestión de almacenamiento SD** (ver §12): nuevo router `routes/storage.js` con 6 endpoints (listar SD/eventos, borrar archivo/directorio, purge por scope, config FTP). Investigación completa del firmware (`eventsdir.sh`, `eventsdirdel.sh`, `eventsfiledel.sh`, `ftppush.sh`, `clean_records.sh`): nomenclatura de directorios (14 chars `YYYY Y MM M DD D HH H`) y archivos (base 8 `MM`+`M`+`SS`+`S`+`XX`), bug de validación en `eventsdirdel.sh` (mitigado con sanitización estricta en el NVR), purge secuencial con retardo 500 ms, FTP push con `requires_reboot` al cambiar `FTP_UPLOAD`. SOLO yi-hack (generic → 409). |
| 2026-08-23 | **Cierre de la feature «Gestión de almacenamiento»**: frontend completo (`pages/storage-management/`, `storage.service.ts`, `storage.model.ts`, ruta `cameras/:id/storage`, enlace «Gestionar almacenamiento» en `camera-detail`): listado de directorios ordenado por fecha, borrado individual con confirmación, purge por alcance (hora/día/semana/30 días/todo, con confirmación por texto «BORRAR» en el alcance total), formulario de push FTP con aviso de reboot. **Bug corregido**: el regex de `isValidDirName` exigía 16 chars (`/^\d{4}Y\d{2}M\d{2}D\d{2}H\d{2}$/`), pero el formato real del firmware es de 14 chars terminando en `H` (`2020Y01M01D01H`); corregido a `/^\d{4}Y\d{2}M\d{2}D\d{2}H$/` (con el regex anterior ningún directorio real pasaba la validación y el purge por `last`/`range` no habría borrado nada). Contratos verificados: cabecera de `routes/storage.js` = `storage.model.ts` = `storage.service.ts` (mismos paths, bodies, shapes y códigos de error). |
| 2026-08-23 | **Parámetros FTP auto-derivados** (ver §12.6): los campos fijos del push (`FTP_HOST`, `FTP_DIR`, `FTP_USERNAME`, `FTP_PASSWORD`) NO son editables: los determina el NVR (host = IP LAN del NVR vía `getNvrPublicIp()` — env `NVR_PUBLIC_IP` → primera IPv4 no-internal → `127.0.0.1`; user/pass = env `FTP_USER`/`FTP_PASS` del ftp-srv; dir = `ftp_dir` de la cámara). `GET .../storage/ftp` añade `suggested` + `in_sync`; `POST .../storage/ftp` acepta solo switches (`FTP_UPLOAD`, `FTP_DIR_TREE`, `FTP_FILE_DELETE_AFTER_UPLOAD`) y SIEMPRE fuerza los fijos con los derivados (auto-reparador). Frontend: fijos en solo lectura («Configurado por el NVR»), switches editables, aviso visible si `in_sync` es false. **Hallazgo del firmware** (fuente de `ftppush.sh`): el puerto de subida es SIEMPRE 21 (hardcodeado en `nc ... 21` y `ftpput`, sin clave de puerto), así que el NVR escucha en 21 por defecto (D25). **Estado real de la cámara (192.168.14.30, leído en vivo)**: `FTP_UPLOAD=no` y todos los campos FTP vacíos → `in_sync=false` (el push está desactivado; el usuario lo activará desde la UI). |
| 2026-08-23 | **Rendimiento del listado de eventos + ficheros bajo demanda** (ver §12.2/§12.5): `eventsdir.sh` tarda ~13 s en la cámara real (el firmware hace `ls -r` + `date` por cada uno de los ~95 directorios, en ARM lento); el timeout genérico de 5 s abortaba el fetch → `dirs: null` → la UI mostraba «Sin directorios de eventos en la tarjeta» (el "5s" reportado). Además, el parseo asumía un array plano pero el formato real es `{"records":[...]}`. Solución: timeout propio de 30 s para `eventsdir.sh` (`EVENTSDIR_TIMEOUT_MS`), cache del listado por cámara de 60 s (`DIRS_CACHE_TTL_MS`) con invalidación tras `DELETE .../dirs` y `purge`, `parseEventsDir()` para el formato real, y nuevo endpoint `GET /cameras/:id/storage/dirs/:dir/files` (proxy de `eventsfile.sh`, ~0,5 s) que la UI pide bajo demanda al expandir la fila del directorio (acordeón, una abierta a la vez, con borrado por fichero). Borrado/purge actualizan el estado local del frontend en vez de refetchear. Medido en vivo (98 directorios): frío 13,5 s → cache 0,6 s; ficheros de un directorio 0,6 s. |
| 2026-08-23 | **502 en POST config push FTP (D23)**: el 502 «cámara no alcanzable» al guardar la config FTP no se reprodujo en pruebas (curl directo a la cámara 1,47 s y vía API 1,39 s, HTTP 200, body JSON de una línea y respuesta `{"error":"false"}` verificados correctos contra `set_configs.sh`/`validate.sh`). Causa más probable: timeout falso — el CGI hace un `sed -i` por clave (7 reescrituras de `system.conf` en la SD); en reposo ~1,5 s, pero con la SD ocupada (grabación o purge en curso) puede superar los 5 s genéricos. Fix: `SET_CONFIGS_TIMEOUT_MS = 15000` solo para ese endpoint + el handler ahora respeta `data.error === 'true'` (502 «la cámara rechazó la configuración» en vez de `success: true` silencioso). Frontend: el alcance del purge se reduce a 3 opciones de retención («De más de un día / 1 semana / 30 días», `from = época, to = ahora - N`); se eliminan «Última hora» y «Todo» (y el panel de confirmación por texto «BORRAR»). Estado final de la cámara: `FTP_UPLOAD=yes`, `in_sync=true`. |
| 2026-08-23 | **Análisis completo de la SD (v0.3.6, y211ga) — ajustes fuera de la Web UI (D24)**: se documenta en `docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md` todo lo modificable en la SD: layout, flujo de arranque (`lower_half_init.sh` → `system.sh` → `startup.sh`), los 63 keys de `system.conf` + 15 de `camera.conf` + `mqttv4.conf`, tabla de puertos (RTSP 554 / HTTP 80 configurables; SSH 22, FTPD 21, WSDD 3702, mDNS 5353 hardcodeados), hooks de usuario (`/tmp/sd/debug.sh`, `startup.sh`, key `CRONTAB`, bind-mounts, `LD_PRELOAD`), desactivación de cloud (`DISABLE_CLOUD` → `cloudAPI_fake` + blacklist). **Hallazgo confirmado con fuente**: busybox 1.36.1 `ftpput` solo acepta puerto vía `-P` (default 21, sin `HOST:PORT`) y `nc` no soporta `host:port` → el push FTP de `ftppush.sh` va SIEMPRE a puerto 21 (4 sitios: `nc ... 21` ×2, `ftpput` sin `-P` ×2); por eso el NVR escucha en 21 por defecto (D25: default 21 en `ftp.js`; puerto alternativo = parchear `ftppush.sh`, ver `docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md` §5.2.1). |
| 2026-08-23 | **Puerto FTP por defecto 21 (D25)**: el NVR escucha en el puerto 21 por defecto (`ftp.js`: `FTP_PORT = process.env.FTP_PORT || 21`; `.env.example` → `FTP_PORT=21`), el puerto que la cámara hardcodea en `ftppush.sh` → el push funciona out-of-the-box sin tocar la SD ni hacer forwards de puerto. Consecuencia: 21 es un puerto privilegiado — el API debe correr como root/admin (o con `CAP_NET_BIND_SERVICE` en Linux; en Docker el container ya es root); `startFtpServer` loguea un error claro con las opciones si el bind falla (`EACCES`/`EPERM`, y `EADDRINUSE`). Para un puerto alternativo: parchear `ftppush.sh` en la SD (4 sitios exactos documentados) + `FTP_PORT` en el NVR. |
