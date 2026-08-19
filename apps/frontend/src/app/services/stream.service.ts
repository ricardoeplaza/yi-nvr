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

  async startWebRtc(videoElement: HTMLVideoElement, wsUrl: string): Promise<void> {
    const pc = new RTCPeerConnection();

    pc.ontrack = (event: RTCTrackEvent) => {
      videoElement.srcObject = event.streams[0];
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(wsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'offer', sdp: offer.sdp }),
    });

    const answer = (await response.json()) as { type: string; sdp: string };
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }
}
