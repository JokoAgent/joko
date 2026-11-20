import { openRouterSpeechBaseUrl } from '../models.js';
import type { SpeechAdapter } from './types.js';

export const openaiSpeechAdapter: SpeechAdapter = {
  contentTypes: ['audio/pcm', 'audio/x-pcm', 'application/octet-stream'],
  request(prefix, input) {
    const official = openRouterSpeechBaseUrl(prefix);
    const encoded = official !== undefined && input.modelId.startsWith('minimax/speech-');
    return {
      url: new URL(`${official ?? prefix}/audio/speech`),
      ...(encoded ? { encoding: 'mp3' as const } : {}),
      body: JSON.stringify({
        model: input.modelId,
        voice: input.voice,
        input: input.text,
        response_format: encoded ? 'mp3' : 'pcm',
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    };
  },
  pcm: (body) => body,
};
