# Firmware de la SD (yi-hack v0.3.6) — Ajustes fuera de la Web UI

Referencia de todo lo que se puede modificar **en la SD** de una cámara Yi
`y211ga` con `yi-hack-allwinner-v2` **v0.3.6** (commit `2b904a0`), analizada
a partir de una **copia fría** de la tarjeta (lectura solo; la copia no se
toca). El objetivo es documentar qué hay fuera de la Web UI y qué impacto
tiene en la arquitectura del NVR (`apps/api`).

- **Copia fría analizada**: `D:\\y211ga_0.3.6`
- **Repositorio fuente de referencia**: `yi-hack-Allwinner-v2` (solo lectura)
- **Rutas en la cámara**: la SD se monta en `/tmp/sd`; por ejemplo
  `yi-hack/etc/system.conf` → `/tmp/sd/yi-hack/etc/system.conf`.

> **Nota de alcance**: esto cubre lo que yi-hack pone en la SD. El firmware
> de fábrica (OEM) vive en `/home` (MTD) y **no** es editable desde la SD;
> yi-hack lo *sustituye* en el arranque (ver §3).

---

## 1. Layout de la SD

```
<raíz de la SD>  (= /tmp/sd en la cámara)
├── Factory/                      Modo fábrica (solo si hay factory_test.sh)
│   ├── config.sh                 Dump MTD + aplica el hack al /backup/init.sh
│   ├── configure_wifi.sh         Escribe SSID/PSK en mtdblock7
│   └── configure_wifi.cfg.ori    Plantilla de WiFi
├── lower_half_init.sh            Script de arranque de nivel SD (6472 B)
└── yi-hack/
    ├── version                   "0.3.6-2b904a0"
    ├── model_suffix              "y211ga"
    ├── startup.sh                Hook de usuario (177 B) — ver §3.3
    ├── fw_upgrade_in_progress    Flag (0 B) de upgrade en curso
    ├── .micropython/lib/mip/     Gestor de paquetes mip (2 .mpy)
    ├── bin/                      38 binarios (busybox, go2rtc, python3, ...)
    ├── sbin/                     dropbear, mdnsd, mkswap, pure-ftpd
    ├── lib/                      9 libs (ipc_multiplex.so, wolfssl, ...)
    ├── usr/bin/                  15 applets busybox (ftpput, nc, wget, ...)
    ├── usr/sbin/                 crond, httpd, ntpd (applets busybox)
    ├── usr/libexec/              sftp-server
    ├── etc/                      Configuración (system.conf, ...)
    ├── script/                   17 scripts + blacklist/
    └── www/cgi-bin/              27 endpoints CGI (Web UI)
```

### 1.1 `bin/` (38 entradas)

| Binario | Tamaño | Rol |
|---|---|---|
| `busybox` | 314 KB | Núcleo de applets (1.36.1) |
| `go2rtc` | 4.5 MB | RTSP/WebRTC alternativo (`RTSP_ALT=go2rtc`) |
| `python3` | 551 KB | MicroPython (mip) |
| `rRTSPServer` | 452 KB | RTSP daemon por defecto |
| `rtsp_server_yi` | 408 KB | RTSP alternativo (`RTSP_ALT=alternative`) |
| `h264grabber` (+`_h`,`_l`) | 17 KB | Captura H.264 para RTSP alternativo |
| `imggrabber` | 1.0 MB | Captura de snapshots |
| `onvif_notify_server` | 72 KB | Eventos ONVIF |
| `wsd_simple_server` | 35 KB | ONVIF WS-Discovery (UDP 3702) |
| `mqttv4` | 27 KB | Broker MQTT + cliente cloud |
| `mqtt-config` | 21 KB | Publica la config a MQTT |
| `cloudAPI` / `cloudAPI_fake` | 463 B / 4.6 KB | Router de cloud (real/fake) |
| `ipc_cmd`, `ipc2file`, `ipc_notify`, `ipc_read` | — | Control IPC (PTZ, IR, eventos) |
| `dropbearmulti` | 267 KB | SSH (dropbear) |
| `set_tz_offset` | 10 KB | Timezone / OSD |
| `speaker`, `pcmvol` | — | Audio |
| `proccgi` | 4.8 KB | CGI runner de httpd |
| `proxychains4` | 5.7 KB | Proxy (PROXYCHAINSNG) |
| `minimp4_yi`, `avimake` | — | MP4/AVI |

### 1.2 `lib/` (9 entradas)

`ipc_multiplex.so` (4.6 KB, **LD_PRELOAD** del proceso OEM), `libasound.so.2`,
`libffi.so.8`, `libjq.so.1`, `libonig.so.5`, `libproxychains4.so`,
`libwolfmqtt.so.18`, `libwolfssl.so.44`.

### 1.3 `usr/` (applets busybox)

- `usr/bin/`: `bzip2, dirname, find, free, ftpget, ftpput, lsof, mkpasswd,
  nc, sort, tail, time, uptime, wget, xargs` (cada uno un script de 30 B con
  shebang a `busybox`).
- `usr/sbin/`: `crond, httpd, ntpd`.
- `usr/libexec/`: `sftp-server` (111 KB).

---

## 2. Archivos de configuración y sus claves

### 2.1 `etc/system.conf` (63 claves)

El archivo principal. Lo lee `system.sh` (arranque) y `service.sh` (servicios).
Se edita en caliente vía el CGI `set_configs.sh?conf=system` (la Web UI) o a
mano por SSH. **La mayoría requiere reinicio** para aplicarse.

| Grupo | Claves |
|---|---|
| Servicios | `HTTPD`, `TELNETD`, `SSHD`, `FTPD`, `BUSYBOX_FTPD`, `MDNSD`, `MQTT`, `RTSP`, `ONVIF`, `ONVIF_WSDD`, `NTPD` |
| Cloud | `DISABLE_CLOUD`, `REC_WITHOUT_CLOUD`, `PROXYCHAINSNG` |
| RTSP | `RTSP_ALT` (standard/alternative/go2rtc), `RTSP_STREAM` (low/high/both), `RTSP_AUDIO`, `RTSP_STI`, `RTSP_PORT` (554) |
| HTTP | `HTTPD_PORT` (80), `USERNAME`, `PASSWORD` |
| Audio | `SPEAKER_AUDIO` |
| Snapshot | `SNAPSHOT`, `SNAPSHOT_VIDEO`, `SNAPSHOT_LOW` |
| Timelapse | `TIMELAPSE`, `TIMELAPSE_FTP`, `TIMELAPSE_FTP_SAME_NAME`, `TIMELAPSE_DT` (60), `TIMELAPSE_VDT` |
| ONVIF | `ONVIF_PROFILE` (high/low/both), `ONVIF_NETIF` (wlan0/eth0), `ONVIF_WM_SNAPSHOT`, `ONVIF_AUDIO_BC`, `ONVIF_ENABLE_MEDIA2`, `ONVIF_FAULT_IF_UNKNOWN`, `ONVIF_FAULT_IF_SET`, `ONVIF_SYNOLOGY_NVR` |
| Tiempo | `TIME_OSD`, `TIMEZONE`, `NTP_SERVER` (pool.ntp.org), `EVENTS_TIME` (autodetect) |
| SD | `FREE_SPACE` (0) |
| **Push FTP** | `FTP_UPLOAD`, `FTP_HOST`, `FTP_DIR`, `FTP_DIR_TREE`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_FILE_DELETE_AFTER_UPLOAD` |
| SSH | `SSH_PASSWORD` |
| Sistema | `SWAP_FILE` (yes, 64 MB), `SWAP_SWAPPINESS` (15), `KERNEL_TUNING`, `CRONTAB`, `DEBUG_LOG`, `STATIC_IP`, `STATIC_MASK`, `STATIC_GW`, `STATIC_DNS1`, `STATIC_DNS2`, `CUSTOM_WATERMARK` |

### 2.2 `etc/camera.conf` (15 claves)

Detección y estado de la cámara (lo que mueve la Web UI y `camera_config`):

`SWITCH_ON`, `SAVE_VIDEO_ON_MOTION`, `MOTION_DETECTION`, `SENSITIVITY`
(low/medium/high), `AI_HUMAN_DETECTION`, `AI_VEHICLE_DETECTION`,
`AI_ANIMAL_DETECTION`, `FACE_DETECTION`, `MOTION_TRACKING`, `SOUND_DETECTION`,
`SOUND_SENSITIVITY` (80), `LED`, `ROTATE`, `IR`, `CRUISE`.

### 2.3 `etc/mqttv4.conf` (broker MQTT embebido)

`MQTT_IP` (0.0.0.0), `MQTT_PORT` (**1883**), `MQTT_TLS` (0),
`MQTT_CLIENT_ID` (yi-cam), `MQTT_USER`, `MQTT_PASSWORD`, `MQTT_PREFIX`
(yicam), topics (`TOPIC_BIRTH_WILL`, `TOPIC_MOTION`, `TOPIC_MOTION_IMAGE`,
`MOTION_IMAGE_DELAY`, `TOPIC_MOTION_FILES`, `TOPIC_SOUND_DETECTION`),
mensajes (`BIRTH_MSG`, `WILL_MSG`, `MOTION_START_MSG`, ...),
`MQTT_KEEPALIVE` (120), `MQTT_QOS` (1), retains.

### 2.4 Otros archivos en `etc/`

- `mqtt_advertise.conf` — publicidad de link/info/camera_setting por cron.
- `proxychains.conf` — `dynamic_chain` + `ProxyList` (vacío).
- `ptz_presets.conf` — 8 slots de presets (0-7), vacíos.
- `blacklist/url` (15 dominios xiaoyi/mi) → sinkhole a `127.0.0.1` en
  `/etc/hosts` (`system.sh:230-231`).
- `blacklist/ip` (11 IPs) → `route add -host <ip> reject`
  (`system.sh:235-236`).

---

## 3. Flujo de arranque y hooks

### 3.1 `lower_half_init.sh` (nivel SD, sustituye al OEM)

| Línea | Acción |
|---|---|
| 143-144 | Si existe `Factory/factory_test.sh` → `Factory/config.sh` (modo fábrica) |
| 184-187 | `mount --bind` de `wifidhcp.sh`/`ethdhcp.sh` (sustituye al DHCP del OEM) |
| 189-194 | `CUSTOM_WATERMARK=yes` → bind de `watermark/blank.bmp` sobre el watermark del OEM |
| 196 | `LD_PRELOAD=ipc_multiplex.so ./dispatch &` (lanza el proceso de cámara del OEM con multiplex) |
| 207-210 | **Hook de debug**: si existe `/tmp/sd/debug.sh` → `sh /tmp/sd/debug.sh &` |

### 3.2 `yi-hack/script/system.sh` (gestor de servicios)

Lee `system.conf` y arranca todo. Puntos clave:

- `135-148`: `SWAP_FILE=yes` → crea/activa `/tmp/sd/swapfile` (64 MB).
- `195`: `DISABLE_CLOUD=no` → lanza `cloudAPI` (real, opcional vía proxychains).
- `230-236`: aplica `blacklist/url` y `blacklist/ip`.
- `252`: `REC_WITHOUT_CLOUD=yes` → grabación sin cloud.
- `295`: `httpd -p $HTTPD_PORT -h .../www/ -c /tmp/httpd.conf`.
- `298-299`: `TELNETD=no` → `killall telnetd` (el telnetd lo arranca el OEM).
- `309-318`: `dropbear -R -B -p 0.0.0.0:22` (genera la clave ECDSA a
  `etc/dropbear/`).
- `324`: `ntpd -p $NTP_SERVER`.
- `371-385`: `mdnsd` con `_http._tcp` ($HTTPD_PORT), `_ssh._tcp` (22),
  `_yi-hack._tcp` ($HTTPD_PORT).
- `392-457`: **crontab** — escribe la clave `CRONTAB` en
  `/var/spool/cron/crontabs/root` y añade las entradas estándar:
  - `1 * * * *` → `update_osd_tz.sh`
  - `* * * * *` → `thumb.sh cron`
  - `0 * * * *` → `clean_records.sh $FREE_SPACE`
  - `* * * * *` → `ftppush.sh cron` (solo si `FTP_UPLOAD=yes`)
  - `TIMELAPSE=yes` → `time_lapse.sh` (+ `create_avi.sh` si `TIMELAPSE_VDT`)
- `460-461`: hook `script/mqtt_advertise/startup.sh` (si existe).
- `480-482`: **`startup.sh` (hook de usuario, último, en primer plano)**.

### 3.3 `startup.sh` (hook de usuario)

Se ejecuta al final de `system.sh`, en primer plano. En **esta copia** el
usuario lo ha personalizado (177 B):

```sh
sh /tmp/sd/yi-hack/script/watch_motion.sh &
sleep 5
sh /tmp/sd/yi-hack/script/watch_sound.sh &
sleep 5
sh /tmp/sd/yi-hack/script/telegram_control.sh &

while true; do
    # (loop vacío)
done
```

> **Advertencia**: los tres scripts referenciados
> (`watch_motion.sh`, `watch_sound.sh`, `telegram_control.sh`) **NO existen**
> en esta copia. El `while true; do done` final es un *busy-wait* que bloquea
> el init (mantiene vivo el proceso de arranque) y **consume 100 % de un
> núcleo**; un `sleep 1` dentro del loop haría lo mismo sin quemar CPU.

### 3.4 Resumen de hooks disponibles (sin tocar la Web UI)

| Hook | Dónde | Cuándo |
|---|---|---|
| `/tmp/sd/debug.sh` | `lower_half_init.sh:208` | Inicio, antes de los servicios |
| `startup.sh` | `system.sh:481` | Fin del arranque, primer plano |
| `CRONTAB` (system.conf) | `system.sh:394` | Cada arranque, crontab de root |
| `mqtt_advertise/startup.sh` | `system.sh:460` | Tras el crontab |
| Bind-mounts + `LD_PRELOAD` | `lower_half_init.sh:184-196` | Inicio (sustituyen al OEM) |
| `Factory/factory_test.sh` | `lower_half_init.sh:143` | Solo si se crea (modo fábrica) |

---

## 4. Servicios y puertos

| Servicio | Puerto | Configurable | Dónde |
|---|---|---|---|
| HTTP (httpd: Web UI + CGI) | `HTTPD_PORT` (80) | Sí | `system.sh:295` |
| RTSP | `RTSP_PORT` (554) | Sí | `service.sh:33-36` |
| SSH (dropbear) | **22** | No (hardcode) | `system.sh:318` |
| Telnet (OEM; yi-hack solo lo mata) | 23 | Sí (`TELNETD=no`) | `system.sh:298` |
| Servidor FTP (busybox `tcpsvd`) | **21** | No (hardcode) | `service.sh:388` |
| Servidor FTP (pure-ftpd) | 21 | No (config pure-ftpd) | `service.sh:390` |
| NTP (cliente) | 123 | `NTP_SERVER` | `system.sh:324` |
| Broker MQTT (mqttv4) | `MQTT_PORT` (1883) | Sí | `mqttv4.conf:10` |
| ONVIF WSDD (`wsd_simple_server`) | UDP 3702 | No (binario) | `service.sh:367` |
| mDNS (`mdnsd`) | UDP 5353 | No | `system.sh:385` |
| **Push FTP (cámara → NVR)** | **21** | **No** | **`ftppush.sh:203,210,221,226`** |

---

## 5. Push FTP (cámara → NVR) — hallazgo clave

`ftppush.sh` sube los clips de `/tmp/sd/record` al NVR. **El puerto de
destino SIEMPRE es 21**, hardcodeado en 4 sitios:

- `ftppush.sh:203` y `:210` → `nc -w 5 ${FTP_HOST} 21` (paso `mkd` de carpetas).
- `ftppush.sh:221` y `:226` → `ftpput -u ... -p ... "${FTP_HOST}"
  "${FTP_DIR}.../archivo.mp4"` (sin opción `-P`).

### 5.1 Verificación de busybox 1.36.1 (fuente)

- **`ftpput`** (`networking/ftpgetput.c:290-338`): uso
  `[OPTIONS] HOST [REMOTE_FILE] LOCAL_FILE`. El puerto **solo** se pasa con
  `-P` (línea 286); por defecto 21 (`bb_lookup_port(port, "tcp", 21)`,
  línea 330). **No** soporta la sintaxis `HOST:PORT`.
- **`nc`** (`networking/nc.c`): usa `argv[0]` como host y `argv[1]` como
  puerto (separados); **no** soporta `host:port`.

Conclusión: sin parchear `ftppush.sh`, la cámara **solo** puede empujar a
puerto 21.

### 5.2 Impacto en el NVR (`apps/api`) — D25

El NVR **escucha por defecto en el puerto 21** (el que hardcodea la cámara),
así el push funciona out-of-the-box sin tocar la SD:

- `apps/api/src/ftp.js:30` → `FTP_PORT = process.env.FTP_PORT || 21`.
- `.env.example` → `FTP_PORT=21`.

**Puerto privilegiado**: 21 < 1024, el bind requiere permisos:

- **Linux**: correr el API como root o con `CAP_NET_BIND_SERVICE`
  (`setcap "cap_net_bind_service=+ep" $(which node)`). En Docker el proceso
  del container ya corre como root: no hay que hacer nada.
- **Windows**: ejecutar el API como administrador.

Si el bind falla (`EACCES`/`EPERM`), `startFtpServer` loguea un error claro
con estas opciones y el API sale con código 1 (también cubre `EADDRINUSE`).

#### 5.2.1 Puerto alternativo: parchear `ftppush.sh` en la SD de la cámara

Si en producción se prefiere un puerto no privilegiado (p. ej. **2121**), hay
que parchear `ftppush.sh` (en la SD, en los 4 sitios del §5) y `FTP_PORT` en
el NVR. Ejemplo para **2121**:

1. `ftppush.sh:203` y `:210` — comprobación de conexión / paso `mkd`
   (2× `nc ... 21`):

   ```sh
   # antes
   nc -w 5 ${FTP_HOST} 21
   # después
   nc -w 5 ${FTP_HOST} 2121
   ```

2. `ftppush.sh:221` y `:226` — subida (2× `ftpput` **sin** `-P`; busybox
   `ftpput` solo acepta el puerto con `-P`, §5.1):

   ```sh
   # antes
   ftpput -u ${FTP_USERNAME} -p ${FTP_PASSWORD} "${FTP_HOST}" "${FTP_DIR}.../archivo.mp4"
   # después (añadir -P 2121)
   ftpput -u ${FTP_USERNAME} -p ${FTP_PASSWORD} -P 2121 "${FTP_HOST}" "${FTP_DIR}.../archivo.mp4"
   ```

3. NVR: `FTP_PORT=2121` en `.env` (y `2121:2121` en `docker-compose.yml`).

Opción más limpia a largo plazo: añadir una clave `FTP_PORT` a `system.conf`
y parchear `ftppush.sh` para leerla (permitiría cambiarlo desde la Web UI
sin tocar la SD).

---

## 6. Desactivación de la cloud

- `DISABLE_CLOUD=yes` → `bin/cloudAPI` enruta a `bin/cloudAPI_fake`, que
  responde con JSON falsos (`code:20000`) a los comandos de la cloud
  (`138` login, `136` sintime → lanza `ntpd -q`, `141` tnp, `142` get_dev_info,
  `304`/`306`/`411` eventos) y mantiene la cámara «contenta» sin internet.
- `REC_WITHOUT_CLOUD=yes` → grabación local sin depender de la cloud.
- `blacklist/url` + `blacklist/ip` (§2.4) → sinkhole DNS + rutas rechazadas
  contra los dominios/IPs de Xiaomi/Yi.

---

## 7. Web API (`www/cgi-bin/`, 27 endpoints)

`camera_settings.sh`, `eventsdir.sh`, `eventsdirdel.sh`, `eventsfile.sh`,
`eventsfiledel.sh`, `fw_upgrade.sh`, `getlastrecordedvideo.sh`,
`get_configs.sh`, `hostname.js`, `links.sh`, `load.sh`, `preset.sh`,
`proxy.sh`, `ptz.sh`, `reboot.sh`, `record.sh`, `reset.sh`, `save.sh`,
`service.sh`, `set_configs.sh`, `snapshot.sh`, `speak.sh`, `speaker.sh`,
`speaker_file.sh`, `status.json`, `timelapse.sh`, `validate.sh`, `wifi.sh`.

(Referencia completa de cada endpoint en `docs/CAMERA-CGI-REFERENCE.md`.)

---

## 8. Riesgos / qué NO tocar

- **`/home` (MTD) y el firmware OEM**: no es editable desde la SD; yi-hack lo
  sustituye en el arranque. Un `fw_upgrade` o un reset de fábrica lo pisa.
- **`Factory/`**: crear `Factory/factory_test.sh` activa el modo fábrica
  (`config.sh` hace dump MTD y reescribe `/backup/init.sh`). No crear ese
  fichero salvo intención expresa.
- **`fw_upgrade_in_progress`**: flag de upgrade; no borrar mientras hay
  upgrade en curso.
- **`etc/dropbear/`**: contiene la clave ECDSA del SSH; borrarla regenera la
  clave (cambia la huella del host).
- **`system.conf`**: un `sed -i` por clave (el CGI `set_configs.sh` hace 7
  reescrituras); con la SD ocupada puede tardar >5 s (ver D23).
- **`startup.sh`**: el busy-wait de esta copia consume un núcleo; sustituir
  el `while true; do done` por un loop con `sleep 1` si se mantiene.

---

## 9. Referencias cruzadas

- `docs/CAMERA-CGI-REFERENCE.md` — endpoints CGI + decision log.
- `docs/ARCHITECTURE.md` — decisiones D20-D25 (almacenamiento, push FTP,
  timeouts, análisis de la SD y puerto FTP por defecto).
- `apps/api/src/ftp.js` — servidor FTP del NVR (puerto `FTP_PORT`).
- `apps/api/src/routes/storage.js` — proxy de la SD (eventos, purge, FTP).
