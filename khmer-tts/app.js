/* =====================================================================
 * Khmer TTS Studio — 100% client-side (no server, no build step)
 *
 *   • Bring-Your-Own-Token (BYOT) with automatic rotation on quota / 429
 *   • SRT upload → text-only extraction → chunks ≤ 1400 characters
 *   • Sequential queue; every finished chunk appears as an <audio> player
 *
 * The Gradio client is imported from a CDN at runtime (see GRADIO_CDNS).
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 1. CONFIG
 * ------------------------------------------------------------------- */

// jsDelivr first (as requested); esm.sh is only a fallback if the first CDN fails.
// Tip: pin a version for production, e.g. ".../npm/@gradio/client@1.x.y/dist/index.min.js".
const GRADIO_CDNS = [
  'https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js',
  'https://esm.sh/@gradio/client'
];

const CFG = {
  DEFAULT_SPACE: 'muyleanging/VoxPocket-TTS-Demo',   // the Space this project already used; changeable in the UI (Advanced)
  ENDPOINT: '/predict',                   // app.predict("/predict", [chunkText, voice])
  VOICES: ['Man 1', 'Woman 1', 'Woman 2'],
  DEFAULT_VOICE: 'Man 1',
  MAX_CHUNK: 1400,                        // hard ceiling per chunk (API limit is 1500)
  TRANSIENT_RETRIES: 2                    // retries on the same token for flaky network errors
};

// The VoxPocket demo Space (muyleanging/VoxPocket-TTS-Demo) has no "/predict": it exposes
// "/pick_voice" + "/clone" instead. If the chosen Space looks like that, we use these.
const LEGACY = { pick: '/pick_voice', clone: '/clone', style: 'None (plain)', cfg: 2, steps: 10, seed: 0 };

/* ---------------------------------------------------------------------
 * 2. SMALL HELPERS
 * ------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Length in Unicode code points (matches how Python counts characters on the server). */
const len = (s) => Array.from(s).length;

const store = {
  get(k) { try { return localStorage.getItem('ktts.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ktts.' + k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem('ktts.' + k); } catch { /* ignore */ } }
};

function makeError(kind, message) { const e = new Error(message); e.kind = kind; return e; }

/* ---------------------------------------------------------------------
 * 3. SRT PARSER  (text only — no numbers, no timestamps)
 * ------------------------------------------------------------------- */
const TIMESTAMP_RE = /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;

/** Returns an array of subtitle text lines (one entry per cue). */
function parseSrt(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const t = lines.findIndex((l) => TIMESTAMP_RE.test(l));
    // Normal block: [index] / timestamp / text…  → keep only what follows the timestamp.
    // Malformed block (no timestamp): drop pure-number lines, keep the rest.
    const body = t >= 0 ? lines.slice(t + 1) : lines.filter((l) => !/^\d+$/.test(l));
    const cleaned = body
      .map((l) => l.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    if (cleaned) cues.push(cleaned);
  }
  return cues;
}

/* ---------------------------------------------------------------------
 * 4. CHUNKING  (every chunk ≤ max characters)
 * ------------------------------------------------------------------- */

/** Last resort for text with no sentence marks: split on spaces, then on grapheme clusters. */
function hardSplit(s, max) {
  const graphemes = (str) => (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? Array.from(new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(str), (x) => x.segment)
    : Array.from(str);
  const out = [];
  let cur = '';
  for (const w of s.split(' ')) {
    let word = w;
    while (len(word) > max) {                      // a single "word" longer than max
      if (cur) { out.push(cur); cur = ''; }
      let piece = '', n = 0;
      const rest = [];
      for (const g of graphemes(word)) {
        const gl = len(g);
        if (rest.length === 0 && n + gl <= max) { piece += g; n += gl; } else rest.push(g);
      }
      out.push(piece);
      word = rest.join('');
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (len(cur) + 1 + len(word) <= max) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split one over-long line at sentence marks (។ ៕ . ! ?) and re-pack into pieces ≤ max. */
function splitLong(line, max) {
  const sentences = line.match(/[^។៕!?.]+[។៕!?.]*\s*/g) || [line];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    if (len(s) > max) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(...hardSplit(s, max));
    } else if (!cur) cur = s;
    else if (len(cur) + 1 + len(s) <= max) cur += ' ' + s;
    else { out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Combines text lines (one per line / subtitle cue) into chunks.
 * Guarantee: len(chunk) <= max for every chunk.
 */
function chunkText(text, max = CFG.MAX_CHUNK) {
  const units = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (len(line) <= max) units.push(line); else units.push(...splitLong(line, max));
  }
  const chunks = [];
  let cur = '', curLen = 0;
  for (const u of units) {
    const ul = len(u);
    if (!cur) { cur = u; curLen = ul; }
    else if (curLen + 1 + ul <= max) { cur += ' ' + u; curLen += 1 + ul; }
    else { chunks.push(cur); cur = u; curLen = ul; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------------------------------------------------------------------
 * 5. TOKENS (localStorage) + ERROR CLASSIFICATION
 * ------------------------------------------------------------------- */
function parseTokens(raw) {
  const seen = new Set(), valid = [];
  let ignored = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!/^hf_\S{8,}$/.test(t)) { ignored++; continue; }
    if (!seen.has(t)) { seen.add(t); valid.push(t); }
  }
  return { valid, ignored };
}

/** Gradio can throw Error objects, status objects ({stage:"error", message}) or plain strings. */
function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  const parts = [e.message, e.title, e.detail, e.error, e.status, e.code, e.http_status, e.http_status_code]
    .filter((x) => x != null && x !== '');
  if (parts.length) return parts.join(' | ');
  try { return JSON.stringify(e); } catch { return String(e); }
}

/**
 * 'quota'     → this token is out of GPU quota / rate-limited (429)      → rotate
 * 'auth'      → token rejected (401/403/invalid)                          → rotate
 * 'transient' → network hiccup / queue full / 5xx                          → retry
 * 'fatal'     → anything else                                               → stop and show
 */
function classifyError(e) {
  if (e && e.kind === 'cancelled') return 'cancelled';
  if (e && e.kind) return 'fatal';             // our own errors (cdn, api, remote…)
  const m = errText(e);
  if (/\b429\b|quota|rate.?limit|too many requests|exceeded|zerogpu|gpu (limit|usage)|limit reached|sign-?in required|create a free account/i.test(m)) return 'quota';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (user )?token|invalid credentials|token (is )?(invalid|expired)/i.test(m)) return 'auth';
  if (/\b50[234]\b|queue (is )?full|busy|timed? ?out|network|failed to fetch|load failed|abort|connection|could not (connect|get)|starting|sleeping|overloaded/i.test(m)) return 'transient';
  return 'fatal';
}

/* ---------------------------------------------------------------------
 * 6. GRADIO CLIENT (CDN, lazy) + PER-TOKEN SESSIONS
 * ------------------------------------------------------------------- */
let GradioMod = null;
async function loadGradio() {
  if (GradioMod) return GradioMod;
  let last;
  for (const url of GRADIO_CDNS) {
    try { GradioMod = await import(url); return GradioMod; }
    catch (e) { last = e; console.warn('[khmer-tts] CDN failed:', url, e); }
  }
  throw makeError('cdn', 'Could not load the Gradio client from the CDN. Check your internet connection or ad-blocker. ' + errText(last));
}

async function connectSpace(space, token) {
  const G = await loadGradio();
  const opts = token ? { hf_token: token } : {};
  if (G.Client && typeof G.Client.connect === 'function') return G.Client.connect(space, opts);   // current API
  if (typeof G.client === 'function') return G.client(space, opts);                               // older API
  throw makeError('cdn', 'The loaded Gradio client has an unexpected shape (no Client / client export).');
}

/** Decide which API shape the Space offers: '/predict' (as specified) or the older pick_voice+clone pair. */
async function detectMode(app) {
  let named = null;
  try {
    const info = await app.view_api();
    named = Object.keys((info && info.named_endpoints) || {}).map((k) => k.replace(/^\//, ''));
  } catch { return 'predict'; }                   // can't introspect → just try /predict
  const want = CFG.ENDPOINT.replace(/^\//, '');
  if (named.includes(want)) return 'predict';
  if (named.includes('clone') && named.includes('pick_voice')) return 'legacy';
  throw makeError('api', 'This Space does not expose "' + CFG.ENDPOINT + '". Endpoints found: ' + (named.join(', ') || 'none') + '. Check the Space name under Advanced.');
}

/** Extracts the audio URL from a Gradio file output. */
function fileUrl(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  return d.url || null;
}

/** One TTS call for one chunk on one connected session. Returns the audio URL. */
async function callTTS(session, text, voice) {
  let first;
  if (session.mode === 'predict') {
    const r = await session.app.predict(CFG.ENDPOINT, [text, voice]);
    first = r && r.data && r.data[0];
  } else {
    let sample = session.samples.get(voice);
    if (!sample) {
      const p = await session.app.predict(LEGACY.pick, [voice]);
      sample = { fd: p.data[0], text: p.data[1] == null ? '' : String(p.data[1]) };
      session.samples.set(voice, sample);
    }
    const r = await session.app.predict(LEGACY.clone,
      [text, LEGACY.style, sample.fd, sample.text, LEGACY.cfg, LEGACY.steps, LEGACY.seed]);
    first = r && r.data && r.data[0];
  }
  const url = fileUrl(first);
  if (!url) throw makeError('remote', 'The Space finished but returned no audio file.');
  return url;
}

/* ---------------------------------------------------------------------
 * 7. APP STATE
 * ------------------------------------------------------------------- */
const state = {
  tokens: [],            // saved valid tokens
  pool: [null],          // tokens in use for the current run (null = anonymous, no token)
  cur: 0,                // index of the token currently used
  dead: new Set(),       // pool indexes that are exhausted / rejected in this run
  sessions: new Map(),   // pool index → { app, mode, samples }
  space: CFG.DEFAULT_SPACE,
  plan: null,            // { chunks, next, voice } – allows Resume after an error / cancel
  busy: false,
  cancelled: false,
  cancelReject: null,
  objectUrls: [],
  timer: null
};

const tokenLabel = (i) => (state.pool[i] ? 'Token #' + (i + 1) : 'no token (anonymous)');

async function getSession(idx) {
  let s = state.sessions.get(idx);
  if (s) return s;
  const app = await connectSpace(state.space, state.pool[idx]);
  s = { app, mode: await detectMode(app), samples: new Map() };
  state.sessions.set(idx, s);
  return s;
}

function nextAliveToken() {
  const n = state.pool.length;
  for (let k = 0; k < n; k++) {
    const i = (state.cur + k) % n;
    if (!state.dead.has(i)) { state.cur = i; return i; }
  }
  return -1;
}

/** Races a promise against the Cancel button (Gradio's predict() itself can't be aborted). */
function cancellable(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { state.cancelReject = () => reject(makeError('cancelled', 'Cancelled.')); })
  ]);
}

/**
 * Synthesises ONE chunk. If the current token hits quota/429 (or is rejected) it is marked
 * exhausted, the next token is selected and the SAME chunk is retried automatically.
 * Throws when every token is exhausted.
 */
async function synthesizeWithRotation(chunk, voice, onToken) {
  let transient = 0;
  for (;;) {
    if (state.cancelled) throw makeError('cancelled', 'Cancelled.');
    const idx = nextAliveToken();
    if (idx === -1) throw makeError('exhausted', '');
    onToken(idx);
    try {
      const session = await cancellable(getSession(idx));
      const url = await cancellable(callTTS(session, chunk, voice));
      return { url, idx };
    } catch (e) {
      const kind = classifyError(e);
      if (kind === 'cancelled') throw e;
      state.sessions.delete(idx);                  // reconnect fresh next time
      if (kind === 'quota' || kind === 'auth') {
        state.dead.add(idx);
        const alive = state.pool.length - state.dead.size;
        console.warn('[khmer-tts] ' + tokenLabel(idx) + ' → ' + kind + ':', errText(e));
        setNote(alive > 0
          ? tokenLabel(idx) + (kind === 'quota' ? ' hit its quota' : ' was rejected') + ' → switching to the next token…'
          : '');
        continue;                                  // retry same chunk with the next token
      }
      if (kind === 'transient' && transient < CFG.TRANSIENT_RETRIES) {
        transient++;
        setNote('Temporary problem (' + errText(e).slice(0, 80) + '). Retrying…');
        await sleep(1500 * transient);
        continue;
      }
      throw e;
    }
  }
}

/* ---------------------------------------------------------------------
 * 8. UI HELPERS
 * ------------------------------------------------------------------- */
function setPill(stateName, text) { $('spacePill').dataset.state = stateName; $('spaceTxt').textContent = text; }

function showError(msg, link) {
  const el = $('err');
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (link) {
    const a = document.createElement('a');
    a.href = 'https://huggingface.co/spaces/' + state.space;
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' Open the Space ↗';
    el.appendChild(a);
  }
  el.hidden = false;
}
function clearError() { const el = $('err'); el.hidden = true; el.textContent = ''; }
function setNote(t) { $('progNote').textContent = t || ''; }

function setProgress(done, total, partial = 0) {
  const pct = total ? Math.min(100, ((done + partial) / total) * 100) : 0;
  $('bar').style.setProperty('--w', pct + '%');
}

function updateGenButton() {
  const p = state.plan;
  $('genTxt').textContent = state.busy ? 'Generating…'
    : (p && p.next > 0 && p.next < p.chunks.length) ? 'Resume from chunk ' + (p.next + 1) + ' of ' + p.chunks.length
    : 'Generate audio';
}

function setBusy(b) {
  state.busy = b;
  $('genBtn').disabled = b;
  $('genBtn').classList.toggle('busy', b);
  $('cancelBtn').hidden = !b;
  $('prog').hidden = !b && !state.plan;
  ['text', 'voice', 'srtFile', 'tokens', 'tokSave', 'tokClear', 'spaceId', 'pasteBtn', 'clearBtn']
    .forEach((id) => { $(id).disabled = b; });
  if (!b && state.timer) { clearInterval(state.timer); state.timer = null; }
  updateGenButton();
}

/* ---- tokens UI ---- */
function renderTokenStatus(extra) {
  const n = state.tokens.length;
  $('tokCount').textContent = n + ' saved';
  const note = $('tokNote');
  note.className = 'note' + (n ? ' ok' : '');
  note.textContent = (n
    ? n + ' token' + (n > 1 ? 's' : '') + ' ready. If one runs out of quota the app switches to the next automatically.'
    : 'No token: the free anonymous GPU quota is small. Add tokens for more.') + (extra ? ' ' + extra : '');
}

function saveTokens(silent) {
  const { valid, ignored } = parseTokens($('tokens').value);
  state.tokens = valid;
  if (valid.length) store.set('tokens', valid.join('\n')); else store.del('tokens');
  $('tokens').value = valid.join('\n');
  state.sessions.clear();                          // new token list → new sessions
  renderTokenStatus(ignored ? '(' + ignored + ' invalid line' + (ignored > 1 ? 's' : '') + ' ignored: tokens start with "hf_")' : '');
  if (ignored) $('tokNote').className = 'note warn';
  if (!silent && !valid.length && !ignored) renderTokenStatus();
}

$('tokSave').onclick = () => saveTokens(false);
$('tokClear').onclick = () => { $('tokens').value = ''; saveTokens(false); };
$('tokToggle').onclick = () => {
  const el = $('tokens'), masked = el.classList.toggle('masked');
  $('tokToggle').textContent = masked ? '👁 Show' : '🙈 Hide';
};

/* ---- text editor / SRT ---- */
const ta = $('text');
let countTimer = null;
function updateCount() {
  const n = len(ta.value);
  const chunks = chunkText(ta.value).length;
  $('count').textContent = n.toLocaleString() + ' characters · ' + chunks + ' chunk' + (chunks === 1 ? '' : 's') + ' (max ' + CFG.MAX_CHUNK + ' each)';
  const khmer = /[\u1780-\u17FF]/.test(ta.value);
  $('hint').textContent = (n && !khmer) ? 'No Khmer letters detected: this is a Khmer voice model.' : '';
}
function onTextChanged() {
  if (!state.busy) { state.plan = null; updateGenButton(); }   // a new text invalidates a paused run
  clearTimeout(countTimer); countTimer = setTimeout(updateCount, 120);
}
ta.addEventListener('input', onTextChanged);
$('clearBtn').onclick = () => { ta.value = ''; $('srtInfo').textContent = 'Upload a .srt file: only the subtitle text is kept (numbers and timestamps are removed).'; $('srtFile').value = ''; onTextChanged(); updateCount(); clearError(); ta.focus(); };
$('pasteBtn').onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) { showError('The clipboard is empty.'); return; }
    ta.value = t; onTextChanged(); updateCount(); clearError();
  } catch { showError('Your browser did not allow reading the clipboard. Long-press the text box (or press Ctrl+V) and choose Paste.'); ta.focus(); }
};

/** SRT upload: FileReader → parseSrt → text box (so you can review/edit before generating). */
$('srtFile').addEventListener('change', function () {
  const file = this.files && this.files[0];
  if (!file) return;
  clearError();
  if (!/\.srt$/i.test(file.name)) { showError('Please choose a .srt subtitle file.'); this.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { showError('That file is larger than 10 MB. Please use a smaller .srt file.'); this.value = ''; return; }
  const reader = new FileReader();
  reader.onerror = () => showError('Could not read the file. Please try again.');
  reader.onload = () => {
    const cues = parseSrt(reader.result);
    if (!cues.length) { showError('No subtitle text was found in this file. Is it a valid .srt?'); return; }
    ta.value = cues.join('\n');
    onTextChanged(); updateCount();
    const chunks = chunkText(ta.value).length;
    $('srtInfo').textContent = file.name + ' · ' + cues.length + ' subtitles → ' + chunks + ' chunk' + (chunks === 1 ? '' : 's');
  };
  reader.readAsText(file, 'utf-8');
});

/* ---- results ---- */
function extFromBlob(blob, url) {
  const t = (blob && blob.type || '').toLowerCase();
  const map = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac' };
  if (map[t]) return map[t];
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url || '');
  return m && /^(wav|mp3|ogg|flac|webm|aac|m4a)$/i.test(m[1]) ? m[1].toLowerCase() : 'wav';
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice';
const pad = (n, w) => String(n).padStart(w, '0');

/** Adds a finished chunk to the Results list (instantly playable; download link is upgraded to a Blob). */
function addResult({ number, total, url, chars, tokenIdx, voice }) {
  $('emptyMsg').hidden = true;
  $('clearResults').hidden = false;

  const part = document.createElement('div');
  part.className = 'part';

  const head = document.createElement('div');
  head.className = 'part-h';
  const title = document.createElement('strong');
  title.textContent = 'Part ' + number + ' / ' + total;
  const meta = document.createElement('span');
  meta.className = 'meta2';
  meta.textContent = chars.toLocaleString() + ' chars · ' + voice + ' · ' + tokenLabel(tokenIdx);
  const dl = document.createElement('a');
  dl.className = 'dl';
  dl.textContent = '⬇ Download';
  dl.href = url; dl.target = '_blank'; dl.rel = 'noopener';
  head.append(title, meta, dl);

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = url;

  part.append(head, audio);
  $('parts').appendChild(part);
  part.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Try to turn the remote file into a Blob so the "download" attribute works cross-origin.
  fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then((blob) => {
    if (blob.size < 1024) return;                  // empty / invalid → keep the plain link
    const typed = /^audio\//i.test(blob.type) ? blob : blob.slice(0, blob.size, 'audio/wav');
    const obj = URL.createObjectURL(typed);
    state.objectUrls.push(obj);
    dl.href = obj;
    dl.removeAttribute('target');
    dl.download = 'khmer-tts-part-' + pad(number, 3) + '-' + slug(voice) + '.' + extFromBlob(typed, url);
  }).catch(() => { /* CORS etc.: the plain link still works */ });
}

function clearResults() {
  state.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  state.objectUrls = [];
  $('parts').querySelectorAll('.part').forEach((p) => p.remove());
  $('emptyMsg').hidden = false;
  $('clearResults').hidden = true;
}
$('clearResults').onclick = clearResults;

// Only one part plays at a time.
$('parts').addEventListener('play', (e) => {
  $('parts').querySelectorAll('audio').forEach((a) => { if (a !== e.target) a.pause(); });
}, true);

/* ---------------------------------------------------------------------
 * 9. THE QUEUE
 * ------------------------------------------------------------------- */
async function start() {
  if (state.busy) return;
  clearError();
  setNote('');

  saveTokens(true);                                // pick up unsaved edits silently
  state.pool = state.tokens.length ? state.tokens.slice() : [null];
  state.dead.clear();                              // quotas may have refilled since last time
  state.cur = Math.min(state.cur, state.pool.length - 1);

  // New run (not a resume): build the chunk plan from the text box.
  if (!state.plan) {
    const chunks = chunkText(ta.value);
    if (!chunks.length) { showError('Please type some Khmer text or upload an SRT file first.'); ta.focus(); return; }
    clearResults();
    state.cur = 0;
    state.plan = { chunks, next: 0, voice: $('voice').value };
  }
  const plan = state.plan;
  const total = plan.chunks.length;

  state.cancelled = false;
  setBusy(true);
  $('prog').hidden = false;
  setProgress(plan.next, total);

  let tokenIdx = state.cur;
  let t0 = Date.now();
  const label = () => 'Processing chunk ' + (plan.next + 1) + ' of ' + total + ' using ' + tokenLabel(tokenIdx);
  const render = () => { $('progTxt').textContent = label() + '  ·  ' + Math.round((Date.now() - t0) / 1000) + 's'; };
  state.timer = setInterval(render, 500);

  try {
    for (; plan.next < total; plan.next++) {
      if (state.cancelled) throw makeError('cancelled', 'Cancelled.');
      const chunk = plan.chunks[plan.next];
      t0 = Date.now();
      setProgress(plan.next, total, 0.5);
      setPill('checking', 'Chunk ' + (plan.next + 1) + '/' + total);
      render();

      const { url, idx } = await synthesizeWithRotation(chunk, plan.voice, (i) => { tokenIdx = i; render(); });
      tokenIdx = idx;
      addResult({ number: plan.next + 1, total, url, chars: len(chunk), tokenIdx: idx, voice: plan.voice });
      setProgress(plan.next + 1, total);
      setNote('');
    }
    // Finished
    state.plan = null;
    setPill('ok', 'Done · ' + total + ' part' + (total === 1 ? '' : 's'));
    $('progTxt').textContent = 'Done: ' + total + ' audio part' + (total === 1 ? '' : 's') + ' ready below.';
  } catch (e) {
    handleRunError(e, plan, total);
  } finally {
    setBusy(false);
    if (!state.plan) $('prog').hidden = false;     // keep the "Done" line visible
  }
}

function handleRunError(e, plan, total) {
  const done = plan.next;
  const resumeHint = done === 0 ? ' Press “Generate audio” to try again.'
    : ' Your ' + done + ' finished part' + (done === 1 ? ' is' : 's are') + ' kept below; press “Resume” to continue.';
  $('progTxt').textContent = 'Stopped at chunk ' + (done + 1) + ' of ' + total + '.';
  console.warn('[khmer-tts]', e);

  if (e && e.kind === 'cancelled') {
    setPill('idle', 'Cancelled');
    $('progTxt').textContent = 'Cancelled at chunk ' + (done + 1) + ' of ' + total + '.';
    setNote('');
    return;
  }
  if (e && e.kind === 'exhausted') {
    const n = state.tokens.length;
    setPill('bad', 'All tokens exhausted');
    showError(n
      ? 'All ' + n + ' token' + (n > 1 ? 's have' : ' has') + ' reached the GPU quota (or were rejected). Add more tokens above, or wait for the quota to refill (ZeroGPU quotas reset daily).' + resumeHint
      : 'The free anonymous GPU quota is used up and no token is saved. Add one or more Hugging Face tokens above.' + resumeHint, true);
    return;
  }
  setPill('bad', 'Error');
  const m = errText(e);
  const msg = e && e.kind === 'cdn' ? e.message
    : e && e.kind === 'api' ? e.message
    : /not found|404/i.test(m) ? 'The Space “' + state.space + '” could not be found. Check the name under Voice → Advanced.'
    : 'Generation failed: ' + m;
  showError(msg + (e && e.kind === 'cdn' ? '' : resumeHint), !(e && e.kind === 'cdn'));
}

$('genBtn').onclick = start;
$('cancelBtn').onclick = () => {
  state.cancelled = true;
  if (state.cancelReject) state.cancelReject();
};

/* ---------------------------------------------------------------------
 * 10. SETTINGS (voice, space) + EMBED HOOKS FOR THE DUBBER SITE
 * ------------------------------------------------------------------- */
function applySpaceLink() { $('spaceLink').href = 'https://huggingface.co/spaces/' + state.space; }

$('voice').addEventListener('change', () => { store.set('voice', $('voice').value); if (!state.busy) { state.plan = null; updateGenButton(); } });
$('spaceId').addEventListener('change', () => {
  const v = $('spaceId').value.trim().replace(/^https?:\/\/huggingface\.co\/spaces\//i, '').replace(/\/+$/, '');
  state.space = /^[\w.-]+\/[\w.-]+$/.test(v) ? v : CFG.DEFAULT_SPACE;
  $('spaceId').value = state.space;
  store.set('space', state.space);
  state.sessions.clear(); state.plan = null; updateGenButton(); applySpaceLink();
});

/* The main Dubber page talks to this module through the three messages below (unchanged). */
const embedded = window.parent !== window;
$('back').addEventListener('click', (e) => {
  if (embedded) {
    e.preventDefault();
    try { window.parent.postMessage({ type: 'khmer-tts-back' }, location.origin); } catch { location.href = '../'; }
  }
});
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'khmer-tts-pause') $('parts').querySelectorAll('audio').forEach((a) => a.pause());
});
if (embedded && window.ResizeObserver) {
  let last = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - last) < 2) return;
    last = h;
    try { window.parent.postMessage({ type: 'khmer-tts-height', height: h }, location.origin); } catch { /* ignore */ }
  }).observe(document.body);
}

/* ---------------------------------------------------------------------
 * 11. INIT
 * ------------------------------------------------------------------- */
(function init() {
  // voices
  CFG.VOICES.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; $('voice').appendChild(o); });
  const sv = store.get('voice');
  $('voice').value = CFG.VOICES.includes(sv) ? sv : CFG.DEFAULT_VOICE;

  // space
  const ss = store.get('space');
  // ignore a saved name that is known not to exist (VoxPocket/Khmer-TTS returns 404)
  if (ss && ss !== 'VoxPocket/Khmer-TTS' && /^[\w.-]+\/[\w.-]+$/.test(ss)) state.space = ss;
  $('spaceId').value = state.space;
  applySpaceLink();

  // tokens
  $('tokens').value = store.get('tokens') || '';
  state.tokens = parseTokens($('tokens').value).valid;
  renderTokenStatus();

  updateCount();
  updateGenButton();
})();
