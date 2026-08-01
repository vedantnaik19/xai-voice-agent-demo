const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const micBtn = document.getElementById('micBtn');
const transcriptEl = document.getElementById('transcript');
const textForm = document.getElementById('textForm');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');

const INPUT_SAMPLE_RATE = 24000;
const OUTPUT_SAMPLE_RATE = 24000;

let ws = null;
let micStream = null;
let micAudioCtx = null;
let micProcessor = null;
let playbackAudioCtx = null;
let nextPlaybackTime = 0;
let agentLine = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function appendLine(role, text) {
  const line = document.createElement('div');
  line.className = role;
  line.textContent = (role === 'user' ? 'You: ' : 'Agent: ') + text;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return line;
}

function appendToAgentLine(delta) {
  if (!agentLine) agentLine = appendLine('agent', '');
  agentLine.textContent += delta;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// --- WebSocket connection to our proxy server ---

function connect() {
  setStatus('connecting…', 'connecting');
  connectBtn.disabled = true;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    setStatus('connected', 'connected');
    connectBtn.textContent = 'Disconnect';
    connectBtn.disabled = false;
    micBtn.disabled = false;
    textInput.disabled = false;
    sendBtn.disabled = false;

    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE } },
          output: { format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE } },
        },
      },
    }));
  });

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    handleServerEvent(data);
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected', '');
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = false;
    micBtn.disabled = true;
    textInput.disabled = true;
    sendBtn.disabled = true;
    stopMic();
    ws = null;
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'error');
  });
}

function disconnect() {
  ws?.close();
}

function handleServerEvent(event) {
  switch (event.type) {
    case 'response.output_audio_transcript.delta':
      appendToAgentLine(event.delta);
      break;
    case 'response.output_audio.delta':
      playAudioChunk(event.delta);
      break;
    case 'response.done':
      agentLine = null;
      break;
    case 'conversation.item.input_audio_transcription.updated':
      // Cumulative transcript of what the user said.
      break;
    case 'error':
      appendLine('agent', `[error] ${event.message || JSON.stringify(event)}`);
      break;
    default:
      break;
  }
}

// --- Microphone capture (PCM16 @ 24kHz, sent as input_audio_buffer.append) ---

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micAudioCtx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
  const source = micAudioCtx.createMediaStreamSource(micStream);
  micProcessor = micAudioCtx.createScriptProcessor(4096, 1, 1);

  micProcessor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64FromInt16(pcm16),
    }));
  };

  source.connect(micProcessor);
  micProcessor.connect(micAudioCtx.destination);

  micBtn.textContent = '⏹️ Stop mic';
  micBtn.classList.add('active');
}

function stopMic() {
  micProcessor?.disconnect();
  micAudioCtx?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micProcessor = null;
  micAudioCtx = null;
  micStream = null;
  micBtn.textContent = '🎙️ Start mic';
  micBtn.classList.remove('active');
}

function base64FromInt16(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// --- Audio playback (base64 PCM16 @ 24kHz, scheduled back-to-back) ---

function playAudioChunk(base64Audio) {
  if (!playbackAudioCtx) {
    playbackAudioCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    nextPlaybackTime = playbackAudioCtx.currentTime;
  }

  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);

  const buffer = playbackAudioCtx.createBuffer(1, pcm16.length, OUTPUT_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 32768;

  const source = playbackAudioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackAudioCtx.destination);

  const startAt = Math.max(nextPlaybackTime, playbackAudioCtx.currentTime);
  source.start(startAt);
  nextPlaybackTime = startAt + buffer.duration;
}

// --- UI wiring ---

connectBtn.addEventListener('click', () => {
  if (ws) disconnect();
  else connect();
});

micBtn.addEventListener('click', () => {
  if (micStream) stopMic();
  else startMic();
});

textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }));
  ws.send(JSON.stringify({ type: 'response.create' }));

  appendLine('user', text);
  textInput.value = '';
});
