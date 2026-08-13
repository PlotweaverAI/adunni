import type { LanguageCode } from '@adunni/shared-types';

export interface WidgetConfig {
  apiUrl: string;
  authToken: string;
  clientId: string;
  callerId: string;
  callerPhone?: string;
  preferredLanguage?: LanguageCode;
  branding?: {
    primaryColor?: string;
    secondaryColor?: string;
    agentName?: string;
    agentSubtitle?: string;
    logoUrl?: string;
  };
  container?: HTMLElement;
}

export interface WidgetEvent {
  type: 'connected' | 'disconnected' | 'transcript' | 'audio' | 'error' | 'session_ended' | 'escalated';
  data?: unknown;
}

export type WidgetEventListener = (event: WidgetEvent) => void;

export class AdunniWidget {
  private config: WidgetConfig;
  private ws: WebSocket | null = null;
  private listeners: WidgetEventListener[] = [];
  private isActive = false;
  private audioContext: AudioContext | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;

  constructor(config: WidgetConfig) {
    this.config = config;
  }

  on(listener: WidgetEventListener): void {
    this.listeners.push(listener);
  }

  off(listener: WidgetEventListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private emit(event: WidgetEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  async start(): Promise<void> {
    try {
      const sessionResp = await fetch(`${this.config.apiUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.authToken}`,
        },
        body: JSON.stringify({
          callerId: this.config.callerId,
          callerPhone: this.config.callerPhone,
          preferredLanguage: this.config.preferredLanguage,
        }),
      });

      if (!sessionResp.ok) throw new Error(`Failed to create session: ${sessionResp.status}`);
      const session = await sessionResp.json() as { id: string; streamUrl: string; streamToken: string };

      const wsUrl = this.config.apiUrl.replace(/^http/, 'ws') + `${session.streamUrl}?token=${session.streamToken}`;
      this.ws = new WebSocket(wsUrl);
      this.isActive = true;

      this.ws.onopen = () => {
        this.emit({ type: 'connected' });
        this.startMicCapture();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleMessage(msg);
        } catch (err) {
          console.error('[adunni-widget] parse error:', err);
        }
      };

      this.ws.onerror = () => {
        this.emit({ type: 'error', data: { message: 'WebSocket error' } });
      };

      this.ws.onclose = () => {
        this.emit({ type: 'disconnected' });
        this.isActive = false;
        this.stopMicCapture();
      };
    } catch (err) {
      this.emit({ type: 'error', data: { message: (err as Error).message } });
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    if (type === 'transcript') {
      this.emit({ type: 'transcript', data: msg['turn'] });
    } else if (type === 'audio') {
      this.playAudio(msg['audioBase64'] as string, msg['sampleRate'] as number);
      this.emit({ type: 'audio', data: { format: msg['format'], sampleRate: msg['sampleRate'] } });
    } else if (type === 'turn.complete') {
      // Turn finished
    } else if (type === 'session.ended') {
      this.emit({ type: 'session_ended', data: { sessionId: msg['sessionId'] } });
      this.isActive = false;
    } else if (type === 'error') {
      this.emit({ type: 'error', data: { message: msg['message'] } });
    }
  }

  private async startMicCapture(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.mediaStream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            this.ws?.send(JSON.stringify({ type: 'audio', audio: base64 }));
          };
          reader.readAsDataURL(e.data);
        }
      };

      this.mediaRecorder.start(250);
    } catch (err) {
      console.error('[adunni-widget] mic capture error:', err);
      this.emit({ type: 'error', data: { message: 'Microphone access denied' } });
    }
  }

  private stopMicCapture(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
  }

  private playAudio(base64: string, sampleRate: number): void {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate });
      }
      const audioBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const audioBuffer = this.audioContext.createBuffer(1, audioBytes.length / 2, sampleRate);
      const channelData = audioBuffer.getChannelData(0);
      const view = new DataView(audioBytes.buffer);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = view.getInt16(i * 2, true) / 32768;
      }
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      source.start();
    } catch (err) {
      console.error('[adunni-widget] audio playback error:', err);
    }
  }

  sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'text', text }));
    }
  }

  endCall(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end' }));
    }
    this.stopMicCapture();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  isCallActive(): boolean {
    return this.isActive;
  }

  destroy(): void {
    this.endCall();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners = [];
  }
}
