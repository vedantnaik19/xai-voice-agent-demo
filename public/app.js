const talkBtn = document.getElementById('talkBtn');
const statusText = document.getElementById('statusText');
const codeView = document.getElementById('codeView');
const talkView = document.getElementById('talkView');
const gateEl = document.getElementById('gate');
const codeInput = document.getElementById('codeInput');
const gateError = document.getElementById('gateError');

const SAMPLE_RATE = 24000;
const CODE_KEY = 'voiceAgentAccessCode';

let ws = null;
let wsOpened = false;
let micStream = null;
let micCtx = null;
let micWorkletNode = null;
let playbackCtx = null;
let nextPlaybackTime = 0;
let scheduledSources = [];

function setStatus(text, cls) {
  statusText.textContent = text;
  talkBtn.className = cls || '';
}

function showGate() {
  codeView.hidden = false;
  talkView.hidden = true;
}

function showTalkView() {
  codeView.hidden = true;
  talkView.hidden = false;
}

if (sessionStorage.getItem(CODE_KEY) !== null) showTalkView();

// --- Start: connect to the proxy (with the access code) + start streaming the mic ---

async function connect(code) {
  talkBtn.disabled = true;
  wsOpened = false;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${location.host}/ws`);
  if (code) url.searchParams.set('code', code);
  ws = new WebSocket(url);

  ws.addEventListener('open', async () => {
    wsOpened = true;

    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
          output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
        },
      },
    }));

    try {
      await startMic();
      setStatus('listening', 'active');
      talkBtn.textContent = 'Stop';
    } catch {
      stop();
    } finally {
      talkBtn.disabled = false;
    }
  });

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'response.output_audio.delta') playAudioChunk(data.delta);
    else if (data.type === 'input_audio_buffer.speech_started') interrupt();
  });

  ws.addEventListener('close', () => {
    if (!wsOpened) {
      // Handshake was rejected before it ever opened - the code is no longer valid.
      sessionStorage.removeItem(CODE_KEY);
      gateError.textContent = 'Invalid code';
      talkBtn.disabled = false;
      ws = null;
      showGate();
      return;
    }
    stop();
  });
  ws.addEventListener('error', () => {});
}

// --- Stop: tear down mic + websocket ---

function stop() {
  ws?.close();
  ws = null;
  stopMic();
  setStatus('disconnected', '');
  talkBtn.textContent = 'Start';
  talkBtn.disabled = false;
}

// --- Microphone capture via AudioWorklet (PCM16 @ 24kHz) ---

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await micCtx.audioWorklet.addModule('mic-worklet.js');

  const source = micCtx.createMediaStreamSource(micStream);
  micWorkletNode = new AudioWorkletNode(micCtx, 'mic-processor');

  micWorkletNode.port.onmessage = (event) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64FromArrayBuffer(event.data),
      }));
    }
  };

  // Route through a silent gain node: keeps the worklet processing without
  // playing the mic back through the speakers (which would cause feedback).
  const silence = micCtx.createGain();
  silence.gain.value = 0;
  source.connect(micWorkletNode).connect(silence).connect(micCtx.destination);
}

function stopMic() {
  micWorkletNode?.port.close();
  micWorkletNode?.disconnect();
  micCtx?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  micWorkletNode = null;
  micCtx = null;
  micStream = null;
}

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// --- Audio playback (base64 PCM16 @ 24kHz, scheduled back-to-back) ---

function playAudioChunk(base64Audio) {
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    nextPlaybackTime = playbackCtx.currentTime;
  }

  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);

  const buffer = playbackCtx.createBuffer(1, pcm16.length, SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 32768;

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);
  scheduledSources.push(source);
  source.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== source);
  };

  const startAt = Math.max(nextPlaybackTime, playbackCtx.currentTime);
  source.start(startAt);
  nextPlaybackTime = startAt + buffer.duration;
}

// Barge-in: the user started talking, so stop whatever the agent is playing/queued.
function interrupt() {
  for (const source of scheduledSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  scheduledSources = [];
  if (playbackCtx) nextPlaybackTime = playbackCtx.currentTime;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'response.cancel' }));
  }
}

// --- UI wiring ---

talkBtn.addEventListener('click', () => {
  if (ws) stop();
  else connect(sessionStorage.getItem(CODE_KEY) || '');
});

gateEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  gateError.textContent = '';
  const submitBtn = gateEl.querySelector('button');
  submitBtn.disabled = true;

  const code = codeInput.value.trim();
  try {
    const res = await fetch(`/api/verify-code?code=${encodeURIComponent(code)}`);
    if (res.ok) {
      sessionStorage.setItem(CODE_KEY, code);
      showTalkView();
    } else {
      gateError.textContent = 'Invalid code';
    }
  } catch {
    gateError.textContent = 'Could not reach server';
  } finally {
    submitBtn.disabled = false;
  }
});
