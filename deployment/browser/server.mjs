#!/usr/bin/env node
// Talk to your agent from a browser tab + Session History dashboard.
//
//   AGENT=ai-voice-intake-scribe npm start
//
// The API key stays in this process; the page only gets 60-second tokens
// and short-lived pre-signed artifact URLs via /api/*.

import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { aai, loadEnv, publishAgent, readAgent, required, storedAgentId } from '../../lib.mjs'

loadEnv()
// Allow demo/preview mode without a real key — UI still renders, session calls will error honestly.
const _hasKey = !!process.env.ASSEMBLYAI_API_KEY
if (!_hasKey) {
  console.warn('ASSEMBLYAI_API_KEY not set — running in demo preview mode (voice & history will be stubbed until a key is set)')
  process.env.ASSEMBLYAI_API_KEY = 'demo-preview-no-key'
}
const AGENT = await (async () => {
  if (!_hasKey) {
    return { id: 'agent_demo_preview', name: 'Riverdale Previsit (demo preview)' }
  }
  const name = process.env.AGENT || 'minimal'
  const known = storedAgentId(name)
  if (known) {
    try {
      const agent = await aai(`/agents/${known}`)
      return { id: known, name: agent.name || 'Your agent' }
    } catch (error) {
      console.error(`Could not load agent ${known}: ${error.message}`)
      process.exit(1)
    }
  }
  const agent = readAgent(name)
  try {
    const { id, created } = await publishAgent(agent, { name, reuseByName: true })
    console.log(`${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`)
    return { id, name: agent.name }
  } catch (error) {
    console.error(`Could not publish agents/${name}.jsonc: ${error.message}`)
    process.exit(1)
  }
})()

console.log(`Agent: ${AGENT.id}`)
const ASSET_V = Date.now().toString(36)

// Records AssemblyAI HTTP tools POST here. In-memory only; a Render restart clears them.
const MAX_RECORDS = 200
const records = { intakes: [], alerts: [] }

function pushRecord(list, item) {
  list.unshift(item)
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

function webhookAuthorized(req) {
  const secret = process.env.INTAKE_WEBHOOK_SECRET
  if (!secret) return true
  const header = req.headers.authorization || ''
  return header === `Bearer ${secret}` || header === secret
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// --- client ----------------------------------------------------------------
// Stringified and served as /app.js.
function clientApp() {
const $ = (id) => document.getElementById(id);
const WIRE_RATE = 24000;
const AGENT = window.AGENT;

const CAPTURE_WORKLET = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ratio = sampleRate / ${WIRE_RATE};
      this._pos = 0;
      this._prev = 0;
      this._src = null;
      this._out = null;
    }
    _toPcm(samples, len) {
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm;
    }
    process(inputs) {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      if (this._ratio === 1) {
        const pcm = this._toPcm(ch, ch.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        return true;
      }
      const n = ch.length;
      if (!this._src || this._src.length < n + 1) {
        this._src = new Float32Array(n + 1);
        this._out = new Float32Array(Math.ceil((n + 1) / this._ratio) + 2);
      }
      const src = this._src;
      const out = this._out;
      src[0] = this._prev;
      src.set(ch, 1);
      let outLen = 0;
      let pos = this._pos;
      while (pos < n) {
        const i = Math.floor(pos);
        const frac = pos - i;
        out[outLen++] = src[i] + (src[i + 1] - src[i]) * frac;
        pos += this._ratio;
      }
      this._pos = pos - n;
      this._prev = ch[n - 1];
      if (outLen) {
        const pcm = this._toPcm(out, outLen);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }
  registerProcessor('capture', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
  class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this._ring = new Float32Array(sampleRate * 30);
      this._writePos = 0;
      this._readPos = 0;
      this._available = 0;
      this._step = ${WIRE_RATE} / sampleRate;
      this._rsPos = 0;
      this._rsPrev = 0;
      this._drained = false;
      this.port.onmessage = (e) => {
        if (e.data === 'stop') {
          this._writePos = this._readPos = this._available = 0;
          this._rsPos = this._rsPrev = 0;
          return;
        }
        const int16 = new Int16Array(e.data);
        if (!int16.length) return;
        if (this._drained) {
          this._rsPrev = 0;
          this._rsPos = 0;
          this._drained = false;
        }
        if (this._step === 1) {
          for (let i = 0; i < int16.length; i++) this._push(int16[i] / 32768);
          return;
        }
        const n = int16.length;
        let pos = this._rsPos;
        while (pos < n) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const a = i === 0 ? this._rsPrev : int16[i - 1] / 32768;
          const b = int16[i] / 32768;
          this._push(a + (b - a) * frac);
          pos += this._step;
        }
        this._rsPos = pos - n;
        this._rsPrev = int16[n - 1] / 32768;
      };
    }
    _push(v) {
      if (this._available < this._ring.length) {
        this._ring[this._writePos] = v;
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._available++;
      }
    }
    process(inputs, outputs) {
      const output = outputs[0];
      const out = output[0];
      const cap = this._ring.length;
      for (let i = 0; i < out.length; i++) {
        if (this._available > 0) {
          out[i] = this._ring[this._readPos];
          this._readPos = (this._readPos + 1) % cap;
          this._available--;
        } else {
          out[i] = 0;
          this._drained = true;
        }
      }
      for (let ch = 1; ch < output.length; ch++) output[ch].set(out);
      return true;
    }
  }
  registerProcessor('playback', PlaybackProcessor);
`;

const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

let ws, captureCtx, playbackCtx, playback, mic, callStart, timer, lastSessionId = null;
let analyser, analyserData, vizRaf, liveReply = null, printedReply = null;
let isMuted = false;
const open = new Map();
function paint(live, final){ const now=performance.now(); if(!final && now-live.painted<100) return; live.painted=now; live.row.querySelector('.count').textContent=live.count>1?'×'+live.count:''; if(live.detail) live.row.querySelector('.detail').textContent=live.detail; }
function logEvent(){ /* kept for compat — original logged to side pane */ }

async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'audioinput').filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
  const select = $('mic');
  if (!select) return;
  const chosen = select.value;
  select.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Default microphone';
  select.append(auto);
  inputs.forEach((device, i) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${i+1}`;
    select.append(option);
  });
  if (chosen && inputs.some(d => d.deviceId === chosen)) select.value = chosen;
}
listMics();
navigator.mediaDevices?.addEventListener?.('devicechange', listMics);

// --- navigation ---
function switchView(name) {
  const views = ['welcome','live','history','review'];
  views.forEach(v => {
    const el = document.getElementById('view-'+v);
    if (el) el.hidden = v !== name;
  });
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.nav === name);
  });
  document.body.dataset.view = name;
  if (name === 'history' && !historyLoaded) {
    historyLoaded = true;
    loadSessions({ reset: true });
  }
  if (name === 'welcome') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const liveRegion = $('a11y-announce');
  if (liveRegion) liveRegion.textContent = name + ' view';
}
window.switchView = switchView;

$('nav-welcome')?.addEventListener('click', (e)=>{ e.preventDefault(); switchView('welcome'); document.getElementById('how-it-works')?.scrollIntoView({behavior:'smooth'}) });
$('nav-history')?.addEventListener('click', (e)=>{ e.preventDefault(); switchView('history'); });
$('nav-try-demo')?.addEventListener('click', (e)=>{ e.preventDefault(); openDemo(); });
$('logo-btn')?.addEventListener('click', ()=> switchView('welcome'));
$('logo-btn')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); switchView('welcome'); }});
$('hero-cta-primary')?.addEventListener('click', ()=> switchView('live'));
$('hero-cta-secondary')?.addEventListener('click', ()=> openDemo());
$('closing-cta')?.addEventListener('click', ()=> switchView('live'));
$('how-cta')?.addEventListener('click', ()=> switchView('live'));
const howDemo = document.getElementById('how-demo');
if (howDemo) howDemo.addEventListener('click', ()=> openDemo());
const demoCard = document.getElementById('demo-interactive-card');
if (demoCard) demoCard.addEventListener('click', ()=> openDemo());
$('history-start-cta')?.addEventListener('click', ()=> switchView('live'));
$('btn-back-history')?.addEventListener('click', ()=> switchView('history'));
$('live-back-welcome')?.addEventListener('click', ()=> switchView('welcome'));
$('postcall-history')?.addEventListener('click', ()=> switchView('history'));
$('postcall-review')?.addEventListener('click', ()=>{
  if (lastSessionId) selectSession(lastSessionId);
  else switchView('history');
});

// sample preview animation
const sampleTurns = [
  { who: 'agent', text: 'What brings you in today?', time: '00:18' },
  { who: 'patient', text: 'My left knee has been sore since Saturday.', time: '00:24' },
];
let sampleIndex = 0;
function animateSample() {
  const el = $('sample-convo');
  if (!el) return;
  el.replaceChildren();
  sampleTurns.slice(0, sampleIndex+1).forEach(t => {
    const row = document.createElement('div');
    row.className = 'sample-line ' + t.who;
    row.innerHTML = `<span class="sample-who">${t.who === 'agent' ? 'Agent' : 'Patient'}</span><span class="sample-text">${t.text}</span><span class="sample-time">${t.time}</span>`;
    el.append(row);
  });
  const reviewQ = $('sample-review-quote');
  if (reviewQ) {
    if (sampleIndex >= 1) {
      reviewQ.textContent = '"My left knee has been sore since Saturday."';
      reviewQ.classList.add('filled');
    } else {
      reviewQ.textContent = 'Exact quote appears here';
      reviewQ.classList.remove('filled');
    }
  }
  if (sampleIndex < sampleTurns.length-1) {
    setTimeout(()=>{ sampleIndex++; animateSample(); }, 1600);
  }
}
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  setTimeout(animateSample, 800);
} else {
  sampleIndex = 1;
  animateSample();
}
$('sample-review-quote')?.addEventListener('click', ()=>{
  const t = document.getElementById('sample-source-hint');
  if (t) { t.hidden = false; }
});
$('sample-review-quote')?.addEventListener('keydown', (e)=>{
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openDemo(); }
});

// acknowledgement checkbox
const ack = $('ack-check');
const btnStart = $('btn');
if (ack && btnStart) {
  const updateAck = ()=>{
    const enabled = ack.checked;
    btnStart.disabled = !enabled || ws?.readyState === 1;
    if (!enabled) btnStart.setAttribute('aria-disabled','true');
    else btnStart.removeAttribute('aria-disabled');
  };
  ack.addEventListener('change', updateAck);
  updateAck();
}

// bind start/end — original logic: if CONNECTING/OPEN then stop, else start
if ($('btn')) $('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start());
$('btn-end')?.addEventListener('click', stop);
$('btn-mute')?.addEventListener('click', toggleMute);
function toggleMute(){
  if (!mic) return;
  isMuted = !isMuted;
  mic.getAudioTracks().forEach(t=> t.enabled = !isMuted);
  const b = $('btn-mute');
  if (b) { b.textContent = isMuted ? 'Unmute' : 'Mute'; b.setAttribute('aria-pressed', String(isMuted)); b.classList.toggle('muted', isMuted); }
  setStatus(isMuted ? 'muted' : (ws?.readyState===1 ? 'listening' : 'idle'), isMuted ? 'Microphone muted' : null);
}

// --- audio helpers ---
async function addWorklet(ctx, code, name) {
  const url = blobUrl(code);
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  return new AudioWorkletNode(ctx, name);
}
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${location.host}/voice`);
}

// --- voice viz ---
function startViz(stream){
  const canvas = $('voice-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyserData = new Uint8Array(analyser.frequencyBinCount);
  const draw = ()=>{
    if (!analyser) return;
    vizRaf = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(analyserData);
    const avg = analyserData.reduce((a,b)=>a+b,0)/analyserData.length;
    const scale = 1 + Math.min(0.35, avg/255*0.5);
    const dot = $('voice-dot');
    if (dot) dot.style.transform = `scale(${scale})`;
    if (ctx) {
      ctx.clearRect(0,0,canvas.width, canvas.height);
      ctx.fillStyle = '#245C4E';
      const barCount = 24;
      const w = canvas.width / barCount;
      for(let i=0;i<barCount;i++){
        const v = analyserData[i*2] || 0;
        const h = (v/255) * canvas.height * 0.9;
        const x = i*w + w*0.15;
        const barW = w*0.7;
        const y = (canvas.height - h)/2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x,y,barW,h,3);
        else ctx.rect(x,y,barW,h);
        ctx.fill();
      }
    }
  };
  draw();
}
function stopViz(){
  if (vizRaf) cancelAnimationFrame(vizRaf);
  vizRaf = null;
  if (analyser) { try{ analyser.disconnect(); }catch{} }
  analyser = null;
  const dot = $('voice-dot');
  if (dot) dot.style.transform = 'scale(1)';
  const canvas = $('voice-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0,0,canvas.width, canvas.height);
  }
}

// --- status mapping honest ---
function setStatus(state, detail){
  const badge = $('live-status-badge');
  const textEl = $('live-status-text');
  const label = $('live-state-label');
  const dot = $('live-dot');
  const viz = $('voice-visual');
  const map = {
    idle: 'Ready when you are.',
    requesting: 'Allow microphone access to continue.',
    connecting: 'Connecting your intake session…',
    connected: 'Your intake session is connected.',
    listening: 'Listening to you…',
    speaking: 'Your intake assistant is speaking…',
    ending: 'Ending the conversation…',
    ended: 'Conversation ended.',
    muted: 'Microphone muted.',
    error: detail || 'Connection error — try again.',
  };
  const text = map[state] || detail || state;
  if (textEl) textEl.textContent = text;
  if (badge) badge.dataset.state = state;
  if (label) label.textContent = text;
  if (dot) dot.dataset.state = state;
  if (viz) { viz.dataset.state = state; viz.classList.remove('speaking','listening','connecting','idle'); viz.classList.add(state); }
  const ann = $('a11y-announce');
  if (ann && state !== 'listening' && state !== 'speaking') ann.textContent = text;
  if (state === 'speaking' || state === 'listening' || state === 'connecting') viz?.classList.add('pulse');
  else viz?.classList.remove('pulse');
}

async function start(){
  const btn = $('btn');
  const btnEnd = $('btn-end');
  if (btn) btn.disabled = true;
  const micSel = $('mic');
  if (micSel) micSel.disabled = true;
  setStatus('requesting');
  try{
    captureCtx = new AudioContext({ sampleRate: WIRE_RATE });
    playbackCtx = new AudioContext({ sampleRate: WIRE_RATE });
    await Promise.all([captureCtx.resume(), playbackCtx.resume()]);
    playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback');
    playback.connect(playbackCtx.destination);
    const deviceId = micSel?.value;
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    listMics();
    startViz(mic);
    const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture');
    captureCtx.createMediaStreamSource(mic).connect(capture);
    setStatus('connecting');
    let ready = false;
    let reconnecting = false;
    let retriedAgentId = false;
    capture.port.onmessage = ({ data }) => {
      if (!ready || !ws || ws.readyState !== 1) return;
      if (isMuted) return;
      const bytes = new Uint8Array(data);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }));
    };
    const attach = (socket, session) => {
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'session.update', session }));
        logEvent('up', 'session.update', session.agent_id || 'inline');
      };
      socket.onmessage = ({ data }) => {
        const msg = JSON.parse(data);
        switch(msg.type){
          case 'session.ready':
            ready = true;
            lastSessionId = msg.session_id;
            callStart = Date.now();
            timer = setInterval(tick, 1000);
            tick();
            setStatus('connected');
            setTimeout(()=> setStatus('listening'), 800);
            if (btn) { btn.disabled = false; btn.textContent = 'End intake'; btn.classList.add('live'); btn.setAttribute('aria-label','End intake'); }
            if (btnEnd) btnEnd.hidden = false;
            if ($('live-session-id')) $('live-session-id').textContent = msg.session_id;
            if ($('live-session-id-mini')) $('live-session-id-mini').textContent = '· ' + msg.session_id.slice(0,8);
            const pc = $('precall-card'); if (pc) pc.hidden = true;
            const post = $('postcall-card'); if (post) post.hidden = true;
            break;
          case 'input.speech.started':
            playback?.port.postMessage('stop');
            setStatus('listening');
            break;
          case 'reply.started':
            setStatus('speaking');
            break;
          case 'reply.audio': {
            const raw = atob(msg.data);
            const bytes = new Uint8Array(raw.length);
            for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
            playback?.port.postMessage(bytes.buffer, [bytes.buffer]);
            break;
          }
          case 'reply.done':
            setStatus('listening');
            if (msg.status === 'interrupted') playback?.port.postMessage('stop');
            break;
          case 'transcript.user.delta':
            partial('you', msg.text);
            break;
          case 'transcript.agent.delta':
            if (msg.reply_id && msg.reply_id === printedReply) break;
            if (msg.reply_id !== liveReply) { liveReply = msg.reply_id; dropPartial('agent'); }
            partial('agent', appendDelta(partialText.agent || '', msg.delta));
            break;
          case 'transcript.user':
            addLine('you', msg.text, null, true);
            break;
          case 'transcript.agent':
            printedReply = msg.reply_id ?? printedReply;
            addLine('agent', msg.text, null, true);
            break;
          case 'tool.call': {
            const args = JSON.stringify(msg.arguments ?? {});
            addLine('tool', `${msg.name}(${args})`, 'tool');
            break;
          }
          case 'session.ended':
            socket.close();
            break;
          case 'session.error': {
            const detail = [msg.code, msg.message, msg.param && ('param=' + msg.param)].filter(Boolean).join(' · ');
            logEvent('down', msg.type, detail);
            if (msg.code === 'agent_not_found' && !retriedAgentId) {
              retriedAgentId = true;
              reconnecting = true;
              logEvent('up', 'retry', 'reconnect via /voice proxy');
              try { socket.close(); } catch {}
              ws = connectSocket();
              reconnecting = false;
              attach(ws, { agent_id: AGENT.id });
              break;
            }
            setStatus('error', msg.message || msg.code || 'Unknown error');
            break;
          }
          default: break;
        }
      };
      socket.onclose = () => {
        if (reconnecting) return;
        setStatus('ended');
        resetCallUI();
        if (historyLoaded) setTimeout(()=> loadSessions({ reset:true }),1500);
        const post = $('postcall-card');
        if (post) {
          post.hidden = false;
          const link = $('postcall-review');
          if (link && lastSessionId) { link.hidden = false; link.textContent = 'Open session review →'; }
          const hist = $('postcall-history');
          if (hist) hist.hidden = false;
        }
        const notice = $('postcall-notice');
        if (notice) notice.textContent = lastSessionId ? 'Your transcript and recording will appear in Session history once processing completes. This can take up to a minute.' : '';
      };
      socket.onerror = () => {
        if (reconnecting) return;
        setStatus('error','Connection failed — check your network and try again.');
        resetCallUI();
      };
    };
    ws = connectSocket();
    attach(ws, { agent_id: AGENT.id });
  }catch(error){
    setStatus('error', error.message || 'Microphone access was denied. Allow microphone in your browser settings and try again.');
    resetCallUI();
  }
}
function stop(){
  setStatus('ending');
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }));
    const socket = ws;
    setTimeout(()=>{ if(socket.readyState===1) socket.close(); }, 3000);
  } else { ws?.close(); }
  setTimeout(()=>{ playback?.port.postMessage('stop'); }, 100);
  mic?.getTracks().forEach(t=>t.stop());
  try{ captureCtx?.close(); }catch{}
  try{ playbackCtx?.close(); }catch{}
  captureCtx = playbackCtx = playback = mic = null;
  stopViz();
  resetCallUI();
  setStatus('ended');
}
function resetCallUI(){
  clearInterval(timer);
  clearPartials();
  isMuted = false;
  const b = $('btn-mute'); if(b){ b.textContent='Mute'; b.classList.remove('muted'); b.setAttribute('aria-pressed','false'); }
  const btn = $('btn');
  if (btn){ const ackOk = !$('ack-check') || $('ack-check').checked; btn.disabled = !ackOk; btn.textContent = 'Start voice intake'; btn.classList.remove('live'); }
  const micSel = $('mic'); if(micSel) micSel.disabled = false;
  const btnEnd = $('btn-end'); if(btnEnd) btnEnd.hidden = true;
  stopViz();
}
function tick(){
  const el = $('live-time-large');
  const small = $('elapsed-mini');
  if (!el && !small) return;
  const seconds = Math.floor((Date.now() - callStart)/1000);
  const txt = Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  if (el) el.textContent = txt;
  if (small) small.textContent = txt;
  const cost = $('cost-mini');
  if (cost) cost.textContent = '$' + (seconds * (4.5/3600)).toFixed(3);
}

// --- transcript ---
const partialText = {};
const partialEl = {};
const ATTACHES_LEFT = /^[.,!?;:%°)\\]}…'"’”]/;
const NO_SPACE_AFTER = /[([{$\\-\\/'"‘“]$/;
function appendDelta(text, delta){
  if(!delta) return text;
  if(!text) return delta;
  if(/^\s/.test(delta) || /\s$/.test(text)) return text+delta;
  if(ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text+delta;
  return text+' '+delta;
}
function dropPartial(who){
  partialEl[who]?.remove(); delete partialEl[who]; delete partialText[who];
}
function transcriptLine(who, text, cls){
  const line = document.createElement('div');
  line.className = 'line ' + who + (cls ? ' ' + cls : '');
  const label = document.createElement('span');
  label.className = 'who';
  label.textContent = who === 'agent' ? 'Intake assistant' : who === 'you' ? 'You' : who;
  const body = document.createElement('span');
  body.className = 'said';
  body.textContent = text;
  line.append(label, body);
  return line;
}
function clearEmpty(el){
  const e = el?.querySelector('.empty');
  if(e) e.remove();
}
function scrollIfNearBottom(el){
  if(!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (near) el.scrollTop = el.scrollHeight;
  const jump = $('jump-latest');
  if (jump) jump.hidden = near;
}
function partial(who, text){
  const trans = $('transcript');
  if(!trans) return;
  clearEmpty(trans);
  partialText[who]=text;
  if(partialEl[who]) partialEl[who].querySelector('.said').textContent=text;
  else { partialEl[who]=transcriptLine(who,text,'partial'); trans.append(partialEl[who]); }
  scrollIfNearBottom(trans);
}
function addLine(who, text, cls, isFinal){
  const trans = $('transcript');
  if(!trans) return;
  clearEmpty(trans);
  dropPartial(who);
  const line = transcriptLine(who,text,cls);
  if (who==='you' || who==='agent') line.dataset.time = new Date().toISOString();
  trans.append(line);
  scrollIfNearBottom(trans);
  if (isFinal) trans.scrollTop = trans.scrollHeight;
}
function clearPartials(){
  for(const who of Object.keys(partialEl)) dropPartial(who);
  liveReply = printedReply = null;
}
$('jump-latest')?.addEventListener('click', ()=>{ const t=$('transcript'); if(t) t.scrollTop=t.scrollHeight; const j=$('jump-latest'); if(j) j.hidden=true; });
$('transcript')?.addEventListener('scroll', ()=>{
  const t=$('transcript'); if(!t) return;
  const near = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  const j=$('jump-latest'); if(j) j.hidden = near;
});

// --- history ---
let historyLoaded = false;
let sessions = [];
let nextCursor = null;
let hasMore = false;
let selectedSession = null;
let allSessionsCache = [];

async function loadSessions({ reset=false }={}){
  const statusEl = $('history-status');
  const skeleton = $('sessions-skeleton');
  const listBody = $('sessions-tbody');
  const cards = $('sessions-cards');
  const empty = $('history-empty');
  const errEl = $('history-error');
  if (reset){ sessions=[]; nextCursor=null; hasMore=false; allSessionsCache=[]; if(listBody) listBody.replaceChildren(); if(cards) cards.replaceChildren(); }
  if (statusEl) statusEl.textContent='Loading sessions…';
  if (skeleton) skeleton.hidden=false;
  if (errEl) errEl.hidden=true;
  if (empty) empty.hidden=true;
  try{
    const params = new URLSearchParams();
    params.set('limit','50');
    params.set('agent_id', AGENT.id);
    const statusFilter = $('filter-status')?.value;
    if (statusFilter) params.set('status', statusFilter);
    if (nextCursor) params.set('cursor', nextCursor);
    const res = await fetch('/api/sessions?'+params.toString());
    if (!res.ok) throw new Error('Failed to list sessions: '+res.status);
    const data = await res.json();
    const incoming = data.sessions || [];
    if (reset) sessions = incoming; else sessions = sessions.concat(incoming);
    allSessionsCache = sessions.slice();
    nextCursor = data.response_metadata?.next_cursor || null;
    hasMore = !!data.has_more;
    renderSessions();
    if (statusEl) statusEl.textContent = `${sessions.length} session(s)${hasMore ? ' — more available' : ''} · Agent ${AGENT.id.slice(0,8)}…`;
    const lm = $('load-more'); if(lm) lm.hidden = !hasMore;
    if (!sessions.length && empty) empty.hidden=false;
  }catch(e){
    if (statusEl) statusEl.textContent='Error: '+e.message;
    if (errEl){ errEl.hidden=false; errEl.textContent='Could not load sessions. '+e.message; }
  }finally{ if(skeleton) skeleton.hidden=true; }
}
function applyHistoryFilters(){
  const q = ($('history-search')?.value || '').toLowerCase().trim();
  const mat = $('filter-material')?.value || '';
  let filtered = allSessionsCache;
  if (q){
    filtered = filtered.filter(s=> (s.id && s.id.toLowerCase().includes(q)) || (s.status && s.status.toLowerCase().includes(q)) || (s.public_close_reason && s.public_close_reason.toLowerCase().includes(q)) );
  }
  if (mat === 'recording'){
    filtered = filtered.filter(s=> (s.artifacts||[]).some(a=>a.type==='audio'));
  } else if (mat === 'transcript'){
    filtered = filtered.filter(s=> (s.artifacts||[]).some(a=>a.type==='timeline') || (s.artifacts||[]).some(a=>a.type==='transcript'));
  }
  filtered = filtered.slice().sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
  sessions = filtered;
  renderSessions();
  const empty = $('history-empty');
  if (empty) empty.hidden = filtered.length!==0;
  const statusEl = $('history-status');
  if (statusEl) statusEl.textContent = `${filtered.length} of ${allSessionsCache.length} loaded sessions`;
}
$('history-search')?.addEventListener('input', applyHistoryFilters);
$('filter-material')?.addEventListener('change', applyHistoryFilters);
function renderSessions(){
  const tbody = $('sessions-tbody');
  const cards = $('sessions-cards');
  if (tbody) tbody.replaceChildren();
  if (cards) cards.replaceChildren();
  if (!sessions.length){
    if (tbody) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted)">No sessions match your filters.</td>`;
      tbody.append(tr);
    }
    return;
  }
  sessions.forEach(s=>{
    const date = new Date(s.created_at);
    const duration = s.duration_seconds ? `${s.duration_seconds.toFixed(1)}s` : '—';
    const mats = [];
    const hasAudio = (s.artifacts||[]).some(a=>a.type==='audio');
    const hasTimeline = (s.artifacts||[]).some(a=>a.type==='timeline');
    if (hasAudio) mats.push('Recording');
    if (hasTimeline) mats.push('Transcript');
    if (!mats.length) mats.push('Processing');
    const statusClass = s.status==='completed' ? 'ok' : s.status==='failed' ? 'err' : 'muted';
    const stateText = s.status==='completed' ? 'Completed call' : s.status;
    if (tbody){
      const tr = document.createElement('tr');
      tr.className = selectedSession?.id===s.id ? 'selected' : '';
      tr.tabIndex = 0;
      tr.setAttribute('role','button');
      tr.setAttribute('aria-label', `Open session ${s.id}`);
      tr.innerHTML = `
        <td><span class="mono">${s.id.slice(0,10)}…</span><div class="muted small">${date.toLocaleDateString()}</div></td>
        <td>${date.toLocaleString()}</td>
        <td>${duration}</td>
        <td>${mats.map(m=>`<span class="badge muted">${m}</span>`).join(' ')}</td>
        <td><span class="badge ${statusClass}">${stateText}</span></td>
        <td><button class="btn-mini" data-action="view">Open review</button></td>
      `;
      const btn = tr.querySelector('[data-action="view"]');
      if (btn) btn.onclick = (e)=>{ e.stopPropagation(); selectSession(s.id); };
      tr.onclick = ()=> selectSession(s.id);
      tr.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); selectSession(s.id); } };
      tbody.append(tr);
    }
    if (cards){
      const card = document.createElement('div');
      card.className = 's-card' + (selectedSession?.id===s.id ? ' selected' : '');
      card.innerHTML = `
        <div class="s-card-head"><span class="mono">${s.id.slice(0,14)}…</span><span class="badge ${statusClass}">${stateText}</span></div>
        <div class="muted small">${date.toLocaleString()} · ${duration}</div>
        <div class="s-card-mats">${mats.map(m=>`<span class="badge muted">${m}</span>`).join('')}</div>
        <button class="btn-mini">Open review</button>
      `;
      const b = card.querySelector('button');
      if (b) b.onclick = ()=> selectSession(s.id);
      cards.append(card);
    }
  });
}

// Demo fixture
const DEMO_SESSION = {
  id: 'demo-synthetic-001',
  synthetic: true,
  status: 'completed',
  created_at: new Date().toISOString(),
  ended_at: new Date(Date.now()+ 187000).toISOString(),
  duration_seconds: 187,
  agent_id: AGENT.id,
  public_close_reason: 'demo',
  artifacts: [{type:'timeline'},{type:'transcript'}],
};
const DEMO_TRANSCRIPT = [
  { role:'agent', text:'Hi, thank you for calling Riverdale. What brings you in today?', time: '00:04', ms: 4000 },
  { role:'user', text:'My left knee has been sore since Saturday.', time:'00:11', ms: 11000 },
  { role:'agent', text:'Thank you for sharing. When did the soreness start, and is it getting better, worse, or staying about the same?', time:'00:16', ms:16000 },
  { role:'user', text:'It started Saturday after a long walk. It feels about the same, maybe a little worse when I stand a long time.', time:'00:24', ms:24000 },
  { role:'agent', text:'I understand. Are there any other symptoms you have noticed?', time:'00:34', ms:34000 },
  { role:'user', text:'Just some stiffness in the morning. No fever.', time:'00:40', ms:40000 },
  { role:'agent', text:'Thank you. What medications are you currently taking?', time:'00:46', ms:46000 },
  { role:'user', text:'I take Lisinopril, 10 milligrams daily.', time:'00:52', ms:52000 },
  { role:'agent', text:'And do you have any known medication allergies?', time:'00:58', ms:58000 },
  { role:'user', text:'Penicillin — it gives me a rash.', time:'01:04', ms:64000 },
  { role:'tool', name:'flag_medical_entity', arguments:{entity_type:'drug', text:'Lisinopril 10 mg', note:'patient reported current medication'}, result:'recorded', ms: 65000 },
  { role:'tool', name:'flag_medical_entity', arguments:{entity_type:'medical_condition', text:'knee pain', note:'left knee sore since Saturday'}, result:'recorded', ms: 66000 },
  { role:'agent', text:'Thank you. I have noted what you shared for the clinician to review. You can end the call when ready.', time:'01:28', ms:88000 },
];
const DEMO_TIMELINE_TURNS = [
  { time:'00:04', agent_text:'Hi, thank you for calling Riverdale. What brings you in today?', user_transcript:'', trigger:'greeting', status:'completed' },
  { time:'00:11', user_transcript:'My left knee has been sore since Saturday.', agent_text:'', user_confidence:0.96 },
  { time:'00:16', agent_text:'Thank you for sharing. When did the soreness start, and is it getting better, worse, or staying about the same?' },
  { time:'00:24', user_transcript:'It started Saturday after a long walk. It feels about the same, maybe a little worse when I stand a long time.' },
  { time:'00:40', user_transcript:'Just some stiffness in the morning. No fever.' },
  { time:'00:52', user_transcript:'I take Lisinopril, 10 milligrams daily.', tool_calls:[{name:'flag_medical_entity', arguments:{entity_type:'drug', text:'Lisinopril 10 mg'}, result:'recorded'}] },
  { time:'01:04', user_transcript:'Penicillin — it gives me a rash.', tool_calls:[{name:'flag_medical_entity', arguments:{entity_type:'medical_condition', text:'penicillin allergy'}, result:'recorded'}] },
];

function openDemo(){
  switchView('review');
  renderDemoReview();
}
window.openDemo = openDemo;
function renderDemoReview(){
  selectedSession = DEMO_SESSION;
  const badge = $('review-badge'); if(badge){ badge.textContent='Demo session · Synthetic patient data'; badge.className='badge amber'; badge.hidden=false; }
  const idEl = $('review-id'); if(idEl) idEl.textContent = DEMO_SESSION.id;
  const dateEl = $('review-date'); if(dateEl) dateEl.textContent = new Date(DEMO_SESSION.created_at).toLocaleString();
  const dur = $('review-duration'); if(dur) dur.textContent = '03:07';
  const start = $('review-started'); if(start) start.textContent = new Date(DEMO_SESSION.created_at).toLocaleString();
  const end = $('review-ended'); if(end) end.textContent = new Date(DEMO_SESSION.ended_at).toLocaleString();
  const rec = $('review-recording-state'); if(rec) rec.textContent = 'Audio unavailable for synthetic demo';
  const mt = $('mat-transcript-state'); if(mt) mt.textContent='Available';
  const mr = $('mat-recording-state'); if(mr) mr.textContent='Unavailable (demo)';
  const ml = $('mat-timeline-state'); if(ml) ml.textContent='Available';
  const mo = $('mat-tools-state'); if(mo) mo.textContent='2 calls';
  const overview = $('review-overview-excerpt'); if(overview) overview.textContent = '"My left knee has been sore since Saturday."';
  const tEl = $('review-transcript');
  if (tEl){
    tEl.replaceChildren();
    DEMO_TRANSCRIPT.forEach((m,i)=>{
      if(m.role==='tool'){
        const row = document.createElement('div');
        row.className='line tool';
        row.innerHTML = `<span class="who">${m.name}</span><span class="said">${escapeHtml(JSON.stringify(m.arguments))} → ${escapeHtml(m.result)}</span>`;
        tEl.append(row);
        return;
      }
      const row = document.createElement('div');
      const isPatient = m.role==='user';
      row.className = 'line ' + (isPatient ? 'you' : 'agent') + ' review-line';
      row.dataset.ms = m.ms;
      row.dataset.time = m.time;
      row.tabIndex = 0;
      row.setAttribute('role','button');
      row.setAttribute('aria-label', `Jump to ${m.time} ${m.role}`);
      const who = isPatient ? 'Patient' : 'Agent';
      row.innerHTML = `<span class="t-time">${m.time}</span><span class="who">${who}</span><span class="said">${escapeHtml(m.text)}</span>`;
      row.addEventListener('click', ()=> highlightAndSeek(m.ms, row));
      row.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); highlightAndSeek(m.ms, row); }});
      tEl.append(row);
    });
    const excerpt = $('review-excerpt-card');
    if (excerpt){
      excerpt.onclick = ()=>{
        const target = tEl.querySelector('[data-time="00:11"]');
        if(target){ target.scrollIntoView({behavior:'smooth', block:'center'}); target.classList.add('highlight'); setTimeout(()=> target.classList.remove('highlight'), 1800); updatePlayerTime(11000); }
      };
    }
  }
  const tl = $('timeline-list');
  if(tl){
    tl.replaceChildren();
    DEMO_TIMELINE_TURNS.forEach((turn,i)=>{
      const div = document.createElement('div');
      div.className='t-turn';
      div.innerHTML = `<div class="t-head">#${i+1} ${turn.trigger?'<span class="badge muted">'+turn.trigger+'</span>':''} <span class="badge ${turn.status==='completed'?'ok':''}">${turn.status||'completed'}</span></div>${turn.user_transcript?'<div class="t-user">'+escapeHtml(turn.user_transcript)+'</div>':''}${turn.agent_text?'<div class="t-agent">'+escapeHtml(turn.agent_text)+'</div>':''}${(turn.tool_calls||[]).map(tc=>'<div class="t-tool">↳ '+escapeHtml(tc.name)+' '+escapeHtml(JSON.stringify(tc.arguments))+'</div>').join('')}`;
      tl.append(div);
    });
  }
  const tools = $('tools-list');
  if(tools){
    tools.replaceChildren();
    const toolMsgs = DEMO_TRANSCRIPT.filter(m=>m.role==='tool');
    if(!toolMsgs.length) tools.innerHTML='<div class="empty">No tool calls</div>';
    else toolMsgs.forEach(m=>{
      const c=document.createElement('div'); c.className='tool-card';
      c.innerHTML = `<div class="tool-name">${m.name}</div><div class="tool-args"><strong>Args:</strong><pre>${escapeHtml(JSON.stringify(m.arguments,null,2))}</pre></div><div class="tool-result"><strong>Result:</strong><pre>${escapeHtml(m.result)}</pre></div>`;
      tools.append(c);
    });
  }
  const playerState = $('player-state');
  if(playerState) playerState.textContent='Demo session — recording unavailable. Transcript navigation is fully functional.';
  const audio = $('review-audio');
  if(audio){ audio.removeAttribute('src'); audio.pause(); const b=$('player-play'); if(b) b.disabled=true; }
  updatePlayerTime(0);
  const metaPre = $('metadata-pre'); if(metaPre) metaPre.textContent = JSON.stringify({ demo:true, synthetic:true, note:'Synthetic patient data for demonstration. No real PHI.' }, null, 2);
  const rawPre = $('raw-pre'); if(rawPre) rawPre.textContent = JSON.stringify(DEMO_SESSION, null, 2);
}
function highlightAndSeek(ms, row){
  document.querySelectorAll('.review-line.highlight').forEach(el=> el.classList.remove('highlight'));
  if(row) row.classList.add('highlight');
  updatePlayerTime(ms);
  const audio = $('review-audio');
  if(audio && audio.duration && !isNaN(audio.duration)){
    const sec = ms/1000;
    if(sec <= audio.duration) audio.currentTime = sec;
    audio.play().catch(()=>{});
  }
}
function updatePlayerTime(ms){
  const cur = $('player-cur');
  const tot = $('player-tot');
  const fill = $('player-fill');
  const thumb = $('player-thumb');
  const bar = $('player-bar');
  const totalMs = selectedSession?.synthetic ? 187000 : (audioDurationMs || 187000);
  const pct = Math.min(100, (ms/totalMs)*100);
  if(cur) cur.textContent = fmtTime(ms/1000);
  if(tot) tot.textContent = fmtTime(totalMs/1000);
  if(fill) fill.style.width = pct+'%';
  if(thumb) thumb.style.left = pct+'%';
  if(bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));
}
function fmtTime(s){
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60);
  return m+':'+String(sec).padStart(2,'0');
}
let audioDurationMs = 0;

// --- real session review ---
async function selectSession(sessionId){
  if(sessionId === DEMO_SESSION.id){ openDemo(); return; }
  switchView('review');
  const detailEl = $('review-transcript');
  if(detailEl) detailEl.innerHTML='<div class="empty">Loading session '+escapeHtml(sessionId)+'…</div>';
  const badge = $('review-badge'); if(badge){ badge.textContent='Live session'; badge.className='badge ok'; badge.hidden=false; }
  const idEl = $('review-id'); if(idEl) idEl.textContent=sessionId;
  try{
    const res = await fetch('/api/sessions/'+sessionId);
    if(!res.ok) throw new Error('Failed to fetch session: '+res.status);
    const session = await res.json();
    selectedSession = session;
    renderSessions();
    let transcript=null, timeline=null, audioUrl=null, metadata=null;
    try{ const r=await fetch('/api/sessions/'+sessionId+'/transcript'); if(r.ok) transcript=await r.json(); }catch{}
    try{ const r=await fetch('/api/sessions/'+sessionId+'/timeline'); if(r.ok) timeline=await r.json(); }catch{}
    try{ const r=await fetch('/api/sessions/'+sessionId+'/audio'); if(r.ok){ const d=await r.json(); audioUrl=d.url; } }catch{}
    try{ const r=await fetch('/api/sessions/'+sessionId+'/metadata'); if(r.ok) metadata=await r.json(); }catch{}
    renderSessionDetail(session, { transcript, timeline, audioUrl, metadata });
  }catch(e){
    if(detailEl) detailEl.innerHTML='<div class="empty" style="color:var(--danger)">Error: '+escapeHtml(e.message)+'</div>';
  }
}
window.selectSession = selectSession;
function renderSessionDetail(session, { transcript, timeline, audioUrl, metadata }){
  const created = new Date(session.created_at).toLocaleString();
  const ended = session.ended_at ? new Date(session.ended_at).toLocaleString() : '—';
  const duration = session.duration_seconds ? session.duration_seconds.toFixed(1)+'s' : '—';
  const startEl = $('review-started'); if(startEl) startEl.textContent = created;
  const endEl = $('review-ended'); if(endEl) endEl.textContent = ended;
  const durEl = $('review-duration'); if(durEl) durEl.textContent = duration;
  const recEl = $('review-recording-state'); if(recEl) recEl.textContent = audioUrl ? 'Available' : 'Processing or unavailable';
  const dateEl = $('review-date'); if(dateEl) dateEl.textContent = created;
  const mt = $('mat-transcript-state'); if(mt) mt.textContent = (transcript && transcript.messages && transcript.messages.length) ? 'Available' : '—';
  const mr = $('mat-recording-state'); if(mr) mr.textContent = audioUrl ? 'Available' : '—';
  const ml = $('mat-timeline-state'); if(ml) ml.textContent = timeline ? 'Available' : '—';
  const mo = $('mat-tools-state'); if(mo) mo.textContent = transcript ? String(transcript.messages.filter(m=>m.role==='tool').length)+' calls' : '—';
  const tEl = $('review-transcript');
  if(tEl){
    tEl.replaceChildren();
    if(!transcript || !transcript.messages || !transcript.messages.length){
      tEl.innerHTML='<div class="empty">No transcript yet (session active or empty). Audio and timeline appear after processing completes.</div>';
    } else {
      transcript.messages.forEach((m, idx)=>{
        if(m.role==='tool'){
          const row=document.createElement('div');
          row.className='line tool';
          row.innerHTML = `<span class="who">${escapeHtml(m.name)}</span><span class="said">${escapeHtml(JSON.stringify(m.arguments))} → ${escapeHtml(typeof m.result==='string'? m.result.slice(0,500): JSON.stringify(m.result))}</span>`;
          tEl.append(row);
          return;
        }
        const who = m.role==='user' ? 'you' : 'agent';
        const label = m.role==='user' ? 'Patient' : 'Intake assistant';
        const row=document.createElement('div');
        row.className='line '+who+' review-line';
        row.dataset.idx = idx;
        const ms = m.dispatched_at_ms || m.time_to_first_audio_ms || idx*5000;
        row.dataset.ms = ms;
        row.tabIndex=0;
        row.setAttribute('role','button');
        const timeLabel = ms ? fmtTime(ms/1000) : '--:--';
        row.innerHTML = `<span class="t-time">${timeLabel}</span><span class="who">${label}</span><span class="said">${escapeHtml(m.text)}</span>`;
        row.addEventListener('click', ()=> highlightAndSeek(ms, row));
        row.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); highlightAndSeek(ms,row); }});
        tEl.append(row);
      });
      const searchInput = $('review-transcript-search');
      if(searchInput){
        const q = searchInput.value.toLowerCase().trim();
        if(q){
          tEl.querySelectorAll('.said').forEach(s=>{
            if(s.textContent.toLowerCase().includes(q)) s.closest('.review-line')?.classList.add('highlight');
          });
        }
      }
    }
  }
  const audio = $('review-audio');
  const playerState = $('player-state');
  const playBtn = $('player-play');
  if(audio){
    if(audioUrl){
      audio.src = audioUrl;
      audio.hidden = false;
      audio.controls = false;
      audioDurationMs = session.duration_seconds ? session.duration_seconds*1000 : 0;
      audio.onloadedmetadata = ()=>{ audioDurationMs = audio.duration*1000; updatePlayerTime(0); if(playerState) playerState.textContent='Stereo: left=patient, right=assistant • OGG/Opus • URL expires soon, refresh to renew'; if(playBtn) playBtn.disabled=false; };
      audio.ontimeupdate = ()=>{
        const curMs = audio.currentTime*1000;
        updatePlayerTime(curMs);
        highlightByTime(curMs);
      };
      audio.onplay = ()=>{ if(playBtn) playBtn.textContent='⏸'; };
      audio.onpause = ()=>{ if(playBtn) playBtn.textContent='▶'; };
      if(playBtn){
        playBtn.disabled=false;
        playBtn.textContent='▶';
        playBtn.onclick = ()=>{
          if(audio.paused) audio.play().catch(()=>{});
          else audio.pause();
        };
      }
      const bar = $('player-bar');
      if(bar){
        const seek = (e)=>{
          const rect = bar.getBoundingClientRect();
          const pct = (e.clientX - rect.left)/rect.width;
          if(audio.duration) audio.currentTime = pct * audio.duration;
        };
        bar.onclick = seek;
        bar.onkeydown = (e)=>{
          if(e.key==='ArrowLeft'){ audio.currentTime = Math.max(0, audio.currentTime-5); e.preventDefault(); }
          if(e.key==='ArrowRight'){ audio.currentTime = Math.min(audio.duration, audio.currentTime+5); e.preventDefault(); }
          if(e.key==='Home'){ audio.currentTime=0; e.preventDefault(); }
          if(e.key==='End'){ audio.currentTime=audio.duration; e.preventDefault(); }
        };
      }
      if(playerState) playerState.textContent='Loading recording…';
      updatePlayerTime(0);
    } else {
      audio.removeAttribute('src');
      audio.pause();
      audio.hidden = true;
      if(playerState) playerState.textContent = session.status==='active' ? 'No audio artifact yet — session still active.' : 'Recording unavailable or still processing. Refresh to check again.';
      if(playBtn) { playBtn.disabled = true; playBtn.textContent='▶'; }
      updatePlayerTime(0);
    }
  }
  const tl = $('timeline-list');
  if(tl){
    tl.replaceChildren();
    if(!timeline || !timeline.turns || !timeline.turns.length){
      tl.innerHTML='<div class="empty">No timeline artifact yet.</div>';
    } else {
      timeline.turns.forEach((turn,i)=>{
        const div=document.createElement('div');
        div.className='t-turn';
        const user = turn.user_transcript ? `<div class="t-user">${escapeHtml(turn.user_transcript)} <span class="muted">${turn.user_confidence? (turn.user_confidence*100).toFixed(0)+'%':''}</span></div>` : '';
        const agent = turn.agent_text ? `<div class="t-agent">${escapeHtml(turn.agent_text)}</div>` : '';
        const tools = (turn.tool_calls||[]).map(tc=>`<div class="t-tool">↳ ${escapeHtml(tc.name)} ${escapeHtml(JSON.stringify(tc.arguments))} → ${escapeHtml((tc.result||'').slice(0,300))}</div>`).join('');
        const trigger = turn.trigger ? `<span class="badge muted">${turn.trigger}</span>`: '';
        const status = turn.status ? `<span class="badge ${turn.status==='completed'?'ok':'err'}">${turn.status}</span>`:'';
        div.innerHTML = `<div class="t-head">#${i+1} ${trigger} ${status} <span class="muted">${turn.time_to_first_audio_ms? turn.time_to_first_audio_ms+'ms to first audio':''}</span></div>${user}${tools}${agent}`;
        tl.append(div);
      });
    }
  }
  const tlist = $('tools-list');
  if(tlist){
    tlist.replaceChildren();
    const toolMsgs = transcript ? transcript.messages.filter(m=>m.role==='tool') : [];
    if(!toolMsgs.length) tlist.innerHTML='<div class="empty">No tool calls in this session.</div>';
    else toolMsgs.forEach(m=>{
      const c=document.createElement('div'); c.className='tool-card';
      c.innerHTML = `<div class="tool-name">${escapeHtml(m.name)} ${m.error?'<span class="badge err">error</span>':''}</div><div class="tool-args"><strong>Args:</strong><pre>${escapeHtml(JSON.stringify(m.arguments,null,2))}</pre></div><div class="tool-result"><strong>Result:</strong><pre>${escapeHtml(typeof m.result==='string'? m.result: JSON.stringify(m.result,null,2))}</pre></div>`;
      tlist.append(c);
    });
  }
  const metaPre = $('metadata-pre');
  if(metaPre) metaPre.textContent = JSON.stringify(metadata || session.config || {}, null, 2);
  const rawPre = $('raw-pre');
  if(rawPre) rawPre.textContent = JSON.stringify(session, null, 2);
  // excerpt quote from first patient line if available
  const excerptQ = $('review-overview-excerpt');
  if(excerptQ && transcript && transcript.messages){
    const firstUser = transcript.messages.find(m=>m.role==='user');
    if(firstUser) excerptQ.textContent = `"${firstUser.text}"`;
  }
  const excerptCard = $('review-excerpt-card');
  if(excerptCard){
    excerptCard.onclick = ()=>{
      const first = tEl.querySelector('.review-line');
      if(first){ first.scrollIntoView({behavior:'smooth', block:'center'}); first.classList.add('highlight'); setTimeout(()=>first.classList.remove('highlight'),1800); const ms=parseInt(first.dataset.ms||'0',10); highlightAndSeek(ms, first); }
    };
  }
  const delBtn = $('btn-delete-session');
  if(delBtn){
    delBtn.onclick = async ()=>{
      if(!confirm('Delete this session?\n\n'+session.id+'\nDuration: '+duration+'\nStatus: '+session.status+'\n\nThis calls DELETE /v1/sessions/:id via the server proxy.')) return;
      try{
        const res = await fetch('/api/sessions/'+session.id, { method:'DELETE' });
        if(res.status===204 || res.ok){ alert('Deleted'); switchView('history'); loadSessions({reset:true}); }
        else { const txt=await res.text(); alert('Delete failed: '+txt); }
      }catch(e){ alert('Delete error: '+e.message); }
    };
  }
  const refreshBtn = $('btn-refresh-detail');
  if(refreshBtn) refreshBtn.onclick = ()=> selectSession(session.id);
}
function highlightByTime(ms){
  const lines = document.querySelectorAll('.review-line[data-ms]');
  let active = null;
  lines.forEach(l=>{
    const t = parseInt(l.dataset.ms,10);
    if(t <= ms) active = l;
    l.classList.remove('playing');
  });
  if(active) active.classList.add('playing');
}
function escapeHtml(s){
  if(s==null) return '';
  return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
$('review-transcript-search')?.addEventListener('input', ()=>{
  const q = ($('review-transcript-search').value||'').toLowerCase().trim();
  document.querySelectorAll('.review-line').forEach(l=>{
    l.classList.remove('highlight');
    if(q && l.textContent.toLowerCase().includes(q)) l.classList.add('highlight');
  });
});
$('btn-refresh-history')?.addEventListener('click', ()=> loadSessions({reset:true}));
$('load-more')?.addEventListener('click', ()=> loadSessions({reset:false}));
$('filter-status')?.addEventListener('change', ()=> loadSessions({reset:true}));

// keyboard for header
document.addEventListener('keydown', (e)=>{
  if(e.key==='Escape' && document.body.dataset.view==='review'){
    switchView('history');
  }
});
// init
switchView('welcome');
const transEl = $('transcript');
if(transEl){
  const obs = new MutationObserver(()=>{
    const hasContent = transEl.querySelector('.line');
    const fallback = $('live-fallback');
    if(fallback) fallback.hidden = !!hasContent || ws?.readyState===1;
  });
  obs.observe(transEl, {childList:true});
}
// hero voice subtle pulse
const hv = document.getElementById('hero-voice');
if (hv && !window.matchMedia('(prefers-reduced-motion: reduce)').matches){
  hv.classList.add('pulse');
}
}


// --- page ------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Riverdale Previsit — An IntakeScribe experience</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap" rel="stylesheet">
<style>
  :root{
    --page-bg:#F7F8F4;
    --text:#173A34;
    --text-muted:#596B65;
    --text-faint:#8A9A94;
    --primary:#245C4E;
    --primary-hover:#1D4A3F;
    --primary-soft:#E8EFE8;
    --surface:#FFFFFF;
    --border:#E0E6DE;
    --border-strong:#C8D6C4;
    --amber:#F59E0B;
    --amber-bg:#FFFBEB;
    --amber-border:#FDE68A;
    --danger:#BA3A3A;
    --danger-bg:#FEF2F2;
    --danger-border:#FECACA;
    --ok:#1A7F3D;
    --ok-bg:#ECFDF5;
    --radius-card:22px;
    --radius-control:12px;
    --shadow:0 1px 3px rgba(23,58,52,0.06), 0 8px 24px rgba(23,58,52,0.06);
    --shadow-hover:0 4px 16px rgba(23,58,52,0.10), 0 12px 32px rgba(23,58,52,0.10);
    --font-display:"Newsreader", Georgia, serif;
    --font-body:"Inter", system-ui, -apple-system, sans-serif;
    --font-mono:ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    font-family:var(--font-body); font-size:16px; line-height:1.5;
    color:var(--text); background:var(--page-bg);
    -webkit-font-smoothing:antialiased;
  }
  a{color:var(--primary); text-decoration:none}
  a:hover{text-decoration:underline}
  button{font:inherit}
  [hidden]{display:none !important}
  .site-header{
    position:sticky; top:0; z-index:40;
    background:rgba(247,248,244,0.92); backdrop-filter:blur(10px);
    border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:16px;
    padding:14px 24px; max-width:1280px; margin:0 auto; width:100%;
  }
  .brand{
    display:flex; align-items:center; gap:12px; cursor:pointer; flex-shrink:0;
  }
  .brand-mark{
    width:36px; height:36px; border-radius:10px; background:var(--primary); color:white;
    display:grid; place-items:center; font-family:var(--font-display); font-weight:600; font-size:18px;
  }
  .brand-text{line-height:1}
  .brand-title{font-family:var(--font-display); font-weight:600; font-size:17px; letter-spacing:-0.3px; color:var(--text)}
  .brand-sub{font-size:10px; letter-spacing:0.9px; text-transform:uppercase; color:var(--text-muted); margin-top:2px; font-weight:500}
  .nav-links{margin-left:auto; display:flex; align-items:center; gap:20px}
  .nav-link{font-size:13px; font-weight:500; color:var(--text-muted); background:none; border:none; cursor:pointer; padding:6px 0; letter-spacing:-0.1px}
  .nav-link:hover{color:var(--text)}
  .nav-link.on{color:var(--text); border-bottom:2px solid var(--primary); padding-bottom:4px}
  .btn-primary{
    background:var(--primary); color:white; border:none; border-radius:999px;
    height:40px; padding:0 20px; font-size:13px; font-weight:600; letter-spacing:0.2px; cursor:pointer;
    transition:background .15s, transform .1s; display:inline-flex; align-items:center; gap:8px; white-space:nowrap;
  }
  .btn-primary:hover{background:var(--primary-hover); transform:translateY(-1px)}
  .btn-primary:disabled{opacity:0.55; cursor:default; transform:none}
  .btn-secondary{
    background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:999px;
    height:40px; padding:0 20px; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:8px; white-space:nowrap;
  }
  .btn-secondary:hover{border-color:var(--border-strong); background:var(--primary-soft)}
  .btn-ghost{background:none; border:1px solid var(--border); border-radius:999px; height:36px; padding:0 14px; font-size:12px; font-weight:600; color:var(--text); cursor:pointer}
  .btn-ghost:hover{background:var(--surface)}
  .btn-mini{height:32px; padding:0 14px; font-size:12px; font-weight:600; border-radius:999px; border:1px solid var(--border); background:var(--surface); cursor:pointer}
  .btn-mini:hover{border-color:var(--border-strong)}
  .btn-mini.danger{background:var(--danger); color:white; border-color:var(--danger)}
  .page{max-width:1280px; margin:0 auto; padding:0 24px}
  .view{padding:28px 0 40px}
  .hero{
    display:grid; grid-template-columns:1.05fr 0.95fr; gap:40px; align-items:center;
    padding:32px 0 24px;
  }
  .eyebrow{font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:var(--text-muted); font-weight:600; margin-bottom:16px}
  .hero-title{
    font-family:var(--font-display); font-weight:500; line-height:0.95; letter-spacing:-1.6px;
    font-size:clamp(38px, 5.8vw, 62px); color:var(--text); margin-bottom:20px;
  }
  .hero-title span{display:block}
  .hero-sub{font-size:17px; line-height:1.6; color:var(--text-muted); max-width:46ch; margin-bottom:24px}
  .hero-ctas{display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px}
  .hero-meta{display:flex; gap:14px; flex-wrap:wrap; font-size:11px; letter-spacing:0.6px; text-transform:uppercase; color:var(--text-muted); font-weight:600}
  .hero-meta span{display:inline-flex; align-items:center; gap:6px}
  .hero-meta span::before{content:""; width:6px; height:6px; border-radius:50%; background:var(--primary); opacity:0.6}
  .safety{margin-top:18px; font-size:12px; line-height:1.5; color:var(--text-muted); background:var(--amber-bg); border:1px solid var(--amber-border); border-radius:12px; padding:10px 14px; max-width:54ch}
  .hero-card{
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-card); box-shadow:var(--shadow);
    overflow:hidden; display:flex; flex-direction:column;
  }
  .hero-card-head{padding:16px 20px 12px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between}
  .hero-card-head strong{font-size:12px; letter-spacing:0.8px; text-transform:uppercase; color:var(--text-muted)}
  .hero-card-head span{font-size:11px; color:var(--text-faint)}
  .sample-visual{padding:20px; display:grid; place-items:center; background:linear-gradient(180deg, var(--primary-soft) 0%, white 100%); border-bottom:1px solid var(--border)}
  .voice-visual{position:relative; width:96px; height:96px; display:grid; place-items:center}
  .voice-dot{width:54px; height:54px; border-radius:50%; background:var(--primary); position:relative; z-index:2; transition:transform .12s}
  .voice-ring, .voice-ring2{position:absolute; inset:0; border-radius:50%; border:1px solid rgba(36,92,78,0.18)}
  .voice-ring2{inset:10px; border-color:rgba(36,92,78,0.12)}
  .voice-visual.pulse .voice-dot{animation:pulseDot 1.6s ease-in-out infinite}
  .voice-visual.pulse .voice-ring{animation:ping 1.8s ease-out infinite}
  .voice-visual.pulse .voice-ring2{animation:ping 1.8s ease-out infinite 0.4s}
  @keyframes pulseDot{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
  @keyframes ping{0%{transform:scale(0.9); opacity:1}100%{transform:scale(1.15); opacity:0}}
  .sample-convo{padding:16px 20px; display:flex; flex-direction:column; gap:12px; min-height:160px}
  .sample-line{display:flex; gap:12px; font-size:13.5px; line-height:1.4}
  .sample-line .sample-who{width:54px; flex-shrink:0; font-size:10px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-faint); font-weight:600; padding-top:3px}
  .sample-line.agent .sample-text{color:var(--text)}
  .sample-line.patient .sample-text{color:var(--text); font-weight:500}
  .sample-line .sample-time{margin-left:auto; font-size:11px; color:var(--text-faint); font-variant-numeric:tabular-nums}
  .sample-review{margin:0 20px 16px; background:var(--primary-soft); border:1px solid var(--border); border-radius:14px; padding:14px}
  .sample-review-label{font-size:11px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted); font-weight:600; margin-bottom:6px}
  .sample-review-quote{font-size:13.5px; color:var(--text-muted); font-style:italic; cursor:pointer}
  .sample-review-quote.filled{color:var(--text)}
  .sample-review-foot{margin-top:8px; font-size:11px; color:var(--text-faint); display:flex; justify-content:space-between}
  #sample-source-hint{font-size:12px; color:var(--primary); background:var(--primary-soft); border-radius:8px; padding:6px 10px; margin-top:6px}
  .hero-card-foot{padding:12px 20px; background:var(--page-bg); border-top:1px solid var(--border); display:flex; justify-content:space-between; font-size:11px; letter-spacing:0.6px; text-transform:uppercase; color:var(--text-muted); font-weight:600}
  .section{padding:56px 0; border-top:1px solid var(--border)}
  .section-head{max-width:640px; margin-bottom:28px}
  .section-head h2{font-family:var(--font-display); font-weight:500; font-size:32px; letter-spacing:-0.8px; margin-bottom:8px}
  .section-head p{color:var(--text-muted); line-height:1.6}
  .how-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:20px}
  .how-card{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:22px; box-shadow:var(--shadow)}
  .how-num{width:32px; height:32px; border-radius:50%; background:var(--primary); color:white; display:grid; place-items:center; font-size:13px; font-weight:700; margin-bottom:12px}
  .how-card h3{font-size:16px; font-weight:600; margin-bottom:6px}
  .how-card p{font-size:13.5px; color:var(--text-muted); line-height:1.5}
  .interactive-sample{background:var(--surface); border:1px solid var(--border); border-radius:22px; padding:24px; display:grid; grid-template-columns:1fr 1fr; gap:24px; box-shadow:var(--shadow)}
  .built-card{background:var(--surface); border:1px solid var(--border); border-radius:22px; padding:24px; box-shadow:var(--shadow); display:flex; gap:20px; align-items:flex-start}
  .built-icon{width:48px; height:48px; border-radius:12px; background:var(--primary-soft); display:grid; place-items:center; flex-shrink:0}
  .closing{ text-align:center; padding:48px 20px; background:var(--surface); border:1px solid var(--border); border-radius:22px; box-shadow:var(--shadow);}
  .closing h2{font-family:var(--font-display); font-size:30px; font-weight:500; letter-spacing:-0.6px; margin-bottom:8px}
  .live-shell{background:var(--surface); border:1px solid var(--border); border-radius:22px; box-shadow:var(--shadow); overflow:hidden; display:flex; flex-direction:column}
  .live-top{display:flex; align-items:center; gap:14px; padding:14px 20px; border-bottom:1px solid var(--border); background:var(--page-bg); flex-wrap:wrap}
  .live-top strong{font-size:13px; letter-spacing:0.6px; text-transform:uppercase; color:var(--text-muted)}
  .live-status{margin-left:auto; display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; color:var(--text-muted); background:white; border:1px solid var(--border); border-radius:999px; padding:6px 12px}
  .live-dot{width:8px; height:8px; border-radius:50%; background:var(--text-faint)}
  .live-dot[data-state="listening"], .live-dot[data-state="speaking"], .live-dot[data-state="connected"]{background:var(--ok)}
  .live-dot[data-state="error"]{background:var(--danger)}
  .live-dot[data-state="connecting"]{background:var(--amber); animation:blink 1s infinite}
  @keyframes blink{50%{opacity:0.3}}
  .live-grid{display:grid; grid-template-columns:360px 1fr; min-height:520px}
  .live-visual-col{border-right:1px solid var(--border); padding:24px; display:flex; flex-direction:column; align-items:center; gap:16px; background:linear-gradient(180deg, white 0%, var(--primary-soft) 100%)}
  .live-timer-big{font-variant-numeric:tabular-nums; font-size:42px; font-weight:600; letter-spacing:-1px; color:var(--text)}
  .live-state{font-size:12px; font-weight:600; color:var(--text-muted); text-align:center; min-height:18px}
  .live-controls{display:flex; gap:8px; flex-wrap:wrap; justify-content:center; width:100%}
  .live-controls select{height:40px; border-radius:999px; border:1px solid var(--border); padding:0 12px; font-size:13px; color:var(--text-muted); background:white; flex:1; min-width:160px}
  .precall-card{width:100%; background:white; border:1px solid var(--border); border-radius:16px; padding:16px; text-align:left}
  .precall-card h4{font-size:13px; margin-bottom:8px}
  .precall-card ul{padding-left:18px; font-size:13px; color:var(--text-muted); line-height:1.6}
  .precall-card label{display:flex; gap:8px; align-items:flex-start; font-size:12px; color:var(--text-muted); margin-top:12px; cursor:pointer}
  .precall-card input{margin-top:3px}
  .wave-canvas{width:100%; height:48px; border-radius:10px; background:white; border:1px solid var(--border)}
  .live-convo-col{display:flex; flex-direction:column; min-height:0; position:relative; background:white}
  .convo-head{display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--border); font-size:12px; letter-spacing:0.6px; text-transform:uppercase; color:var(--text-muted); font-weight:600}
  .transcript{flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:14px; scroll-behavior:smooth; min-height:300px}
  .transcript .empty{color:var(--text-faint); font-size:13.5px; line-height:1.6}
  .line{display:flex; gap:14px; font-size:14.5px; line-height:1.5; padding:10px 12px; border-radius:12px; transition:background .15s}
  .line.you{background:var(--primary-soft); border:1px solid var(--border)}
  .line.agent{background:white; border:1px solid var(--border)}
  .line.tool{font-family:var(--font-mono); font-size:12px; color:var(--primary); background:var(--primary-soft)}
  .line.partial{opacity:0.7; border-style:dashed}
  .line.highlight{background:#FFF7D6 !important; border-color:#FDE68A !important}
  .line.playing{background:#ECFDF5 !important; border-color:#A7F3D0 !important}
  .who{width:84px; flex-shrink:0; font-size:10px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-faint); font-weight:700; padding-top:4px}
  .said{flex:1}
  .t-time{width:40px; flex-shrink:0; font-size:11px; color:var(--text-faint); font-variant-numeric:tabular-nums; padding-top:3px}
  .jump-latest{position:absolute; bottom:70px; left:50%; transform:translateX(-50%); background:var(--text); color:white; border:none; border-radius:999px; height:32px; padding:0 14px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 6px 16px rgba(0,0,0,0.12)}
  .fallback{padding:12px 20px; font-size:13px; color:var(--text-muted); background:var(--amber-bg); border-top:1px solid var(--amber-border)}
  .live-foot{display:flex; gap:12px; padding:10px 20px; background:var(--page-bg); border-top:1px solid var(--border); font-size:11px; letter-spacing:0.6px; text-transform:uppercase; color:var(--text-muted); font-weight:600; flex-wrap:wrap}
  .postcall{margin-top:16px; background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:20px; box-shadow:var(--shadow); display:flex; gap:20px; align-items:center; flex-wrap:wrap}
  .postcall strong{font-size:16px}
  .postcall p{font-size:13px; color:var(--text-muted)}
  .history-head{display:flex; flex-direction:column; gap:16px; margin-bottom:20px}
  .history-head h2{font-family:var(--font-display); font-size:28px; font-weight:500; letter-spacing:-0.6px}
  .history-controls{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
  .history-controls input{height:40px; border-radius:999px; border:1px solid var(--border); padding:0 16px; font-size:13px; background:white; flex:1; min-width:220px; max-width:360px}
  .history-controls select{height:40px; border-radius:999px; border:1px solid var(--border); padding:0 12px; font-size:13px; background:white; color:var(--text-muted)}
  .history-table-wrap{background:var(--surface); border:1px solid var(--border); border-radius:22px; box-shadow:var(--shadow); overflow:hidden}
  .history-table{width:100%; border-collapse:collapse; font-size:13.5px}
  .history-table th{text-align:left; font-size:11px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted); font-weight:700; padding:14px 16px; background:var(--page-bg); border-bottom:1px solid var(--border)}
  .history-table td{padding:14px 16px; border-bottom:1px solid var(--border); vertical-align:middle}
  .history-table tr{transition:background .12s}
  .history-table tr:hover{background:var(--primary-soft)}
  .history-table tr.selected{background:#E0EFE8}
  .mono{font-family:var(--font-mono); font-size:12px}
  .badge{display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; border:1px solid var(--border); background:white}
  .badge.ok{background:var(--ok-bg); color:var(--ok); border-color:#A7F3D0}
  .badge.err{background:var(--danger-bg); color:var(--danger); border-color:var(--danger-border)}
  .badge.muted{background:var(--primary-soft); color:var(--text-muted)}
  .badge.amber{background:var(--amber-bg); color:#92400E; border-color:var(--amber-border)}
  .muted{color:var(--text-muted)}
  .small{font-size:12px}
  .skeleton{padding:16px}
  .sk-row{height:56px; background:linear-gradient(90deg, #EEF2EE 25%, #F7F8F4 37%, #EEF2EE 63%); background-size:400% 100%; animation:shim 1.2s ease-in-out infinite; border-radius:12px; margin-bottom:10px}
  @keyframes shim{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .history-empty{padding:40px 20px; text-align:center}
  .history-empty h3{font-size:16px; margin-bottom:6px}
  .history-empty p{font-size:13.5px; color:var(--text-muted); max-width:44ch; margin:0 auto 16px}
  .review-header{display:flex; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid var(--border); margin-bottom:20px; flex-wrap:wrap}
  .review-header button{height:36px}
  .review-sub{margin-left:auto; display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text-muted)}
  .review-grid{display:grid; grid-template-columns:360px 1fr; gap:20px; align-items:start}
  .review-card{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:18px; box-shadow:var(--shadow); margin-bottom:16px}
  .review-card h3{font-size:12px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted); margin-bottom:12px}
  .review-card dl{display:grid; grid-template-columns:110px 1fr; gap:8px 12px; font-size:13px}
  .review-card dt{color:var(--text-muted)}
  .review-card dd{font-weight:500; word-break:break-word}
  .session-materials{display:flex; flex-direction:column; gap:8px; font-size:13px}
  .session-materials li{list-style:none; display:flex; justify-content:space-between; padding:8px 12px; background:var(--primary-soft); border-radius:10px; border:1px solid var(--border)}
  .review-excerpt{cursor:pointer; transition:box-shadow .15s}
  .review-excerpt:hover{box-shadow:var(--shadow-hover)}
  .review-excerpt blockquote{font-size:14px; line-height:1.5; font-style:italic; color:var(--text)}
  .review-excerpt .source{font-size:12px; color:var(--primary); font-weight:600; font-style:normal; margin-top:6px; display:inline-flex; gap:6px}
  .review-transcript-wrap{background:var(--surface); border:1px solid var(--border); border-radius:20px; box-shadow:var(--shadow); overflow:hidden; display:flex; flex-direction:column; min-height:420px; max-height:70vh}
  .review-transcript-head{display:flex; align-items:center; gap:12px; padding:14px 16px; border-bottom:1px solid var(--border); background:var(--page-bg)}
  .review-transcript-head h3{font-size:12px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted)}
  .review-transcript-head input{margin-left:auto; height:36px; border-radius:999px; border:1px solid var(--border); padding:0 12px; font-size:13px; background:white; width:220px}
  .review-transcript{flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px}
  .review-transcript .empty{padding:20px; color:var(--text-faint)}
  .review-player{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:16px; box-shadow:var(--shadow); margin-top:16px; position:sticky; bottom:16px}
  .player-row{display:flex; align-items:center; gap:14px}
  .player-btn{width:44px; height:44px; border-radius:50%; border:none; background:var(--primary); color:white; display:grid; place-items:center; font-size:16px; cursor:pointer}
  .player-btn:disabled{opacity:0.45}
  .player-bar{flex:1; height:8px; background:var(--primary-soft); border-radius:999px; position:relative; cursor:pointer}
  .player-fill{height:100%; background:var(--primary); border-radius:999px; width:0%}
  .player-thumb{position:absolute; top:50%; transform:translate(-50%,-50%); width:14px; height:14px; background:white; border:2px solid var(--primary); border-radius:50%; left:0; box-shadow:0 1px 4px rgba(0,0,0,0.15)}
  .player-time{font-variant-numeric:tabular-nums; font-size:12px; color:var(--text-muted); min-width:90px; text-align:right}
  .collapsible details{border:1px solid var(--border); border-radius:12px; padding:12px; background:white; margin-bottom:10px}
  .collapsible summary{font-size:13px; font-weight:600; cursor:pointer}
  .timeline-list{display:flex; flex-direction:column; gap:12px; margin-top:12px}
  .t-turn{padding:12px; border:1px solid var(--border); border-radius:12px; background:var(--primary-soft)}
  .t-head{display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:11px; color:var(--text-muted); margin-bottom:6px}
  .t-user{color:var(--text); margin-bottom:4px; font-size:13.5px}
  .t-agent{color:var(--primary); font-size:13.5px}
  .t-tool{font-family:var(--font-mono); font-size:11px; color:var(--text-muted); background:white; border:1px solid var(--border); padding:6px 8px; border-radius:8px; margin-top:6px; word-break:break-all}
  .tool-card{border:1px solid var(--border); border-radius:12px; padding:12px; background:white; margin-bottom:10px}
  .tool-name{font-family:var(--font-mono); font-size:12px; font-weight:700}
  .tool-args, .tool-result{margin-top:8px; font-size:12px}
  .tool-args pre, .tool-result pre{background:var(--page-bg); padding:8px; border-radius:8px; overflow-x:auto; white-space:pre-wrap; word-break:break-word}
  .a11y{position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden}
  @media (max-width: 960px){
    .hero{grid-template-columns:1fr; gap:24px}
    .how-grid{grid-template-columns:1fr}
    .interactive-sample{grid-template-columns:1fr}
    .live-grid{grid-template-columns:1fr}
    .live-visual-col{border-right:none; border-bottom:1px solid var(--border)}
    .review-grid{grid-template-columns:1fr}
    .history-table-wrap .history-table{display:none}
    .sessions-cards{display:flex}
    .history-controls input{max-width:none}
  }
  @media (max-width: 640px){
    .site-header{padding:12px 16px}
    .nav-links{gap:12px}
    .nav-link{font-size:12px}
    .page{padding:0 16px}
    .hero-title{font-size:36px}
    .review-transcript-head{flex-direction:column; align-items:stretch}
    .review-transcript-head input{width:100%; margin-left:0}
  }
  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{animation:none !important; transition:none !important}
  }
  :focus-visible{outline:2px solid var(--primary); outline-offset:2px; border-radius:4px}
</style>
</head>
<body>
<header class="site-header">
  <div class="brand" id="logo-btn" role="button" tabindex="0" aria-label="Go to home">
    <div class="brand-mark">R</div>
    <div class="brand-text">
      <div class="brand-title">Riverdale Previsit</div>
      <div class="brand-sub">An IntakeScribe experience · Powered by AssemblyAI</div>
    </div>
  </div>
  <nav class="nav-links" aria-label="Primary">
    <button class="nav-link" data-nav="welcome" id="nav-welcome">How it works</button>
    <button class="nav-link" data-nav="history" id="nav-history">Session history</button>
    <button class="btn-primary" id="nav-try-demo">Try demo</button>
  </nav>
</header>
<main class="page">
  <div id="view-welcome" class="view">
    <section class="hero">
      <div>
        <div class="eyebrow">Riverdale Previsit · Powered by AssemblyAI</div>
        <h1 class="hero-title"><span>Less paperwork.</span><span>More room for</span><span>your story.</span></h1>
        <p class="hero-sub">Talk through what brings you in, in your own words. Riverdale Previsit guides a voice intake conversation and keeps the session available for review.</p>
        <div class="hero-ctas">
          <button class="btn-primary" id="hero-cta-primary">Start voice intake →</button>
          <button class="btn-secondary" id="hero-cta-secondary">Explore a sample session</button>
        </div>
        <div class="hero-meta"><span>Browser-based voice intake</span><span>Review transcripts and recordings</span><span>No app download</span></div>
        <div class="safety">For routine intake only — not emergency care or medical advice. If you may be experiencing an emergency, contact local emergency services.</div>
      </div>
      <div class="hero-card" aria-hidden="false">
        <div class="hero-card-head"><strong>Sample intake</strong><span>Voice preview · Silent</span></div>
        <div class="sample-visual">
          <div class="voice-visual" id="hero-voice" aria-hidden="true"><div class="voice-dot"></div><div class="voice-ring"></div><div class="voice-ring2"></div></div>
        </div>
        <div id="sample-convo" class="sample-convo">
          <div class="sample-line agent"><span class="sample-who">Agent</span><span class="sample-text">What brings you in today?</span><span class="sample-time">00:18</span></div>
          <div class="sample-line patient"><span class="sample-who">Patient</span><span class="sample-text">My left knee has been sore since Saturday.</span><span class="sample-time">00:24</span></div>
        </div>
        <div class="sample-review">
          <div class="sample-review-label">Review card</div>
          <div id="sample-review-quote" class="sample-review-quote" role="button" tabindex="0">“My left knee has been sore since Saturday.”</div>
          <div class="sample-review-foot"><span>Reason shared by patient</span><span>View source · 00:24</span></div>
          <div id="sample-source-hint" hidden>Selecting the quote reveals its source turn in the transcript — try it in the sample session.</div>
        </div>
        <div class="hero-card-foot"><span>Conversation → Review</span><span>Transcript · Playback</span></div>
      </div>
    </section>

    <section id="how-it-works" class="section">
      <div class="section-head">
        <h2>How it works</h2>
        <p>Three simple steps from conversation to reviewable record — built for the moments before your appointment.</p>
      </div>
      <div class="how-grid">
        <div class="how-card"><div class="how-num">1</div><h3>Start a conversation</h3><p>Allow microphone access and begin a guided voice intake. You control when to end.</p></div>
        <div class="how-card"><div class="how-num">2</div><h3>Share the reason for your visit</h3><p>Describe your concern in your own words — symptoms, timing, medications, allergies.</p></div>
        <div class="how-card"><div class="how-num">3</div><h3>Revisit the session</h3><p>Review the transcript, recording, and timeline with source-linked navigation.</p></div>
      </div>
      <div style="margin-top:20px; display:flex; gap:12px; flex-wrap:wrap">
        <button class="btn-primary" id="how-cta">Start voice intake</button>
        <button class="btn-secondary" id="how-demo">Explore sample</button>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>From voice to verifiable review</h2>
        <p>Select a supported timestamped transcript turn to jump to the matching recording position. The strongest workflow is not a prettier call button — it is traceable, reviewable intake.</p>
      </div>
      <div class="interactive-sample">
        <div>
          <h3 style="font-size:15px; margin-bottom:8px">Signature interaction</h3>
          <p class="small muted" style="margin-bottom:12px; line-height:1.5">In the session review, every patient quote remains linked to its original turn. Click the excerpt card to reveal its source — no summary replaces the original words.</p>
          <div class="review-card" style="margin:0; cursor:pointer" id="demo-interactive-card">
            <div style="font-size:11px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted); font-weight:700; margin-bottom:8px">Reason shared by patient</div>
            <blockquote style="font-style:italic">"My left knee has been sore since Saturday."</blockquote>
            <div style="font-size:12px; color:var(--primary); font-weight:600; margin-top:8px">View source · 00:24 →</div>
          </div>
          <p class="small muted" style="margin-top:10px">Demo session · Synthetic patient data — clearly labeled, no backend write.</p>
        </div>
        <div style="background:var(--primary-soft); border:1px solid var(--border); border-radius:16px; padding:16px">
          <div style="font-size:11px; letter-spacing:0.7px; text-transform:uppercase; color:var(--text-muted); font-weight:700; margin-bottom:10px">Transcript preview</div>
          <div style="display:flex; flex-direction:column; gap:8px; font-size:13px">
            <div style="display:flex; gap:10px"><span class="mono muted">00:18</span><span class="muted">Agent</span><span>What brings you in today?</span></div>
            <div style="display:flex; gap:10px; background:white; border:1px solid var(--amber-border); border-radius:10px; padding:8px"><span class="mono muted">00:24</span><span class="muted">Patient</span><span style="font-weight:600">“My left knee has been sore since Saturday.”</span></div>
            <div style="display:flex; gap:10px"><span class="mono muted">00:34</span><span class="muted">Agent</span><span>Thank you. When did it start…</span></div>
          </div>
          <div style="margin-top:12px; font-size:11px; color:var(--text-muted)">Selecting the highlighted turn seeks the recording to 00:24 and highlights the source.</div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="built-card">
        <div class="built-icon" aria-hidden="true"> <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 3L3 8l9 5 9-5-9-5z" stroke="#245C4E" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 12l9 5 9-5" stroke="#245C4E" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 16l9 5 9-5" stroke="#245C4E" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
        <div>
          <h3 style="font-size:16px; margin-bottom:6px">Built on AssemblyAI</h3>
          <p class="small muted" style="line-height:1.6">The existing AssemblyAI Voice Agent powers the conversation, while this frontend makes supported session artifacts easier to explore — transcripts, stereo recordings, timelines and tool activity are displayed faithfully with explicit source labels. No browser-side summarizer is added.</p>
          <p class="small muted" style="margin-top:8px"><a href="https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history" target="_blank" rel="noopener">Session History docs →</a> <span style="margin:0 8px">·</span> <span class="mono">agent ${AGENT.id.slice(0,12)}…</span></p>
        </div>
      </div>
    </section>

    <section class="section" style="border-top:none; padding-top:20px">
      <div class="closing">
        <h2>Start with your story.</h2>
        <p class="muted" style="margin-bottom:18px">A calm, guided voice intake — reviewable afterward, word for word.</p>
        <button class="btn-primary" id="closing-cta">Start voice intake →</button>
        <div style="margin-top:10px; font-size:12px; color:var(--text-faint)">Browser-based · No download · Ends when you do</div>
      </div>
    </section>
  </div>

  <div id="view-live" class="view" hidden>
    <div class="live-shell">
      <div class="live-top">
        <strong>Live intake</strong>
        <span class="live-status" id="live-status-badge" aria-live="polite"><span class="live-dot" id="live-dot"></span><span id="live-status-text">Ready when you are.</span></span>
        <span class="muted small" id="elapsed-mini" style="font-variant-numeric:tabular-nums">0:00</span>
        <span class="muted small" id="cost-mini" style="font-variant-numeric:tabular-nums">$0.000</span>
        <button class="btn-ghost" id="live-back-welcome" style="margin-left:auto">← Back to home</button>
      </div>
      <div class="live-grid">
        <div class="live-visual-col">
          <div class="voice-visual" id="voice-visual" data-state="idle">
            <div class="voice-dot" id="voice-dot"></div>
            <div class="voice-ring"></div>
            <div class="voice-ring2"></div>
          </div>
          <canvas id="voice-canvas" class="wave-canvas" width="320" height="48" aria-hidden="true"></canvas>
          <div class="live-timer-big" id="live-time-large">00:00</div>
          <div class="live-state" id="live-state-label">Ready when you are.</div>
          <div class="live-controls">
            <select id="mic" aria-label="Microphone"><option value="">Default microphone</option></select>
            <button class="btn-ghost" id="btn-mute" aria-pressed="false">Mute</button>
            <button class="btn-primary" id="btn">Start voice intake</button>
            <button class="btn-ghost" id="btn-end" hidden>End intake</button>
          </div>
          <div id="precall-card" class="precall-card">
            <h4>Before we begin</h4>
            <ul>
              <li>Use a quiet place if possible.</li>
              <li>Allow microphone access when prompted.</li>
              <li>You can end the conversation at any time.</li>
            </ul>
            <div style="margin-top:12px; padding:10px; background:var(--amber-bg); border:1px solid var(--amber-border); border-radius:10px; font-size:12px; color:#92400E">
              This is an AI intake assistant. It does not provide medical advice. Conversation will be transcribed and may be stored as a session artifact.
            </div>
            <label><input type="checkbox" id="ack-check"> <span>I understand this is an AI intake assistant, not a clinician, and the session may be recorded and transcribed for review. This acknowledgement is stored locally only.</span></label>
          </div>
        </div>
        <div class="live-convo-col">
          <div class="convo-head">
            <span>Conversation</span>
            <span class="mono muted small" id="live-session-id-mini"></span>
          </div>
          <div id="transcript" class="transcript" aria-live="polite" aria-label="Live transcript">
            <div class="empty">Start the call to see your conversation here. Partial transcripts appear as they stream.<br><br><span class="muted small">Tip: try “My left knee has been sore since Saturday” — the review will keep your exact words.</span></div>
          </div>
          <button class="jump-latest" id="jump-latest" hidden>Jump to latest ↓</button>
          <div id="live-fallback" class="fallback" hidden>Your transcript will be available in session history after processing.</div>
        </div>
      </div>
      <div class="live-foot"><span>AI intake assistant · Not medical advice</span><span style="margin-left:auto" class="muted">Session: <span id="live-session-id" class="mono">—</span></span></div>
    </div>
    <div id="postcall-card" class="postcall" hidden>
      <div style="flex:1">
        <strong>Conversation complete</strong>
        <p id="postcall-notice">Your transcript and recording will appear in Session history once processing completes.</p>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap">
        <button class="btn-primary" id="postcall-review" hidden>Open session review →</button>
        <button class="btn-secondary" id="postcall-history">Check session history</button>
      </div>
    </div>
  </div>

  <div id="view-history" class="view" hidden>
    <div class="history-head">
      <h2>Session history</h2>
      <p class="muted small">Find and review previous intake sessions. Selecting a session opens the review workspace where transcript, recording and timeline meet.</p>
      <div class="history-controls">
        <input id="history-search" placeholder="Search loaded sessions (ID, status, reason)" aria-label="Search loaded sessions">
        <select id="filter-material" aria-label="Filter by material"><option value="">All materials</option><option value="recording">With recording</option><option value="transcript">With transcript</option></select>
        <select id="filter-status" aria-label="Filter by status"><option value="">All statuses</option><option value="completed" selected>Completed call</option><option value="active">Active</option><option value="failed">Failed</option></select>
        <button class="btn-secondary" id="btn-refresh-history">Refresh</button>
      </div>
      <div id="history-status" class="muted small">Loading…</div>
      <div id="history-error" class="small" style="color:var(--danger)" hidden></div>
    </div>
    <div class="history-table-wrap">
      <div id="sessions-skeleton" class="skeleton" hidden><div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div></div>
      <table class="history-table" aria-label="Session history table">
        <thead><tr><th>Session</th><th>Date & time</th><th>Duration</th><th>Materials</th><th>Status</th><th></th></tr></thead>
        <tbody id="sessions-tbody"></tbody>
      </table>
      <div id="sessions-cards" class="sessions-cards"></div>
      <div id="history-empty" class="history-empty" hidden>
        <h3>Your conversations will appear here.</h3>
        <p>After an intake call, return to review its available transcript, recording, and session activity.</p>
        <button class="btn-primary" id="history-start-cta">Start an intake</button>
      </div>
    </div>
    <div style="text-align:center; margin-top:16px"><button class="btn-secondary" id="load-more" hidden>Load more</button></div>
  </div>

  <div id="view-review" class="view" hidden>
    <div class="review-header">
      <button class="btn-ghost" id="btn-back-history">← History</button>
      <div style="font-weight:600; display:flex; align-items:center; gap:8px"><span>Intake session</span><span class="muted small" id="review-date">—</span></div>
      <span id="review-badge" class="badge amber" hidden>Demo session · Synthetic patient data</span>
      <div class="review-sub">
        <button class="btn-mini" id="btn-refresh-detail">Refresh</button>
        <button class="btn-mini danger" id="btn-delete-session">Delete</button>
      </div>
    </div>
    <div class="review-grid">
      <div>
        <div class="review-card">
          <h3>Session overview</h3>
          <dl>
            <dt>Session ID</dt><dd class="mono" id="review-id">—</dd>
            <dt>Started</dt><dd id="review-started">—</dd>
            <dt>Ended</dt><dd id="review-ended">—</dd>
            <dt>Duration</dt><dd id="review-duration">—</dd>
            <dt>Recording</dt><dd id="review-recording-state">—</dd>
          </dl>
        </div>
        <div class="review-card">
          <h3>Session materials</h3>
          <ul class="session-materials">
            <li><span>Transcript</span><span class="muted small" id="mat-transcript-state">—</span></li>
            <li><span>Recording</span><span class="muted small" id="mat-recording-state">—</span></li>
            <li><span>Timeline</span><span class="muted small" id="mat-timeline-state">—</span></li>
            <li><span>Tool activity</span><span class="muted small" id="mat-tools-state">—</span></li>
          </ul>
        </div>
        <div class="review-card review-excerpt" id="review-excerpt-card" role="button" tabindex="0">
          <h3>Excerpt · Source-linked</h3>
          <blockquote id="review-overview-excerpt">“My left knee has been sore since Saturday.”</blockquote>
          <div class="source">View source · 00:24 <span aria-hidden="true">→</span></div>
          <p class="small muted" style="margin-top:8px">Selecting the excerpt highlights its source turn and seeks the recording when available.</p>
        </div>
        <div class="review-card collapsible">
          <details open id="timeline-details"><summary>Timeline</summary><div id="timeline-list" class="timeline-list"></div></details>
          <details id="tools-details"><summary>Tool activity</summary><div id="tools-list" style="margin-top:12px"></div></details>
          <details id="metadata-details"><summary>Metadata</summary><pre id="metadata-pre" style="margin-top:12px; white-space:pre-wrap; word-break:break-word; font-size:12px; background:var(--page-bg); padding:12px; border-radius:10px"></pre></details>
          <details id="raw-details"><summary>Raw session JSON</summary><pre id="raw-pre" style="margin-top:12px; white-space:pre-wrap; word-break:break-word; font-size:12px; background:var(--page-bg); padding:12px; border-radius:10px"></pre></details>
        </div>
      </div>
      <div class="review-transcript-wrap">
        <div class="review-transcript-head">
          <h3>Transcript</h3>
          <input id="review-transcript-search" placeholder="Search this transcript" aria-label="Search this transcript">
        </div>
        <div id="review-transcript" class="review-transcript"></div>
        <div class="review-player">
          <div class="player-row">
            <button class="player-btn" id="player-play" aria-label="Play">▶</button>
            <div class="player-bar" id="player-bar" role="slider" aria-label="Seek recording" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
              <div class="player-fill" id="player-fill"></div>
              <div class="player-thumb" id="player-thumb"></div>
            </div>
            <span class="player-time"><span id="player-cur">00:00</span> / <span id="player-tot">00:00</span></span>
          </div>
          <audio id="review-audio" preload="metadata"></audio>
          <div id="player-state" class="small muted" style="margin-top:8px">Select a timestamped turn to seek when recording is available.</div>
        </div>
      </div>
    </div>
  </div>
</main>
<div id="a11y-announce" class="a11y" aria-live="polite"></div>
<script>window.AGENT = ${JSON.stringify(AGENT).replace(/</g, '\\u003c')}</script>
<script src="/app.js?v=${ASSET_V}"></script>
</body>
</html>`;


// --- server ----------------------------------------------------------------
function publicAgent(agent) {
  const copy = structuredClone(agent)
  for (const tool of copy.tools ?? []) {
    for (const header of tool.http?.headers ?? []) header.value = '<hidden>'
  }
  for (const llm of copy.llm ?? []) delete llm.api_key
  return copy
}

function artifactUrl(session, kind) {
  return session.artifacts?.find(a => a.type === kind)?.url || null
}

function parseTimeline(timeline) {
  const messages = []
  for (const turn of timeline.turns ?? []) {
    if (turn.user_transcript) {
      messages.push({ role: 'user', text: turn.user_transcript, confidence: turn.user_confidence, turn_id: turn.turn_id })
    }
    for (const call of turn.tool_calls ?? []) {
      messages.push({
        role: 'tool',
        name: call.name,
        arguments: call.arguments,
        result: call.result,
        error: call.is_error || call.timed_out || false,
        call_id: call.call_id,
        dispatched_at_ms: call.dispatched_at_ms,
        duration_ms: call.duration_ms,
      })
    }
    if (turn.agent_text) {
      messages.push({ role: 'agent', text: turn.agent_text, turn_id: turn.turn_id, time_to_first_audio_ms: turn.time_to_first_audio_ms })
    }
  }
  return messages
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  // --- existing endpoints ---
  if (pathname === '/agent') {
    try {
      const agent = await aai(`/agents/${AGENT.id}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(publicAgent(agent)))
    } catch (error) {
      console.error(error.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'could not load the agent' }))
    }
    return
  }
  if (pathname === '/token') {
    try {
      const token = await aai('/token?product=voice_agent&expires_in_seconds=300')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(token))
    } catch (error) {
      console.error(error.message)
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'token request failed' }))
    }
    return
  }
  if (pathname === '/app.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': 'no-store, no-cache, must-revalidate',
    })
    res.end('(' + clientApp.toString() + ')();')
    return
  }

  // --- Session History API proxy (keeps ASSEMBLYAI_API_KEY server-side) ---
  if (pathname === '/api/sessions' && req.method === 'GET') {
    if (!_hasKey) {
      // demo preview stub — real sessions appear once a valid ASSEMBLYAI_API_KEY is set
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessions: [], has_more: false, response_metadata: {}, note: 'demo preview — set ASSEMBLYAI_API_KEY to list real sessions. Try the synthetic demo session via Explore sample.' }))
      return
    }
    try {
      const qs = url.searchParams.toString()
      const data = await aai(`/sessions${qs ? '?' + qs : ''}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (error) {
      console.error('list sessions error:', error.message)
      res.writeHead(error.status || 502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  // match /api/sessions/:id and subroutes
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^\/]+)(?:\/(audio|timeline|transcript|metadata))?$/)
  if (sessionMatch) {
    const sessionId = sessionMatch[1]
    const sub = sessionMatch[2] // audio, timeline, transcript, metadata or undefined

    if (req.method === 'DELETE' && !sub) {
      try {
        await aai(`/sessions/${sessionId}`, { method: 'DELETE' })
        res.writeHead(204)
        res.end()
      } catch (error) {
        console.error('delete session error:', error.message)
        res.writeHead(error.status || 502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }

    if (req.method === 'GET' && !sub) {
      // retrieve full session
      try {
        const session = await aai(`/sessions/${sessionId}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(session))
      } catch (error) {
        console.error('get session error:', error.message)
        res.writeHead(error.status || 502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }

    if (req.method === 'GET' && sub === 'audio') {
      try {
        const session = await aai(`/sessions/${sessionId}`)
        const audio = artifactUrl(session, 'audio')
        if (!audio) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no audio artifact yet (session active or empty)', url: null }))
          return
        }
        // Return fresh pre-signed URL, client can play directly
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ url: audio, content_type: 'audio/ogg' }))
      } catch (error) {
        console.error('audio url error:', error.message)
        res.writeHead(error.status || 502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }

    if (req.method === 'GET' && sub === 'timeline') {
      try {
        const session = await aai(`/sessions/${sessionId}`)
        const tUrl = artifactUrl(session, 'timeline')
        if (!tUrl) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no timeline artifact yet' }))
          return
        }
        const timelineRes = await fetch(tUrl)
        if (!timelineRes.ok) throw new Error('failed to fetch timeline artifact: ' + timelineRes.status)
        const timeline = await timelineRes.json()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(timeline))
      } catch (error) {
        console.error('timeline error:', error.message)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }

    if (req.method === 'GET' && sub === 'transcript') {
      try {
        const session = await aai(`/sessions/${sessionId}`)
        const tUrl = artifactUrl(session, 'timeline')
        if (!tUrl) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ messages: [], note: 'no timeline artifact yet' }))
          return
        }
        const timelineRes = await fetch(tUrl)
        if (!timelineRes.ok) throw new Error('failed to fetch timeline artifact: ' + timelineRes.status)
        const timeline = await timelineRes.json()
        const messages = parseTimeline(timeline)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ session_id: sessionId, messages, turns: timeline.turns?.length || 0 }))
      } catch (error) {
        console.error('transcript error:', error.message)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }

    if (req.method === 'GET' && sub === 'metadata') {
      try {
        const session = await aai(`/sessions/${sessionId}`)
        const mUrl = artifactUrl(session, 'metadata')
        if (!mUrl) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'no metadata artifact yet' }))
          return
        }
        const metaRes = await fetch(mUrl)
        if (!metaRes.ok) throw new Error('failed to fetch metadata artifact: ' + metaRes.status)
        const metadata = await metaRes.json()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(metadata))
      } catch (error) {
        console.error('metadata error:', error.message)
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
      return
    }
  }

  if (req.method === 'OPTIONS' && (pathname === '/intake' || pathname === '/flag_urgent' || pathname.startsWith('/api/'))) {
    sendJson(res, 204, {})
    return
  }

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true, agent_id: AGENT.id, intakes: records.intakes.length, alerts: records.alerts.length })
    return
  }

  if (pathname === '/intake' && req.method === 'POST') {
    if (!webhookAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    try {
      const body = await readJson(req)
      const id = newId('int_')
      pushRecord(records.intakes, { id, received_at: new Date().toISOString(), ...body })
      console.log('submit_intake', id, body.callback_number || '')
      sendJson(res, 200, {
        ok: true,
        intake_id: id,
        message: 'Intake saved. Thank the caller and remind them a live interpreter will be at the appointment.',
      })
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
    }
    return
  }

  if (pathname === '/flag_urgent' && req.method === 'POST') {
    if (!webhookAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    try {
      const body = await readJson(req)
      const id = newId('urg_')
      pushRecord(records.alerts, { id, received_at: new Date().toISOString(), ...body })
      console.log('flag_urgent', id, body.reason || '')
      sendJson(res, 200, {
        ok: true,
        alert_id: id,
        message: 'Staff have been alerted. Tell the caller to hang up and call 911 or go to the nearest emergency room now.',
      })
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
    }
    return
  }

  if (pathname === '/api/intakes' && req.method === 'GET') {
    sendJson(res, 200, { intakes: records.intakes })
    return
  }

  if (pathname === '/api/alerts' && req.method === 'GET') {
    sendJson(res, 200, { alerts: records.alerts })
    return
  }

  // Unknown non-GET must not fall through to HTML — AssemblyAI would treat a 200 HTML page as a successful tool result.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  // default: serve HTML
  res.writeHead(200, {
    'content-type': 'text/html',
    'cache-control': 'no-store, no-cache, must-revalidate',
  })
  res.end(HTML)
})

// PORT when set, otherwise 3000 and up until one is free.
let port = Number(process.env.PORT) || 3000
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT && port < 3010) {
    port += 1
    server.listen(port)
    return
  }
  throw err
})
const voiceWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  let pathname = '/'
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch {
    socket.destroy()
    return
  }
  if (pathname !== '/voice') {
    socket.destroy()
    return
  }
  voiceWss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket('wss://agents.assemblyai.com/v1/ws', {
      headers: { Authorization: `Bearer ${process.env.ASSEMBLYAI_API_KEY}` },
    })
    const queue = []
    const sendUp = (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
      } else {
        queue.push([data, isBinary])
      }
    }
    client.on('message', (data, isBinary) => sendUp(data, isBinary))
    upstream.on('open', () => {
      for (const [data, isBinary] of queue) upstream.send(data, { binary: isBinary })
      queue.length = 0
    })
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
    })
    const shutdown = () => {
      try { client.close() } catch {}
      try { upstream.close() } catch {}
    }
    client.on('close', () => { try { upstream.close() } catch {} })
    upstream.on('close', () => { try { client.close() } catch {} })
    client.on('error', shutdown)
    upstream.on('error', (err) => {
      console.error('upstream voice ws:', err.message)
      shutdown()
    })
  })
})

server.on('listening', () => console.log(`Talk to it: http://localhost:${port} | History API: /api/sessions | Voice proxy: /voice`))
server.listen(port)
