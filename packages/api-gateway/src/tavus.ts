import { WebSocket } from 'ws';

const TAVUS_API_BASE = 'https://tavusapi.com/v2';

export interface TavusConversation {
  conversation_id: string;
  conversation_url: string;
  status: string;
  pal_id: string;
}

export interface TavusPal {
  pal_id: string;
  pal_name: string;
  pipeline_mode: string;
}

export class TavusClient {
  private apiKey: string;
  private echoPalId: string | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createEchoPal(palName = 'Adunni Echo', faceId = 'rf4e9d9790f0'): Promise<TavusPal> {
    const resp = await fetch(`${TAVUS_API_BASE}/pals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        pal_name: palName,
        pipeline_mode: 'echo',
        default_face_id: faceId,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Tavus createEchoPal failed (${resp.status}): ${body}`);
    }

    const pal = await resp.json() as TavusPal;
    this.echoPalId = pal.pal_id;
    return pal;
  }

  async createConversation(palId?: string, conversationName = 'Adunni Session'): Promise<TavusConversation> {
    const targetPalId = palId ?? this.echoPalId;
    if (!targetPalId) {
      throw new Error('No pal_id provided and no echo PAL created. Call createEchoPal first or provide palId.');
    }

    const resp = await fetch(`${TAVUS_API_BASE}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        pal_id: targetPalId,
        conversation_name: conversationName,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Tavus createConversation failed (${resp.status}): ${body}`);
    }

    return await resp.json() as TavusConversation;
  }

  async endConversation(conversationId: string): Promise<void> {
    const resp = await fetch(`${TAVUS_API_BASE}/conversations/${conversationId}/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
    });

    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      console.error(`[tavus] endConversation warning (${resp.status}): ${body}`);
    }
  }

  async sendEchoMessage(
    conversationUrl: string,
    conversationId: string,
    text: string,
    opts?: { audio?: string; sampleRate?: number; inferenceId?: string; done?: boolean }
  ): Promise<void> {
    const message = {
      message_type: 'conversation',
      event_type: 'conversation.echo',
      conversation_id: conversationId,
      properties: {
        modality: opts?.audio ? 'audio' : 'text',
        text: opts?.audio ? undefined : text,
        audio: opts?.audio,
        sample_rate: opts?.sampleRate ?? 16000,
        inference_id: opts?.inferenceId ?? `adunni-${Date.now()}`,
        done: opts?.done ?? true,
      },
    };

    await this.sendToRoom(conversationUrl, message);
  }

  private async sendToRoom(conversationUrl: string, message: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(conversationUrl.replace(/^https?:\/\//, 'wss://').replace(/^http:\/\//, 'ws://'));

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Tavus room connection timeout'));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(timeout);
        ws.send(JSON.stringify(message));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 500);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Tavus room WebSocket error: ${err.message}`));
      });
    });
  }

  async getPals(): Promise<TavusPal[]> {
    const resp = await fetch(`${TAVUS_API_BASE}/pals`, {
      headers: { 'x-api-key': this.apiKey },
    });

    if (!resp.ok) {
      throw new Error(`Tavus getPals failed (${resp.status})`);
    }

    const data = await resp.json() as { data: TavusPal[] };
    return data.data ?? [];
  }

  async getOrCreateEchoPal(palName = 'Adunni Echo', faceId = 'rf4e9d9790f0'): Promise<TavusPal> {
    const pals = await this.getPals();
    const existing = pals.find(p => p.pipeline_mode === 'echo' && p.pal_name === palName);
    if (existing) {
      this.echoPalId = existing.pal_id;
      return existing;
    }
    return this.createEchoPal(palName, faceId);
  }
}
