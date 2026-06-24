// voice-samples.js — generate a short MP3 sample of each candidate Gemini TTS voice
// reading the same finance line, so the voice can be chosen BY EAR. Runs in CI (it
// needs GEMINI_API_KEY). Output goes to voice-samples/<Voice>.mp3 and the workflow
// publishes them to a GitHub release for direct listening.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import lamejs from '@breezystack/lamejs';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash-preview-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
const RATE = 24000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'voice-samples');

// A curated shortlist — a mix of timbres (warmer/female-leaning and deeper/male-
// leaning) suited to a poised Indian-English business anchor.
const VOICES = [
  { name: 'Sulafat',      note: 'warm (current)' },
  { name: 'Vindemiatrix', note: 'gentle' },
  { name: 'Kore',         note: 'firm, composed' },
  { name: 'Achird',       note: 'friendly' },
  { name: 'Charon',       note: 'informative' },
  { name: 'Gacrux',       note: 'mature' },
  { name: 'Alnilam',      note: 'deep, firm' },
  { name: 'Iapetus',      note: 'clear' },
];

const STYLE = 'Read this in the warm, polished voice of a senior Indian English business-news anchor — natural human intonation, unhurried, gentle emphasis on the figures:';
const TEXT = 'Good morning, and welcome to your Guardian Times briefing. The Sensex slipped over one percent today as weak global cues weighed on sentiment, while the rupee held steady near ninety-four to the dollar.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pcmToMp3(pcm, kbps = 64) {
  const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  const samples = new Int16Array(ab, 0, ab.byteLength >> 1);
  const enc = new lamejs.Mp3Encoder(1, RATE, kbps);
  const out = []; const block = 1152 * 50;
  for (let i = 0; i < samples.length; i += block) {
    const m = enc.encodeBuffer(samples.subarray(i, Math.min(i + block, samples.length)));
    if (m.length) out.push(Buffer.from(m));
  }
  const e = enc.flush(); if (e.length) out.push(Buffer.from(e));
  return Buffer.concat(out);
}

async function synth(voice) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${STYLE}\n\n${TEXT}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const b64 = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!b64) throw new Error('no audio');
  return pcmToMp3(Buffer.from(b64, 'base64'));
}

fs.mkdirSync(OUT, { recursive: true });
for (const v of VOICES) {
  try {
    const mp3 = await synth(v.name);
    fs.writeFileSync(path.join(OUT, `${v.name}.mp3`), mp3);
    console.log(`✅ ${v.name} (${v.note}) — ${(mp3.length / 1024) | 0} KB`);
  } catch (e) {
    console.log(`⚠ ${v.name}: ${e.message}`);
  }
  await sleep(800);
}
console.log('done');
process.exit(0);
