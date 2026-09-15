#!/usr/bin/env node
// Talk to your agent from a browser tab + Session History dashboard.
//
//   AGENT=ai-voice-intake-scribe npm start
//
// The API key stays in this process; the page only gets 60-second tokens
// and short-lived pre-signed artifact URLs via /api/*.

import http from 'node:http'
import { aai, loadEnv, publishAgent, readAgent, required, storedAgentId } from '../../lib.mjs'

loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')

// A published id means the agent is managed elsewhere, so use it as it is.
const AGENT = await (async () => {
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

// --- client ----------------------------------------------------------------
// Stringified and served as /app.js.
function clientApp() {
const $ = (id) => document.getElementById(id)
const WIRE_RATE = 24_000
const AGENT = window.AGENT

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
`

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
`

const blobUrl = (code) =>
  URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))

let ws, captureCtx, playbackCtx, playback, mic, callStart, timer, lastSessionId = null

async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
  const select = $('mic')
  if (!select) return
  const chosen = select.value
  select.replaceChildren()
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = 'Default microphone'
  select.append(auto)
  inputs.forEach((device, i) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label || `Microphone ${i + 1}`
    select.append(option)
  })
  if (chosen && inputs.some((device) => device.deviceId === chosen)) select.value = chosen
}
listMics()
navigator.mediaDevices?.addEventListener?.('devicechange', listMics)

if ($('btn')) $('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start())
if ($('log-toggle')) $('log-toggle').onclick = () => {
  const hidden = document.body.classList.toggle('no-side')
  $('log-toggle').textContent = hidden ? 'Show' : 'Hide'
}

// --- main nav ---
function switchMainView(name) {
  for (const v of ['live', 'history']) {
    const el = $('view-' + v)
    if (el) el.hidden = v !== name
    const tab = $('main-tab-' + v)
    if (tab) tab.classList.toggle('on', v === name)
  }
  if (name === 'history' && !historyLoaded) {
    historyLoaded = true
    loadSessions({ reset: true })
  }
}
if ($('main-tab-live')) $('main-tab-live').onclick = () => switchMainView('live')
if ($('main-tab-history')) $('main-tab-history').onclick = () => switchMainView('history')

// --- side pane tabs ---
let agentLoaded = false
function showTab(name) {
  for (const tab of ['events', 'agent']) {
    const el = $('tab-' + tab)
    if (el) el.classList.toggle('on', tab === name)
    const body = $(tab + '-body')
    if (body) body.hidden = tab !== name
  }
  if (name === 'agent' && !agentLoaded) {
    agentLoaded = true
    fetch('/agent')
      .then((res) => res.json())
      .then((agent) => {
        const body = $('agent-body')
        if (!body) return
        body.replaceChildren()
        const pre = document.createElement('pre')
        pre.textContent = JSON.stringify(agent, null, 2)
        body.append(pre)
      })
      .catch(() => {
        agentLoaded = false
        const body = $('agent-body')
        if (body) body.textContent = 'Could not load the agent.'
      })
  }
}
if ($('tab-events')) $('tab-events').onclick = () => showTab('events')
if ($('tab-agent')) $('tab-agent').onclick = () => showTab('agent')

async function addWorklet(ctx, code, name) {
  const url = blobUrl(code)
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(ctx, name)
}

async function start() {
  $('btn').disabled = true
  $('mic').disabled = true
  setStatus('connecting')

  try {
    const res = await fetch('/token')
    if (!res.ok) {
      setStatus('error', 'could not mint a token, check the API key')
      reset()
      return
    }
    const { token } = await res.json()

    captureCtx = new AudioContext({ sampleRate: WIRE_RATE })
    playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
    await Promise.all([captureCtx.resume(), playbackCtx.resume()])

    playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback')
    playback.connect(playbackCtx.destination)

    const deviceId = $('mic').value
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    listMics()
    const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture')
    captureCtx.createMediaStreamSource(mic).connect(capture)

    const url = new URL('wss://agents.assemblyai.com/v1/ws')
    url.searchParams.set('token', token)
    ws = new WebSocket(url)
    let ready = false

    capture.port.onmessage = ({ data }) => {
      if (!ready || ws.readyState !== 1) return
      const bytes = new Uint8Array(data)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      }
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
      logEvent('up', 'input.audio')
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { agent_id: AGENT.id } }))
      logEvent('up', 'session.update', AGENT.id)
    }

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data)
      switch (msg.type) {
        case 'session.ready':
          ready = true
          lastSessionId = msg.session_id
          callStart = Date.now()
          timer = setInterval(tick, 1000)
          tick()
          setStatus('listening')
          $('btn').disabled = false
          $('btn').textContent = 'End call'
          $('btn').classList.add('live')
          logEvent('down', msg.type, msg.session_id)
          // show live session id
          if ($('live-session-id')) $('live-session-id').textContent = msg.session_id
          break

        case 'input.speech.started':
          playback?.port.postMessage('stop')
          setStatus('listening')
          logEvent('down', msg.type)
          break

        case 'reply.started':
          setStatus('speaking')
          logEvent('down', msg.type)
          break

        case 'reply.audio': {
          const raw = atob(msg.data)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
          playback?.port.postMessage(bytes.buffer, [bytes.buffer])
          logEvent('down', msg.type)
          break
        }

        case 'reply.done':
          setStatus('listening')
          if (msg.status === 'interrupted') playback?.port.postMessage('stop')
          logEvent('down', msg.type, msg.status)
          break

        case 'transcript.user.delta':
          partial('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'transcript.agent.delta':
          logEvent('down', msg.type, msg.delta)
          if (msg.reply_id && msg.reply_id === printedReply) break
          if (msg.reply_id !== liveReply) {
            liveReply = msg.reply_id
            dropPartial('agent')
          }
          partial('agent', appendDelta(partialText.agent || '', msg.delta))
          break

        case 'transcript.user':
          addLine('you', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'transcript.agent':
          printedReply = msg.reply_id ?? printedReply
          addLine('agent', msg.text)
          logEvent('down', msg.type, msg.text)
          break

        case 'tool.call': {
          const args = JSON.stringify(msg.arguments ?? {})
          addLine('tool', `${msg.name}(${args})`)
          logEvent('down', msg.type, `${msg.name} ${args}`)
          break
        }

        case 'session.ended':
          logEvent('down', msg.type)
          ws.close()
          break

        case 'session.error':
          setStatus('error', msg.message)
          logEvent('down', msg.type, `${msg.code}: ${msg.message}`)
          break

        default:
          logEvent('down', msg.type)
      }
    }

    ws.onclose = () => { 
      setStatus('idle'); 
      reset();
      // auto refresh history after call ends
      if (historyLoaded) {
        setTimeout(() => loadSessions({ reset: true }), 1500)
      }
      if (lastSessionId && $('last-session-link')) {
        $('last-session-link').hidden = false
        $('last-session-link').onclick = () => {
          switchMainView('history')
          setTimeout(() => selectSession(lastSessionId), 300)
        }
      }
    }
    ws.onerror = () => { setStatus('error', 'connection failed'); reset() }
  } catch (error) {
    setStatus('error', error.message)
    reset()
  }
}

function stop() {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'session.end' }))
    logEvent('up', 'session.end')
    const socket = ws
    setTimeout(() => { if (socket.readyState === 1) socket.close() }, 3000)
  } else {
    ws?.close()
  }
  playback?.port.postMessage('stop')
  mic?.getTracks().forEach((track) => track.stop())
  captureCtx?.close()
  playbackCtx?.close()
  captureCtx = playbackCtx = playback = mic = null
  reset()
  setStatus('idle')
}

function reset() {
  clearInterval(timer)
  clearPartials()
  open.forEach((run) => paint(run, true))
  open.clear()
  if ($('btn')) {
    $('btn').disabled = false
    $('mic').disabled = false
    $('btn').textContent = 'Start call'
    $('btn').classList.remove('live')
  }
}

function setStatus(state, detail) {
  const st = $('status')
  if (!st) return
  st.className = 'status ' + state
  $('status-text').textContent = detail || state
}

const COST_PER_SECOND = 4.5 / 3600
function tick() {
  if (!$('elapsed')) return
  const seconds = Math.floor((Date.now() - callStart) / 1000)
  $('elapsed').textContent =
    Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
  $('cost').textContent = '$' + (seconds * COST_PER_SECOND).toFixed(3)
}

// --- transcript ---
const partialText = {}
const partialEl = {}
let liveReply = null
let printedReply = null

const ATTACHES_LEFT = /^[.,!?;:%°)\\]}…'\"’”]/
const NO_SPACE_AFTER = /[([{$\\-\\/'\"‘“]$/

function appendDelta(text, delta) {
  if (!delta) return text
  if (!text) return delta
  if (/^\s/.test(delta) || /\s$/.test(text)) return text + delta
  if (ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text + delta
  return text + ' ' + delta
}

function dropPartial(who) {
  partialEl[who]?.remove()
  delete partialEl[who]
  delete partialText[who]
}

function transcriptLine(who, text, cls) {
  const line = document.createElement('div')
  line.className = 'line ' + who + (cls ? ' ' + cls : '')
  const label = document.createElement('span')
  label.className = 'who'
  label.textContent = who === 'agent' ? AGENT.name : who
  const body = document.createElement('span')
  body.className = 'said'
  body.textContent = text
  line.append(label, body)
  return line
}

function clearEmpty(el) {
  const empty = el?.querySelector('.empty')
  if (empty) empty.remove()
}

function scroll(el) {
  if (el) el.scrollTop = el.scrollHeight
}

function partial(who, text) {
  const trans = $('transcript')
  if (!trans) return
  clearEmpty(trans)
  partialText[who] = text
  if (partialEl[who]) {
    partialEl[who].querySelector('.said').textContent = text
  } else {
    partialEl[who] = transcriptLine(who, text, 'partial')
    trans.append(partialEl[who])
  }
  scroll(trans)
}

function addLine(who, text) {
  const trans = $('transcript')
  if (!trans) return
  clearEmpty(trans)
  dropPartial(who)
  trans.append(transcriptLine(who, text))
  scroll(trans)
}

function clearPartials() {
  for (const who of Object.keys(partialEl)) dropPartial(who)
  liveReply = printedReply = null
}

// --- event log ---
const COALESCE = new Set([
  'input.audio',
  'reply.audio',
  'transcript.user.delta',
  'transcript.agent.delta',
])
const open = new Map()

function eventRow(direction, type, detail) {
  const row = document.createElement('div')
  row.className = 'event ' + direction
  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = (callStart ? (Date.now() - callStart) / 1000 : 0).toFixed(1) + 's'
  const arrow = document.createElement('span')
  arrow.className = 'dir'
  arrow.textContent = direction === 'up' ? '↑' : '↓'
  const name = document.createElement('span')
  name.className = 'type'
  name.textContent = type
  const count = document.createElement('span')
  count.className = 'count'
  const info = document.createElement('span')
  info.className = 'detail'
  if (detail) info.textContent = detail
  row.append(at, arrow, name, count, info)
  return row
}

function paint(live, final) {
  const now = performance.now()
  if (!final && now - live.painted < 100) return
  live.painted = now
  live.row.querySelector('.count').textContent = live.count > 1 ? '×' + live.count : ''
  if (live.detail) live.row.querySelector('.detail').textContent = live.detail
}

function logEvent(direction, type, detail) {
  const log = $('events-body')
  if (!log) return
  clearEmpty(log)
  const key = direction + ' ' + type
  const live = open.get(key)
  if (live) {
    live.count += 1
    if (detail) live.detail = detail
    paint(live)
    return
  }
  if (!COALESCE.has(type)) {
    open.forEach((run) => paint(run, true))
    open.clear()
  }
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  const row = eventRow(direction, type, detail)
  log.append(row)
  while (log.children.length > 400) log.firstChild.remove()
  if (COALESCE.has(type)) open.set(key, { row, count: 1, detail, painted: 0 })
  if (atBottom) scroll(log)
}

// --- Session History Features ---
let historyLoaded = false
let sessions = []
let nextCursor = null
let hasMore = false
let selectedSession = null

async function loadSessions({ reset = false } = {}) {
  const listEl = $('sessions-list')
  const statusEl = $('history-status')
  if (reset) {
    sessions = []
    nextCursor = null
    hasMore = false
    if (listEl) listEl.replaceChildren()
  }
  if (statusEl) statusEl.textContent = 'Loading sessions...'
  try {
    const params = new URLSearchParams()
    params.set('limit', '50')
    params.set('agent_id', AGENT.id)
    if (nextCursor) params.set('cursor', nextCursor)
    const statusFilter = $('filter-status')?.value
    if (statusFilter) params.set('status', statusFilter)

    const res = await fetch('/api/sessions?' + params.toString())
    if (!res.ok) throw new Error('Failed to list sessions: ' + res.status)
    const data = await res.json()
    
    if (reset) sessions = data.sessions || []
    else sessions = sessions.concat(data.sessions || [])
    
    nextCursor = data.response_metadata?.next_cursor || null
    hasMore = data.has_more || false

    renderSessions()
    if (statusEl) {
      statusEl.textContent = `${sessions.length} session(s)${hasMore ? ' — more available' : ''} • Agent: ${AGENT.id.slice(0,8)}...`
    }
    if ($('load-more')) $('load-more').hidden = !hasMore
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Error: ' + e.message
  }
}

function renderSessions() {
  const listEl = $('sessions-list')
  if (!listEl) return
  if (!sessions.length) {
    listEl.innerHTML = '<div class=\"empty\">No sessions yet. Make a call in Live Call tab, then refresh.</div>'
    return
  }
  listEl.replaceChildren()
  sessions.forEach(s => {
    const row = document.createElement('div')
    row.className = 'session-row' + (selectedSession?.id === s.id ? ' selected' : '')
    row.dataset.id = s.id
    
    const date = new Date(s.created_at)
    const duration = s.duration_seconds ? `${s.duration_seconds.toFixed(1)}s` : '—'
    const statusClass = s.status === 'completed' ? 'ok' : s.status === 'failed' ? 'err' : 'muted'
    
    row.innerHTML = `
      <div class=\"s-main\">
        <div class=\"s-id\" title=\"${s.id}\">${s.id.slice(0,18)}…</div>
        <div class=\"s-meta\">
          <span class=\"badge ${statusClass}\">${s.status}</span>
          <span class=\"s-time\">${date.toLocaleString()}</span>
          <span class=\"s-dur\">${duration}</span>
        </div>
        <div class=\"s-reason\">${s.public_close_reason || ''} ${s.agent_id ? '• ' + s.agent_id.slice(0,8) : ''}</div>
      </div>
      <div class=\"s-actions\">
        <button class=\"mini\" data-action=\"view\">View</button>
      </div>
    `
    row.querySelector('[data-action=\"view\"]').onclick = () => selectSession(s.id)
    row.onclick = (e) => { if (!e.target.closest('button')) selectSession(s.id) }
    listEl.append(row)
  })
}

async function selectSession(sessionId) {
  const detailEl = $('session-detail')
  if (!detailEl) return
  detailEl.innerHTML = '<div class=\"empty\">Loading session ' + sessionId + '…</div>'
  try {
    // fetch full session
    const res = await fetch('/api/sessions/' + sessionId)
    if (!res.ok) throw new Error('Failed to fetch session: ' + res.status)
    const session = await res.json()
    selectedSession = session
    renderSessions() // to highlight

    // fetch transcript parsed
    let transcript = null
    let timeline = null
    let audioUrl = null
    let metadata = null
    
    try {
      const tRes = await fetch('/api/sessions/' + sessionId + '/transcript')
      if (tRes.ok) transcript = await tRes.json()
    } catch {}
    try {
      const tlRes = await fetch('/api/sessions/' + sessionId + '/timeline')
      if (tlRes.ok) timeline = await tlRes.json()
    } catch {}
    try {
      const aRes = await fetch('/api/sessions/' + sessionId + '/audio')
      if (aRes.ok) {
        const aData = await aRes.json()
        audioUrl = aData.url
      }
    } catch {}
    try {
      const mRes = await fetch('/api/sessions/' + sessionId + '/metadata')
      if (mRes.ok) metadata = await mRes.json()
    } catch {}

    renderSessionDetail(session, { transcript, timeline, audioUrl, metadata })
  } catch (e) {
    detailEl.innerHTML = '<div class=\"empty\" style=\"color: var(--error)\">Error: ' + e.message + '</div>'
  }
}

function renderSessionDetail(session, { transcript, timeline, audioUrl, metadata }) {
  const detailEl = $('session-detail')
  if (!detailEl) return

  const created = new Date(session.created_at).toLocaleString()
  const ended = session.ended_at ? new Date(session.ended_at).toLocaleString() : '—'
  const duration = session.duration_seconds ? session.duration_seconds.toFixed(1) + 's' : '—'

  // build transcript HTML
  let transcriptHtml = '<div class=\"empty\">No transcript yet (session active or empty)</div>'
  if (transcript && transcript.messages && transcript.messages.length) {
    transcriptHtml = transcript.messages.map(m => {
      if (m.role === 'user') return `<div class=\"line you\"><span class=\"who\">you</span><span class=\"said\">${escapeHtml(m.text)}</span></div>`
      if (m.role === 'agent') return `<div class=\"line agent\"><span class=\"who\">${escapeHtml(AGENT.name)}</span><span class=\"said\">${escapeHtml(m.text)}</span></div>`
      if (m.role === 'tool') {
        const isError = m.error ? ' error' : ''
        return `<div class=\"line tool${isError}\"><span class=\"who\">${escapeHtml(m.name)}</span><span class=\"said\">${escapeHtml(JSON.stringify(m.arguments))} → ${escapeHtml(typeof m.result === 'string' ? m.result.slice(0,500) : JSON.stringify(m.result))}${m.error ? ' (error)' : ''}</span></div>`
      }
      return ''
    }).join('')
  }

  // tools summary for intake scribe
  let toolsSummary = ''
  if (transcript && transcript.messages) {
    const toolCalls = transcript.messages.filter(m => m.role === 'tool')
    if (toolCalls.length) {
      const byName = {}
      toolCalls.forEach(tc => {
        byName[tc.name] = (byName[tc.name] || 0) + 1
      })
      toolsSummary = Object.entries(byName).map(([k,v]) => `<span class=\"badge\">${k} ×${v}</span>`).join(' ')
    }
  }

  // timeline turns
  let timelineHtml = '<div class=\"empty\">No timeline artifact</div>'
  if (timeline && timeline.turns) {
    timelineHtml = timeline.turns.map((turn, i) => {
      const user = turn.user_transcript ? `<div class=\"t-user\">${escapeHtml(turn.user_transcript)} <span class=\"muted\">(${turn.user_confidence ? (turn.user_confidence*100).toFixed(0)+'%' : ''})</span></div>` : ''
      const agent = turn.agent_text ? `<div class=\"t-agent\">${escapeHtml(turn.agent_text)}</div>` : ''
      const tools = (turn.tool_calls||[]).map(tc => `<div class=\"t-tool\">↳ ${escapeHtml(tc.name)} ${escapeHtml(JSON.stringify(tc.arguments))} → ${escapeHtml((tc.result||'').slice(0,300))}</div>`).join('')
      const trigger = turn.trigger ? `<span class=\"badge muted\">${turn.trigger}</span>` : ''
      const status = turn.status ? `<span class=\"badge ${turn.status === 'completed' ? 'ok' : 'err'}\">${turn.status}</span>` : ''
      return `<div class=\"t-turn\"><div class=\"t-head\">#${i+1} ${trigger} ${status} <span class=\"muted\">${turn.time_to_first_audio_ms ? turn.time_to_first_audio_ms+'ms to first audio' : ''}</span></div>${user}${tools}${agent}</div>`
    }).join('')
  }

  detailEl.innerHTML = `
    <div class=\"detail-header\">
      <div class=\"detail-title\">${escapeHtml(session.id)}</div>
      <div class=\"detail-meta\">
        <span class=\"badge ${session.status === 'completed' ? 'ok' : 'err'}\">${session.status}</span>
        <span>Created: ${created}</span>
        <span>Ended: ${ended}</span>
        <span>Duration: ${duration}</span>
        <span>Reason: ${session.public_close_reason || '—'}</span>
      </div>
      <div class=\"detail-actions\">
        <button class=\"mini\" id=\"btn-refresh-detail\">Refresh</button>
        <button class=\"mini danger\" id=\"btn-delete-session\">Delete</button>
        <button class=\"mini\" id=\"btn-download-audio\" ${audioUrl ? '' : 'disabled'}>Download Audio</button>
      </div>
      <div class=\"tools-summary\">${toolsSummary}</div>
    </div>

    <div class=\"detail-tabs\">
      <button class=\"ghost tab on\" data-dtab=\"transcript\">Transcript</button>
      <button class=\"ghost tab\" data-dtab=\"audio\">Audio</button>
      <button class=\"ghost tab\" data-dtab=\"timeline\">Timeline</button>
      <button class=\"ghost tab\" data-dtab=\"tools\">Tools</button>
      <button class=\"ghost tab\" data-dtab=\"metadata\">Metadata</button>
      <button class=\"ghost tab\" data-dtab=\"raw\">Raw</button>
    </div>

    <div class=\"detail-body\">
      <div id=\"dtab-transcript\" class=\"dtab\">${transcriptHtml}</div>
      <div id=\"dtab-audio\" class=\"dtab\" hidden>
        ${audioUrl ? `
          <div class=\"audio-box\">
            <audio controls preload=\"metadata\" src=\"${audioUrl}\"></audio>
            <div class=\"muted small\" style=\"margin-top:8px\">Stereo: left=user, right=agent • OGG/Opus • URL expires soon, refresh to renew</div>
            <div style=\"margin-top:12px\"><a href=\"${audioUrl}\" target=\"_blank\" rel=\"noopener\">Open direct URL</a></div>
          </div>
        ` : '<div class=\"empty\">No audio artifact yet (session active) or expired. Refresh.</div>'}
      </div>
      <div id=\"dtab-timeline\" class=\"dtab\" hidden><div class=\"timeline-list\">${timelineHtml}</div></div>
      <div id=\"dtab-tools\" class=\"dtab\" hidden>
        <div class=\"tools-list\">
          ${transcript && transcript.messages ? transcript.messages.filter(m=>m.role==='tool').map(m=>`
            <div class=\"tool-card\">
              <div class=\"tool-name\">${escapeHtml(m.name)} ${m.error ? '<span class=\"badge err\">error</span>' : ''}</div>
              <div class=\"tool-args\"><strong>Args:</strong> <pre>${escapeHtml(JSON.stringify(m.arguments, null, 2))}</pre></div>
              <div class=\"tool-result\"><strong>Result:</strong> <pre>${escapeHtml(typeof m.result === 'string' ? m.result : JSON.stringify(m.result, null, 2))}</pre></div>
            </div>
          `).join('') || '<div class=\"empty\">No tool calls</div>' : '<div class=\"empty\">No tools</div>'}
        </div>
      </div>
      <div id=\"dtab-metadata\" class=\"dtab\" hidden>
        <pre>${escapeHtml(JSON.stringify(metadata || session.config || {}, null, 2))}</pre>
        ${metadata ? `<div style=\"margin-top:12px\"><strong>Recording metadata:</strong><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre></div>` : ''}
      </div>
      <div id=\"dtab-raw\" class=\"dtab\" hidden><pre>${escapeHtml(JSON.stringify(session, null, 2))}</pre></div>
    </div>
  `

  // tab switching
  detailEl.querySelectorAll('[data-dtab]').forEach(btn => {
    btn.onclick = () => {
      detailEl.querySelectorAll('[data-dtab]').forEach(b => b.classList.remove('on'))
      btn.classList.add('on')
      const name = btn.dataset.dtab
      detailEl.querySelectorAll('.dtab').forEach(d => d.hidden = true)
      const target = detailEl.querySelector('#dtab-' + name)
      if (target) target.hidden = false
    }
  })

  const refreshBtn = detailEl.querySelector('#btn-refresh-detail')
  if (refreshBtn) refreshBtn.onclick = () => selectSession(session.id)

  const delBtn = detailEl.querySelector('#btn-delete-session')
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('Delete session ' + session.id + '? This cannot be undone.')) return
    try {
      const res = await fetch('/api/sessions/' + session.id, { method: 'DELETE' })
      if (res.status === 204 || res.ok) {
        alert('Deleted')
        selectedSession = null
        detailEl.innerHTML = '<div class=\"empty\">Session deleted. Refresh list.</div>'
        loadSessions({ reset: true })
      } else {
        const txt = await res.text()
        alert('Delete failed: ' + txt)
      }
    } catch (e) {
      alert('Delete error: ' + e.message)
    }
  }

  const dlBtn = detailEl.querySelector('#btn-download-audio')
  if (dlBtn && audioUrl) {
    dlBtn.onclick = () => window.open(audioUrl, '_blank')
  }
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))
}

// history controls
if ($('btn-refresh-history')) $('btn-refresh-history').onclick = () => loadSessions({ reset: true })
if ($('load-more')) $('load-more').onclick = () => loadSessions({ reset: false })
if ($('filter-status')) $('filter-status').onchange = () => loadSessions({ reset: true })

}

// --- page ------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
<title>${AGENT.name} - Voice Agent + History</title>
<style>
  :root {
    --page-bg: #fdfcf8;
    --surface: #fff;
    --surface-alt: #f5f3eb;
    --border: #dad7cb;
    --border-strong: #c7c3b2;
    --text: #4a4945;
    --text-dark: #1d1b16;
    --text-muted: #777673;
    --text-faint: #a5a4a2;
    --cobolt-500: #3923c7;
    --cobolt-300: #887bdd;
    --cobolt-100: #d7d3f4;
    --green-500: #01762f;
    --error: #f04438;
    --radius-sm: 4px;
    --radius-lg: 12px;
    --font-display: \"Oceanic Text\", Georgia, serif;
    --font-body: \"UN 11ST\", system-ui, -apple-system, sans-serif;
    --font-mono: \"Modern Gothic Mono\", \"JetBrains Mono\", ui-monospace, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--font-body); font-size: 16px; line-height: 1.3;
    color: var(--text); background: var(--page-bg); display: flex;
    flex-direction: column; align-items: center; padding: 24px 20px 20px;
  }
  main { width: 100%; max-width: 1280px; flex: 1; display: flex;
         flex-direction: column; min-height: 0; gap: 16px; }
  .eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.2px;
             text-transform: uppercase; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
           padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  h1 { font-family: var(--font-display); font-size: 24px; font-weight: 400;
       letter-spacing: -1.2px; line-height: 1; color: var(--text-dark);
       margin-right: auto; }
  .status { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; }
  .status::before { content: \"\"; width: 7px; height: 7px; border-radius: 50%;
                    background: currentColor; flex-shrink: 0; }
  .status.listening { color: var(--green-500); }
  .status.speaking { color: var(--cobolt-500); }
  .status.error { color: var(--error); text-transform: none; letter-spacing: 0;
                  font-family: var(--font-body); font-size: 14px; }
  .status.listening::before, .status.speaking::before {
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  .meter { display: flex; gap: 10px; font-family: var(--font-mono); font-size: 12px;
           color: var(--text-faint); }
  #elapsed { min-width: 34px; text-align: right; }
  #cost { min-width: 48px; text-align: right; }

  .main-nav { display: flex; gap: 8px; }
  .main-nav button { height: 36px; padding: 0 16px; font-size: 12px; }
  .main-nav button.on { background: var(--text-dark); }

  .view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  [hidden] { display: none !important; }

  .panes { flex: 1; min-height: 0; display: grid; gap: 16px;
           grid-template-columns: 1fr 360px; }
  body.no-side .panes { grid-template-columns: 1fr; }
  body.no-side #side { display: none; }
  @media (max-width: 960px) {
    .panes { grid-template-columns: 1fr; grid-template-rows: 1fr 220px; }
    body.no-side .panes { grid-template-rows: 1fr; }
    .history-panes { grid-template-columns: 1fr !important; grid-template-rows: 320px 1fr; }
  }

  .pane { display: flex; flex-direction: column; min-height: 0;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-lg); overflow: hidden; }
  .pane-head { display: flex; align-items: center; justify-content: space-between;
               gap: 16px; padding: 10px 16px; background: var(--surface-alt);
               border-bottom: 1px solid var(--border); color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; }
  .pane-body { flex: 1; overflow-y: auto; padding: 16px; }
  .empty { color: var(--text-faint); font-size: 14px; line-height: 1.4; }

  #transcript { display: flex; flex-direction: column; gap: 12px; }
  .line { display: flex; gap: 12px; font-size: 16px; line-height: 1.4; }
  .who { color: var(--text-faint); padding-top: 3px; flex-shrink: 0; width: 88px;
         overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; }
  .line.agent .said { color: var(--text-dark); }
  .line.partial .said { color: var(--text-muted); }
  .line.tool { font-family: var(--font-mono); font-size: 13px;
               color: var(--cobolt-500); }
  .line.tool .said { word-break: break-all; }

  #events-body { font-family: var(--font-mono); font-size: 12px; line-height: 1.8; }
  .event { display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
  .event .at { color: var(--text-faint); min-width: 44px; text-align: right;
               flex-shrink: 0; }
  .event .dir, .event .count { color: var(--text-faint); flex-shrink: 0; }
  .event .count:empty, .event .detail:empty { display: none; }
  .event .type { flex-shrink: 0; color: var(--text-dark); }
  .event.up .type { color: var(--text-muted); }
  .event .detail { color: var(--text-faint); overflow: hidden; white-space: nowrap;
                   text-overflow: ellipsis; }

  .pane-foot { display: flex; gap: 8px; align-items: center; padding: 12px 16px;
               background: var(--surface-alt); border-top: 1px solid var(--border); }
  button { height: 40px; padding: 0 24px; margin-left: auto; border: none;
           border-radius: var(--radius-sm); background: var(--cobolt-500);
           color: #fff; font-family: var(--font-mono); font-size: 14px;
           letter-spacing: 1.4px; text-transform: uppercase; white-space: nowrap;
           cursor: pointer; transition: background-color .2s; }
  button:hover:not(:disabled) { background: var(--cobolt-300); }
  button:disabled { opacity: .55; cursor: default; }
  button.live { background: var(--error); }
  button.live:hover { background: #f4695f; }
  button.mini { height: 28px; padding: 0 12px; font-size: 11px; letter-spacing: 0.8px; margin-left: 0; }
  button.mini.danger { background: var(--error); }
  button.mini.danger:hover { background: #f4695f; }
  select { flex: 0 1 220px; min-width: 0; height: 40px; padding: 0 8px;
           font-family: var(--font-body); font-size: 13px; color: var(--text-muted);
           background: var(--surface); border: 1px solid var(--border);
           border-radius: var(--radius-sm); }
  select:disabled { color: var(--text-faint); }
  .ghost { height: auto; margin-left: 0; padding: 0; background: transparent;
           color: var(--text-faint); font-size: 12px; letter-spacing: 1.2px; }
  .ghost:hover:not(:disabled) { background: transparent; color: var(--cobolt-500); }
  .ghost.on { color: var(--text-dark); }
  .tabs { display: flex; gap: 16px; }
  #agent-body pre, .detail-body pre { font-family: var(--font-mono); font-size: 12px;
                    line-height: 1.6; color: var(--text); white-space: pre-wrap;
                    word-break: break-word; }

  /* History specific */
  .history-panes { flex: 1; min-height: 0; display: grid; gap: 16px; grid-template-columns: 380px 1fr; }
  .history-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .history-controls select { height: 32px; flex: 0 1 140px; }
  .sessions-list { display: flex; flex-direction: column; gap: 8px; }
  .session-row { display: flex; gap: 8px; align-items: center; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer; transition: border-color 0.2s; }
  .session-row:hover { border-color: var(--cobolt-300); }
  .session-row.selected { border-color: var(--cobolt-500); background: var(--cobolt-100); }
  .s-main { flex: 1; min-width: 0; }
  .s-id { font-family: var(--font-mono); font-size: 12px; color: var(--text-dark); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; flex-wrap: wrap; }
  .s-time { font-size: 12px; color: var(--text-muted); }
  .s-dur { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
  .s-reason { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; background: var(--surface-alt); border: 1px solid var(--border); }
  .badge.ok { background: #e6f4ea; color: var(--green-500); border-color: #b7e1c5; }
  .badge.err { background: #fdecea; color: var(--error); border-color: #f5b5b0; }
  .badge.muted { background: var(--surface-alt); color: var(--text-muted); }

  .detail-header { padding: 12px 0 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .detail-title { font-family: var(--font-mono); font-size: 13px; color: var(--text-dark); word-break: break-all; }
  .detail-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--text-muted); }
  .detail-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .tools-summary { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }

  .detail-tabs { display: flex; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .detail-body { flex: 1; overflow-y: auto; }
  .dtab { min-height: 100px; }
  .audio-box { padding: 16px; background: var(--surface-alt); border-radius: var(--radius-sm); border: 1px solid var(--border); }
  .audio-box audio { width: 100%; }
  .muted { color: var(--text-faint); }
  .small { font-size: 12px; }
  .timeline-list { display: flex; flex-direction: column; gap: 16px; }
  .t-turn { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
  .t-head { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .t-user { color: var(--text-dark); margin-bottom: 6px; }
  .t-agent { color: var(--cobolt-500); }
  .t-tool { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin: 4px 0; word-break: break-all; background: var(--surface-alt); padding: 4px 8px; border-radius: 4px; }
  .tool-card { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 12px; background: var(--surface); }
  .tool-name { font-family: var(--font-mono); font-size: 13px; font-weight: bold; color: var(--text-dark); margin-bottom: 8px; }
  .tool-args, .tool-result { margin-top: 8px; font-size: 12px; }
  .tool-args pre, .tool-result pre { background: var(--surface-alt); padding: 8px; border-radius: 4px; overflow-x: auto; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${AGENT.name}</h1>
    <span class=\"status idle\" id=\"status\"><span id=\"status-text\">idle</span></span>
    <span class=\"meter\"><span id=\"elapsed\">0:00</span><span id=\"cost\">$0.000</span></span>
    <div class=\"main-nav\">
      <button class=\"mini on\" id=\"main-tab-live\">Live Call</button>
      <button class=\"mini\" id=\"main-tab-history\">History</button>
    </div>
  </header>

  <!-- LIVE VIEW -->
  <div id=\"view-live\" class=\"view\">
    <div class=\"panes\">
      <section class=\"pane\">
        <div class=\"pane-head\">
          <span>Transcript</span>
          <span style=\"display:flex; gap:12px; align-items:center\">
            <span id=\"live-session-id\" style=\"font-family:var(--font-mono); font-size:10px; color:var(--text-faint); max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap\"></span>
            <button class=\"ghost\" id=\"last-session-link\" hidden>View last in history →</button>
          </span>
        </div>
        <div class=\"pane-body\" id=\"transcript\">
          <div class=\"empty\">Start the call and talk. Partial transcripts appear as they stream, and tool calls show up inline.<br><br>For <strong>AI Voice Intake Scribe</strong>: try \"I have headache for 3 days, taking 20mg Lisinopril\" to trigger flag_medical_entity.</div>
        </div>
        <div class=\"pane-foot\">
          <select id=\"mic\" aria-label=\"Microphone\"><option value=\"\">Default microphone</option></select>
          <button id=\"btn\">Start call</button>
        </div>
      </section>
      <section class=\"pane\" id=\"side\">
        <div class=\"pane-head\">
          <span class=\"tabs\">
            <button class=\"ghost tab on\" id=\"tab-events\">Events</button>
            <button class=\"ghost tab\" id=\"tab-agent\">Agent</button>
          </span>
          <button class=\"ghost\" id=\"log-toggle\">Hide</button>
        </div>
        <div class=\"pane-body\" id=\"events-body\">
          <div class=\"empty\">Every websocket frame, both directions. Repeats collapse into a count.</div>
        </div>
        <div class=\"pane-body\" id=\"agent-body\" hidden>
          <div class=\"empty\">Loading the published agent.</div>
        </div>
      </section>
    </div>
  </div>

  <!-- HISTORY VIEW -->
  <div id=\"view-history\" class=\"view\" hidden>
    <div class=\"history-panes\">
      <section class=\"pane\">
        <div class=\"pane-head\">
          <span>Sessions</span>
          <div class=\"history-controls\">
            <select id=\"filter-status\">
              <option value=\"\">All statuses</option>
              <option value=\"completed\" selected>Completed</option>
              <option value=\"active\">Active</option>
              <option value=\"failed\">Failed</option>
            </select>
            <button class=\"mini\" id=\"btn-refresh-history\">Refresh</button>
          </div>
        </div>
        <div class=\"pane-body\">
          <div id=\"history-status\" class=\"muted small\" style=\"margin-bottom:12px\">Loading…</div>
          <div id=\"sessions-list\" class=\"sessions-list\"></div>
          <div style=\"margin-top:16px; text-align:center\">
            <button class=\"mini\" id=\"load-more\" hidden>Load more</button>
          </div>
        </div>
      </section>
      <section class=\"pane\">
        <div class=\"pane-head\"><span>Session Detail</span><span class=\"muted small\">Audio • Transcript • Timeline • Tools • Metadata</span></div>
        <div class=\"pane-body\" id=\"session-detail\">
          <div class=\"empty\">Select a session from the left to view its recording, parsed transcript, tool calls (flag_medical_entity, generate_soap_note), and metadata.<br><br>
          <strong>Features added from session-history docs:</strong><br>
          • List sessions with cursor pagination<br>
          • Retrieve full session + artifacts (audio, timeline, metadata)<br>
          • Parse timeline into user/agent/tool messages<br>
          • Stereo playback (left=user, right=agent)<br>
          • Tool call inspection for intake scribe<br>
          • Delete sessions<br>
          • Auto-refresh after live call ends
          </div>
        </div>
      </section>
    </div>
  </div>
</main>
<script>window.AGENT = ${JSON.stringify(AGENT).replace(/</g, '\\u003c')}</script>
<script src=\"/app.js\"></script>
</body>
</html>`

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
      const token = await aai('/token?product=voice_agent&expires_in_seconds=60')
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
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('(' + clientApp.toString() + ')();')
    return
  }

  // --- NEW: Session History API proxy (keeps ASSEMBLYAI_API_KEY server-side) ---
  if (pathname === '/api/sessions' && req.method === 'GET') {
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

  // default: serve HTML
  res.writeHead(200, { 'content-type': 'text/html' })
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
server.on('listening', () => console.log(`Talk to it: http://localhost:${port} | History API: /api/sessions`))
server.listen(port)
