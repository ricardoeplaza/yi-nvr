import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { StreamInfo } from '../models/stream.model';

@Injectable({ providedIn: 'root' })
export class StreamService {
  private readonly http = inject(HttpClient);

  getStreamInfo(cameraId: string): Observable<StreamInfo> {
    return this.http.get<StreamInfo>(`/api/cameras/${cameraId}/stream`);
  }

  async startWebRtc(videoElement: HTMLVideoElement, whepUrl: string): Promise<RTCPeerConnection> {
    const pc = new RTCPeerConnection();

    pc.ontrack = (event: RTCTrackEvent) => {
      videoElement.srcObject = event.streams[0];
    };

    // Sin addTransceiver() previo, createOffer() genera un offer SIN secciones
    // m= (verificado en Chromium): go2rtc no tendría nada con qué negociar.
    // Declaramos video y audio recvonly (la cámara tiene ambos).
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Esperamos a que se recolecten los candidatos ICE locales: sin ellos el
    // offer no lleva candidatos y go2rtc no puede formar el par ICE.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = window.setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // El endpoint WHEP de go2rtc es un POST HTTP (no WebSocket): body = SDP
    // offer con Content-Type: application/sdp, respuesta = SDP answer en texto
    // plano (201 Created, con todos los candidatos ICE embebidos, sin trickle).
    // La media fluye por el peer, no por la petición HTTP.
    const sdp = pc.localDescription?.sdp ?? '';
    let response: Response;
    try {
      response = await fetch(whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdp
      });
    } catch {
      pc.close();
      throw new Error('WHEP: sin respuesta de go2rtc');
    }
    if (!response.ok) {
      pc.close();
      throw new Error(`WHEP: error HTTP ${response.status}`);
    }

    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    return pc;
  }
}
