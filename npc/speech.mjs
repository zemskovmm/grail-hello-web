import { speakers, styles } from './core.mjs';

// Render the treatment into the clip itself: the audition, player and saved WAV all match.
async function renderWav(samples, rate, style) {
  if (!(samples instanceof Float32Array) || rate !== 24000 || !samples.length || samples.length > rate * 120)
    throw Error('Invalid speech audio');
  let pcm = samples;
  if (style.cents || style.treble) {
    const pitch = 2 ** (style.cents / 1200);
    const mix = new OfflineAudioContext(1, Math.ceil(pcm.length / pitch), rate);
    const clip = mix.createBufferSource();
    clip.buffer = mix.createBuffer(1, pcm.length, rate);
    clip.buffer.copyToChannel(pcm, 0); clip.playbackRate.value = pitch;
    const tone = mix.createBiquadFilter();
    tone.type = 'highshelf'; tone.frequency.value = 2300; tone.gain.value = style.treble;
    clip.connect(tone).connect(mix.destination); clip.start();
    pcm = (await mix.startRendering()).getChannelData(0);
  }
  const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
  const tag = (pos, s) => [...s].forEach((ch, i) => v.setUint8(pos + i, ch.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, b.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), true);
  return new Blob([b], { type: 'audio/wav' });
}

export function mountSpeech(box, card, setProfile) {
  box.innerHTML = `<fieldset class="voice-desk"><legend>Character voice <small>English · on this device</small></legend>
    <div class="voice-controls"><label>Voice model<select id="voiceModel"></select></label>
    <label>Speaker<select id="voiceSpeaker"></select></label><label>Treatment<select id="voiceStyle"></select></label></div>
    <p class="voice-hint" id="voiceDetail"></p><p class="voice-example" id="voiceExample"></p>
    <small>First use also loads the speech runtime (14.1 MB uncompressed) and an English dictionary (0.26 MB). <a id="voiceNotices" target="_blank" rel="noopener">Licenses</a></small>
    <div class="voice-actions"><button type="button" id="voiceEnable" disabled>Enable voice</button>
    <button type="button" id="voiceAudition" disabled>Audition line</button><button type="button" id="voiceOff" hidden>Turn voice off</button></div>
    <p class="voice-status" id="voiceStatus" role="status">Text only. Enable voice to hear auditions and character replies.</p>
    <div id="voiceResult" hidden><p id="voiceCaption"></p><audio id="voicePlayer" controls preload="auto"></audio> <a id="voiceDownload">Save WAV</a></div>
    </fieldset>`;
  const $ = (id) => box.querySelector('#voice' + id), player = $('Player');
  $('Notices').href = new URL('./vendor/speech/NOTICES.txt', import.meta.url).href;
  for (const s of speakers) $('Speaker').add(new Option(s[0].toUpperCase() + s.slice(1), s));
  for (const [k, s] of Object.entries(styles)) $('Style').add(new Option(s.label, k));
  let catalog = [], worker = null, model = '', ready = false, epoch = 0;
  let active = null, queued = null, url = '';
  const status = (s) => { $('Status').textContent = s; };
  const example = () => card().examples[0] || 'There you are.';
  function controls() {
    for (const id of ['Model', 'Speaker', 'Style']) $(id).disabled = !catalog.length;
    $('Enable').disabled = !catalog.length || !!worker;
    $('Enable').hidden = !!worker; $('Off').hidden = !worker; $('Audition').disabled = !ready;
  }
  function silence() {
    ++epoch; queued = null;
    if (url) {
      player.pause(); player.removeAttribute('src'); player.load();
      URL.revokeObjectURL(url); url = ''; $('Download').removeAttribute('href');
    }
    $('Result').hidden = true; $('Caption').textContent = '';
    if (ready) status('Voice ready. Audition the line or talk to the character.');
  }
  function off() {
    silence(); worker?.terminate(); worker = null; ready = false; active = null; model = '';
    status('Text only. The next voice load can reuse verified files.'); controls();
  }
  function sync() {
    const s = card().speech;
    if (worker && s.model !== model) off(); else silence();
    $('Model').value = s.model; $('Speaker').value = s.speaker; $('Style').value = s.style;
    $('Detail').textContent = styles[s.style].detail;
    $('Example').textContent = `Audition line: “${example()}”`; controls();
  }
  function fail(e) {
    off(); status(`Voice unavailable: ${e.message || e}. You can still read replies or retry Enable voice.`);
  }
  function pump() {
    if (!ready || active || !queued) return;
    active = queued; queued = null;
    const { text, speaker, style } = active;
    worker.postMessage({ type: 'speak', text, speaker, speed: style.speed });
  }
  function speak(text, kind) {
    if (!ready || document.hidden) return;
    silence();
    const c = card(), s = c.speech;
    queued = { text, kind, speaker: s.speaker, style: styles[s.style], token: epoch, name: c.name, id: c.id, start: performance.now() };
    status('Preparing speech…'); pump();
  }
  async function finish(samples, sampleRate) {
    const job = active;
    if (!job) return;
    try {
      if (job.token !== epoch) return;
      const wav = await renderWav(samples, sampleRate, job.style);
      if (job.token !== epoch) return;
      url = URL.createObjectURL(wav); player.src = url;
      $('Download').href = url; $('Download').download = `${job.id}-${job.speaker}.wav`;
      $('Caption').textContent = `${job.kind} · ${job.name}: ${job.text}`; $('Result').hidden = false;
      const ms = Math.round(performance.now() - job.start);
      status(`Clip ready · ${ms} ms to render.`);
      try { await player.play(); }
      catch { if (job.token === epoch) status('Clip ready. Press Play to hear it.'); }
    } catch (e) { if (job.token === epoch) fail(e); }
    finally { if (active === job) { active = null; pump(); } }
  }
  $('Enable').onclick = () => {
    if (worker || !catalog.length) return;
    try {
      const w = new Worker(new URL('./speech-worker.mjs', import.meta.url), { type: 'module' });
      worker = w; model = card().speech.model; controls(); status('Preparing the local voice…');
      w.onmessage = ({ data }) => {
        if (w !== worker) return;
        if (data.type === 'status' && !ready) status(data.text);
        if (data.type === 'error') {
          if (ready && active && active.token !== epoch) { active = null; pump(); }
          else fail(Error(data.message));
        }
        if (data.type === 'ready') { ready = true; status('Voice ready. Audition the line or talk to the character.'); controls(); }
        if (data.type === 'audio') void finish(data.samples, data.sampleRate);
      };
      w.onerror = (e) => { if (w === worker) fail(Error(e.message || 'Voice worker failed to start')); };
      w.postMessage({ type: 'load', model });
    } catch (e) { fail(e); }
  };
  for (const id of ['Model', 'Speaker', 'Style']) $(id).onchange = () => {
    try {
      setProfile({ model: $('Model').value, speaker: $('Speaker').value, style: $('Style').value });
      sync();
    } catch (e) { sync(); status(e.message); }
  };
  $('Audition').onclick = () => speak(example(), 'Audition');
  $('Off').onclick = off;
  const cancel = () => { if (worker && !ready) off(); else silence(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('pagehide', off);
  sync();
  fetch(new URL('./speech-models.json', import.meta.url)).then(async (r) => {
    if (!r.ok) throw Error('Voice catalog could not be loaded');
    catalog = await r.json();
    for (const m of catalog) $('Model').add(new Option(`${m.label} · ${(m.bytes / 1e6).toFixed(1)} MB`, m.id));
    sync();
  }).catch(() => { catalog = []; off(); status('Voice catalog unavailable. Reload to retry, or keep playing with text.'); });
  return { sync, cancel, silence, dialogue: (line) => speak(line, 'Dialogue') };
}
