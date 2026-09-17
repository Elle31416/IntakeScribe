🎙️ IntakeScribe

Your visit starts with your voice.

A voice-first clinical intake prototype built with the AssemblyAI Voice Agent API.
Explore the repository (https://github.com/Elle31416/IntakeScribe) · Deployment guide (./RENDER_DEPLOY.md) · AssemblyAI (https://www.assemblyai.com/)
-------------------------

Less paperwork. More room for your story.

Before a medical appointment, patients are often asked to compress their concerns into forms. A conversation offers a different starting point: explaining what brings them in, in their own words.
IntakeScribe brings that conversation into the browser.
An AI voice intake agent conducts the conversation, while a session-history dashboard brings together the available transcript, recording, timeline, and tool activity for later review.
> **Our goal is not to replace the clinician. It is to make the conversation before the visit easier to capture and revisit.**

-------------------------

✨ What it does

1. Start a voice intake

Connect to the configured AssemblyAI voice agent directly from a browser.
2. Share your story

Talk through the reason for your visit in a voice conversation rather than starting with a blank form.
3. Revisit the session

Open session history to inspect the available transcript, listen to the recording, and explore session activity.

Patient speaks
      ↓
AssemblyAI Voice Agent
      ↓
Intake conversation
      ↓
Session History
 ├── Transcript
 ├── Audio playback
 ├── Timeline
 └── Tool activity


Artifact availability depends on the session and upstream processing.
-------------------------

🏆 Why this project stands out

More than a voice demo

The experience continues after the call. IntakeScribe connects a live interaction to a practical review workflow.
Original words remain accessible

Transcripts and available recordings let a reviewer return to what was actually said—not only an interpretation of it.
AssemblyAI is central to the product

The AssemblyAI Voice Agent API powers the conversation. It is not an incidental feature added to an otherwise unrelated application.
A focused, extensible foundation

The project builds on AssemblyAI’s JavaScript voice-agent starter, with JSON-defined agents and a lightweight Node.js runtime.
A clear boundary around clinical responsibility

IntakeScribe supports intake capture and review. It does not claim to diagnose, prescribe, or replace professional judgment.
-------------------------

🧩 Current capabilities

| Capability | What it provides |
|---|---|
| **Browser voice calls** | Connect to the configured voice intake agent |
| **Session history** | List and reopen previous sessions |
| **Transcript parsing** | Present conversation content for review |
| **Audio playback** | Listen to available session recordings |
| **Session timeline** | Inspect available session events |
| **Tool activity** | Review tool interactions exposed by the integration |
| **Session deletion** | Invoke the existing session-delete operation |
| **Render deployment** | Deploy using the repository’s documented setup |



Configured agent: AI Voice Intake Scribe

agent_b0aca15004de4ab2b39bbfc1ce360956


The upstream starter also supports phone-number setup through Twilio. The primary hackathon experience is the browser-based intake and review workflow.
-------------------------

🎬 Judge walkthrough

A short path through the product

1. Open Live Call
Start a browser session and allow microphone access.
2. Use a fictional intake scenario
For example:
> “I’d like to talk about some knee soreness that started after a long walk.”

Use synthetic details—not real patient information.
3. Have a brief conversation
Observe how the configured voice agent conducts the intake.
4. End the call and open History
Wait for the session and its artifacts to become available.
5. Review the evidence
Read the transcript, play available audio, and inspect the timeline or tool activity where present.
What to evaluate

- Does voice feel like a useful starting point for intake?
- Is the resulting conversation easy to revisit?
- Does the application make the AssemblyAI integration visible and understandable?
- Are missing or processing artifacts represented honestly?
-------------------------

🏥 Demo experience: Riverdale Previsit

Riverdale Previsit is the proposed fictional clinic identity for the frontend presentation.
Suggested landing banner

> ## Your visit starts with your voice.
> Less paperwork. More room for your story.
>
> Talk through what brings you in, then revisit the conversation through transcripts and available recordings.
>
> **Start voice intake** · **Explore a sample session**

The visual direction is calm and approachable: warm ivory, deep evergreen, clear typography, and a focused voice interface.
Riverdale is a demo identity, not a claimed healthcare partnership. This branding is a presentation direction, not an additional backend capability.
-------------------------

⚙️ How it works


┌─────────────────────────────────────────────┐
│ Browser frontend                            │
│ Live Call · History · Transcript · Playback  │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│ Existing Node.js application                │
│ Serves the UI · Mints session tokens         │
│ Supports the existing history integration   │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────┐
│ AssemblyAI Voice Agent API                  │
│ Voice-agent sessions and available artifacts│
└─────────────────────────────────────────────┘


Technology

- Runtime: Node.js 18 or later
- Application foundation: AssemblyAI Voice Agent Starter for JavaScript
- Agent definitions: JSON/JSONC
- Voice platform: AssemblyAI Voice Agent API
- Hosting: Render deployment configuration
- Optional telephony: Twilio SIP integration inherited from the starter
The AssemblyAI API key stays on the server. The browser connects using session credentials issued through the existing application.
-------------------------

🚀 Run locally

Prerequisites

- Node.js 18+
- An AssemblyAI API key
- An agent accessible to your AssemblyAI account
1. Clone the repository


git clone https://github.com/Elle31416/IntakeScribe.git
cd IntakeScribe
cp .env.example .env


2. Configure the environment


ASSEMBLYAI_API_KEY=your_assemblyai_api_key
AGENT=ai-voice-intake-scribe
AGENT_ID=your_accessible_agent_id


Use the configured project agent only if your account has access to it. Otherwise, publish the included intake-agent definition to your own account using the repository’s publishing workflow.
3. Start the application


npm start


Open:

http://localhost:3000


> Review the startup configuration before running: the starter can publish or update the selected agent when an explicit agent ID is not supplied.

-------------------------

☁️ Deploy on Render

Follow RENDER_DEPLOY.md (./RENDER_DEPLOY.md) for the repository-specific instructions.
The documented intake configuration uses:

ASSEMBLYAI_API_KEY=your_assemblyai_api_key
AGENT=ai-voice-intake-scribe
AGENT_ID=your_accessible_agent_id


Keep API keys in server-side environment settings. Never commit secrets or place them in frontend JavaScript.
Public-demo warning: Anyone with the deployment URL can start billable sessions under the configured key. A frontend warning or hidden button is not access control.
-------------------------

🛡️ Responsible use

IntakeScribe is a hackathon prototype—not a production clinical system.
- Use fictional patient information during demonstrations.
- Do not use it for emergencies.
- Do not treat agent responses as medical advice.
- Do not rely on transcripts as error-free medical records.
- Have an appropriately qualified person review information before clinical use.
- Do not assume HIPAA compliance, clinical validation, or production-grade privacy controls.
- Do not assume session deletion removes every upstream copy; deletion follows the existing API’s semantics.
Real-world deployment would require appropriate security, access control, consent, retention policies, and clinical review beyond this prototype.
-------------------------

🗺️ Frontend polish roadmap

The following are planned presentation improvements, not claims about already implemented features:
- Riverdale Previsit landing experience.
- Clearer microphone, connection, and call-ending states.
- Responsive session-review workspace.
- Transcript-to-audio seeking where timestamps support it.
- Clearly labeled synthetic sample session.
- Improved keyboard navigation and reduced-motion support.
- More polished empty, loading, and error states.
Scope: Preserve the existing backend, agent configuration, API contracts, and deployment behavior.
-------------------------

🙌 Acknowledgments

Built on the AssemblyAI Voice Agent Starter for JavaScript (https://github.com/AssemblyAI/voice-agent-starter-js).
This fork extends that foundation into a clinical-intake prototype with a session-history and review experience.
-------------------------

A conversation worth revisiting.

IntakeScribe brings voice intake and session review together—so the story does not disappear when the call ends.
