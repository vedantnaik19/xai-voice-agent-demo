// Runs on the audio rendering thread: buffers mic samples and posts
// PCM16 chunks to the main thread instead of the deprecated ScriptProcessorNode.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 2048; // ~85ms of audio at 24kHz
    this.chunk = new Float32Array(this.chunkSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.chunk[this.filled++] = input[i];
      if (this.filled === this.chunkSize) this.flush();
    }
    return true;
  }

  flush() {
    const pcm16 = new Int16Array(this.filled);
    for (let i = 0; i < this.filled; i++) {
      const s = Math.max(-1, Math.min(1, this.chunk[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    this.filled = 0;
  }
}

registerProcessor('mic-processor', MicProcessor);
