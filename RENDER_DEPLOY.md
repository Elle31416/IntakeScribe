# Render Deploy Guide - AI Voice Intake Scribe + Session History

This repo now includes a full Session History dashboard built from https://www.assemblyai.com/docs/voice-agents/voice-agent-api/session-history

## What's deployed

- **Agent:** `AI Voice Intake Scribe` (`agents/ai-voice-intake-scribe.jsonc`)
  - Tools: `flag_medical_entity`, `add_followup_item`, `generate_soap_note`
  - Voice: `alba`
  - Keyterms: Lisinopril, Metformin, Ozempic, etc.

- **Browser App + History Dashboard:** `deployment/browser/server.mjs`
  - Live Call: WebSocket to AssemblyAI, transcript, events, cost meter
  - History: List sessions, pagination, audio playback (stereo left=user right=agent), timeline parsing, tool inspection, delete

## Deploy to Render (Blueprint)

### Option 1: One-click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AssemblyAI/voice-agent-starter-js)

1. Click Deploy to Render
2. Render reads `render.yaml` and prompts for:
   - `ASSEMBLYAI_API_KEY` = `94952aaa38db4dda8313417937ab24c8` (or your production key from https://www.assemblyai.com/dashboard/api-keys)
3. Set:
   - `AGENT` = `ai-voice-intake-scribe`
   - `AGENT_ID` = `agent_b0aca15004de4ab2b39bbfc1ce360956` (optional but recommended for prod - ensures phone + browser use same agent)
4. Deploy → Render gives you `https://your-service.onrender.com`

### Option 2: Manual Web Service

1. In Render Dashboard → New → Web Service → Connect your GitHub repo
2. Settings:
   - Runtime: Node
   - Build Command: `true` (no dependencies, Node 18+)
   - Start Command: `npm start`
   - Plan: Free
3. Environment:
   - `ASSEMBLYAI_API_KEY` = your key (secret)
   - `AGENT` = `ai-voice-intake-scribe`
   - `AGENT_ID` = `agent_b0aca15004de4ab2b39bbfc1ce360956` (optional)
   - `PORT` = auto-set by Render
4. Deploy

### After Deploy

- Open `https://your-service.onrender.com`
- **Live Call tab:** Start call, test intake flow: "headache 3 days, 20mg Lisinopril"
- **History tab:** Should auto-populate after first call ends
  - Lists `GET /v1/sessions?agent_id=...&status=completed`
  - Click View → Transcript (parsed via timeline), Audio (OGG/Opus pre-signed URL), Timeline, Tools, Metadata, Raw
  - Audio URLs expire quickly - frontend re-fetches via `/api/sessions/:id/audio` right before playback
  - Delete uses `DELETE /v1/sessions/:id`

### Session History API - How it works (from docs)

Server keeps `ASSEMBLYAI_API_KEY` secret, proxies:

```
GET  /api/sessions?limit=50&agent_id=&status=&cursor=
GET  /api/sessions/:id
GET  /api/sessions/:id/audio      → { url } pre-signed S3
GET  /api/sessions/:id/timeline   → timeline.json artifact
GET  /api/sessions/:id/transcript → flattened messages
GET  /api/sessions/:id/metadata   → recording metadata
DELETE /api/sessions/:id          → 204
```

Parsing logic (from docs):
```js
for (turn of timeline.turns ?? []) {
  if (turn.user_transcript) messages.push({role:'user', text: turn.user_transcript})
  for (call of turn.tool_calls ?? []) messages.push({role:'tool', name: call.name, arguments: call.arguments, result: call.result})
  if (turn.agent_text) messages.push({role:'agent', text: turn.agent_text})
}
```

Audio is stereo: left=user, right=agent. OGG/Opus plays in Chrome/Firefox/Edge; transcode with `ffmpeg -i recording.ogg recording.m4a` for Safari.

### Security

- API key never reaches browser - only 60s tokens via `/token` and short-lived artifact URLs via `/api/sessions/:id/audio`
- Anyone with deployed URL can start sessions billed to that key
- `.env` is gitignored - never commit `ASSEMBLYAI_API_KEY`

### Local test before pushing

```bash
cd voice-agent-starter-js
cp .env.example .env
echo "ASSEMBLYAI_API_KEY=your_key" >> .env
npm run import agent_b0aca15004de4ab2b39bbfc1ce360956
AGENT=ai-voice-intake-scribe npm start
# http://localhost:3000
```

### Push to GitHub (your repo)

```bash
git remote remove origin # optional, if you want to replace
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git add .
git commit -m "feat: intake scribe + session history dashboard + render deploy"
git push -u origin main
```

If using PAT:
```bash
export GITHUB_TOKEN=your_pat
git remote set-url origin https://oauth2:$GITHUB_TOKEN@github.com/YOUR_USERNAME/YOUR_REPO.git
git push
```

### Environment variables on Render

| Variable | Default | Purpose |
|---|---|---|
| ASSEMBLYAI_API_KEY | prompt | Secret, stays server-side |
| AGENT | ai-voice-intake-scribe | Which file in agents/ to publish on boot |
| AGENT_ID | empty | Exact agent id to serve (same as phone) |
| PORT | Render sets | Listening port |

### Troubleshooting

- **No sessions in History:** Make a call first, wait 2s after End call, click Refresh. Check filter status=completed
- **Audio not playing:** URL expired - click Refresh Detail to get new pre-signed URL
- **Bad credentials on GitHub push:** Regenerate PAT at https://github.com/settings/tokens with repo scope, use `Authorization: Bearer <pat>` or `https://<pat>@github.com/...`
- **Render build fails:** Ensure Node >=18, `npm start` works locally
