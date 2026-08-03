// regen-audio.mjs — regenerate ONLY the briefing voice-over for the CURRENT live
// edition, without a full (Gemini news) rebuild. Reads the spoken script already
// embedded in public/index.html, re-synthesises the MP3 via Gemini TTS, and points
// the page at it. Run by .github/workflows/regen-audio.yml (needs GEMINI_API_KEY).
// Use when a build's voice-over fell back to the browser voice — TTS-only cost (~₹3),
// no news re-run, no seen.json impact.
import fs from 'fs';
import path from 'path';
import { synthesizeBriefing } from '../src/tts.js';

const FILE = path.join(process.cwd(), 'public', 'index.html');
let html = fs.readFileSync(FILE, 'utf8');

const m = html.match(/id="audio-script">([\s\S]*?)<\/script>/);
if (!m) { console.log('No audio-script block found — nothing to regenerate.'); process.exit(0); }

let segments;
try { segments = JSON.parse(m[1].replace(/\\u003c/g, '<')); }
catch (e) { console.log(`audio-script JSON unreadable (${e.message}).`); process.exit(1); }

const script = segments.map((s) => s && s.text).filter(Boolean).join('\n\n');
if (script.length < 80) { console.log('Embedded script too short — skipping.'); process.exit(0); }

console.log(`Regenerating voice from the live script (${script.length} chars, ${segments.length} segments)…`);
const mp3 = await synthesizeBriefing(script);
if (!mp3) { console.log('TTS did not return audio — leaving the browser-voice fallback in place.'); process.exit(1); }

fs.writeFileSync(path.join(process.cwd(), 'public', 'briefing.mp3'), mp3);
// Point the page at the freshly-made MP3 (it was '' because the build's TTS failed).
html = html.replace('__BRIEFING_AUDIO__=""', '__BRIEFING_AUDIO__="briefing.mp3"');
fs.writeFileSync(FILE, html);
console.log('✅ briefing.mp3 written and the page now points at it.');
