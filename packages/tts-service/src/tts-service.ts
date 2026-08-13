import type {
  TtsService,
  TtsStream,
  TtsRequest,
  TtsChunk,
  TtsProvider,
  LanguageCode,
} from '@adunni/shared-types';

export class MockTtsProvider implements TtsProvider {
  name = 'mock-tts';
  supportedLanguages: LanguageCode[] = ['en-NG', 'pcm', 'yo', 'ig', 'ha'];

  synthesize(request: TtsRequest): TtsStream {
    let closed = false;
    const chunkCallbacks: Array<(chunk: TtsChunk) => void> = [];
    const errorCallbacks: Array<(error: Error) => void> = [];
    const closeCallbacks: Array<() => void> = [];

    setImmediate(() => {
      const text = request.text;
      const chunkSize = 200;
      let offset = 0;

      const sendChunk = () => {
        if (closed) return;
        if (offset >= text.length) {
          chunkCallbacks.forEach((cb) => cb({
            audio: Buffer.alloc(0),
            isFinal: true,
            format: 'pcm16',
            sampleRate: 16000,
          }));
          closeCallbacks.forEach((cb) => cb());
          return;
        }
        const slice = text.slice(offset, offset + chunkSize);
        const fakeAudio = Buffer.from(slice, 'utf-8');
        chunkCallbacks.forEach((cb) => cb({
          audio: fakeAudio,
          isFinal: false,
          format: 'pcm16',
          sampleRate: 16000,
        }));
        offset += chunkSize;
        setTimeout(sendChunk, 50);
      };

      sendChunk();
    });

    return {
      onChunk: (cb) => chunkCallbacks.push(cb),
      onError: (cb) => errorCallbacks.push(cb),
      onClose: (cb) => closeCallbacks.push(cb),
      close: () => { closed = true; closeCallbacks.forEach((cb) => cb()); },
    };
  }
}

export class TtsServiceImpl implements TtsService {
  private provider: TtsProvider;

  constructor(provider?: TtsProvider) {
    this.provider = provider ?? new MockTtsProvider();
  }

  synthesize(request: TtsRequest): TtsStream {
    return this.provider.synthesize(request);
  }

  getProviderInfo() {
    return {
      name: this.provider.name,
      supportedLanguages: this.provider.supportedLanguages,
    };
  }
}
