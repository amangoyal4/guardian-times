// tts.js — build-time text-to-speech for the morning audio briefing.
//
// Uses GEMINI TTS (same key + endpoint as the editorial model). Google's dedicated
// en-IN voices live on Cloud Text-to-Speech, which rejects API keys (needs OAuth),
// so we use Gemini's TTS and steer it hard toward warm Indian-English anchor
// delivery via a style directive. The script (written for the ear in summarize.js)
// is synthesised to a single MP3 the page plays — so every listener hears the same
// human voice instead of the browser's robotic built-in, with real seek/scrub.
//
// Output from Gemini TTS is raw 16-bit/24 kHz/mono PCM (audio/L16); we concatenate
// the per-chunk PCM and encode ONE MP3 in pure JS (no ffmpeg on the CI runner).
// Best-effort: any failure returns null and the page falls back to the browser voice.

import lamejs from '@breezystack/lamejs';

const API_KEY = process.env.GEMINI_API_KEY;
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
// Warm, clear, mature prebuilt voice. Override with GEMINI_TTS_VOICE to taste
// (e.g. Sulafat=warm, Gacrux=mature, Sadaltager=knowledgeable, Charon=informative).
const VOICE = process.env.GEMINI_TTS_VOICE || 'Sulafat';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${API_KEY}`;
const RATE = 24000; // Gemini TTS: 24 kHz, 16-bit, mono PCM

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The directive that makes the voice feel like a real Indian anchor, not a robot.
// Phrased as "instruction:" — Gemini TTS treats a leading directive ending in a
// colon as delivery guidance and speaks only the text that follows it.
const STYLE =
  'Read this aloud in the warm, polished voice of a senior Indian English business-news anchor. CRITICAL: speak at a STEADY, EVEN, MEASURED pace of about 150 words per minute and HOLD EXACTLY THAT SAME TEMPO from the first word to the last — never speed up, never slow down, keep the rhythm perfectly consistent throughout. Natural human intonation, gentle emphasis on the key figures, and a brief natural pause between stories. Calm, clear and unrushed, like a real person speaking to one listener, never robotic:';

// Split a long script into TTS-sized chunks on sentence boundaries. Gemini TTS caps
// how much audio a single call returns, so we synthesise per chunk and join the PCM.
function chunkScript(text, maxChars = 1100) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > maxChars && cur) { chunks.push(cur.trim()); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

async function synthChunk(text, { tries = 4, style = true } = {}) {
  let delay = 3000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: style ? `${STYLE}\n\n${text}` : text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          },
        }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(delay); delay *= 2; continue; }
      if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const b64 = part?.inlineData?.data;
      if (!b64) throw new Error('no audio in TTS response');
      return Buffer.from(b64, 'base64'); // raw PCM16LE @ 24 kHz mono
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(delay); delay *= 2;
    }
  }
  throw new Error('TTS exhausted retries');
}

// Concatenated PCM bytes -> MP3 Buffer. Copies into a fresh, aligned ArrayBuffer
// first (a base64 Buffer may sit at an odd offset, which Int16Array can't view).
function pcmToMp3(pcm, kbps = 64) {
  const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  const samples = new Int16Array(ab, 0, ab.byteLength >> 1);
  const enc = new lamejs.Mp3Encoder(1, RATE, kbps);
  const out = [];
  const block = 1152 * 50;
  for (let i = 0; i < samples.length; i += block) {
    const mp3 = enc.encodeBuffer(samples.subarray(i, Math.min(i + block, samples.length)));
    if (mp3.length) out.push(Buffer.from(mp3));
  }
  const end = enc.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}

/**
 * Synthesise the briefing script into an MP3 Buffer, or null on any failure.
 * @param {string} scriptText  the spoken briefing script (already written for the ear)
 */
export async function synthesizeBriefing(scriptText, { gapMs = 800 } = {}) {
  if (!API_KEY) return null;
  const text = String(scriptText || '').trim();
  if (text.length < 80) return null;
  const chunks = chunkScript(text);
  console.log(`\n🔊 Synthesising briefing voice — ${chunks.length} chunk(s) via ${TTS_MODEL} (voice: ${VOICE})…`);
  // Per-chunk resilient: a single chunk that keeps returning "no audio" (a transient
  // hiccup or a content-refusal on one segment) must NOT throw away the whole voice.
  // Try the styled prompt; if that fails, retry the chunk WITHOUT the style directive
  // (which can trip a refusal); only then skip that chunk. As long as most chunks
  // synthesise, we still serve the human MP3 (minus at most a segment or two).
  const pcms = [];
  const chunkSecs = []; // real audio seconds per chunk, aligned to chunks[] (0 = skipped)
  let ok = 0, skipped = 0;
  for (let i = 0; i < chunks.length; i++) {
    let pcm = null;
    try {
      pcm = await synthChunk(chunks[i]);
      ok++;
    } catch (err1) {
      try {
        pcm = await synthChunk(chunks[i], { tries: 2, style: false });
        ok++;
        console.log(`   ↻ chunk ${i + 1}/${chunks.length} recovered without the style directive.`);
      } catch (err2) {
        console.log(`   ⚠ chunk ${i + 1}/${chunks.length} skipped (${err2.message}).`);
        skipped++;
      }
    }
    if (pcm) { pcms.push(pcm); chunkSecs.push(pcm.byteLength / 2 / RATE); }
    else { chunkSecs.push(0); }
    if (i < chunks.length - 1) await sleep(gapMs);
  }
  // Serve the human voice only if a solid majority came through; otherwise the
  // browser voice is the cleaner fallback than a heavily-gapped briefing.
  if (!pcms.length || ok < Math.ceil(chunks.length * 0.6)) {
    console.log(`  ⚠ briefing voice synthesis failed (${ok}/${chunks.length} chunks); page falls back to the browser voice.\n`);
    return null;
  }
  try {
    const pcm = Buffer.concat(pcms);
    const mp3 = pcmToMp3(pcm);
    const secs = pcm.byteLength / 2 / RATE;
    console.log(`   voice ready — ${(mp3.length / 1e6).toFixed(2)} MB MP3, ~${Math.round(secs)}s (${(secs / 60).toFixed(1)} min), ${ok}/${chunks.length} chunks\n`);
    // Timing map for ACCURATE audio chapters: cumulative {words, sec} at each chunk
    // boundary using the REAL measured chunk durations. Only when nothing was skipped
    // (a skipped chunk breaks the word↔audio alignment); otherwise null and the build
    // falls back to a plain word-fraction estimate.
    let timing = null;
    if (!skipped) {
      timing = [{ words: 0, sec: 0 }];
      let cw = 0, cs = 0;
      for (let i = 0; i < chunks.length; i++) {
        cw += chunks[i].trim().split(/\s+/).filter(Boolean).length;
        cs += chunkSecs[i];
        timing.push({ words: cw, sec: cs });
      }
    }
    return { mp3, timing };
  } catch (err) {
    console.log(`  ⚠ MP3 encode failed (${err.message}); page falls back to the browser voice.\n`);
    return null;
  }
}
