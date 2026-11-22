import { canMend, request, decide } from './core.mjs';
import { mountSpeech } from './speech.mjs';
export function mount({ card, setProfile, models, load, ask, op, inspect = () => {} }) {
  const $ = (id) => document.getElementById(id),
    box = $('chat');
  box.innerHTML = `<label>Model <select id="model"></select></label> <button id="load">Load model</button>
    <p id="status" role="status">No model loaded.</p><button id="place">Place buckle on anvil</button> <output id="item"></output>
    <pre id="log" aria-live="polite"></pre><form id="message"><label>Say something <input id="words" maxlength="320" autocomplete="off"></label> <button id="send">Send</button></form><div id="voiceDesk"></div>`;
  const voice = mountSpeech($('voiceDesk'), card, setProfile);
  for (const m of models)
    $('model').add(new Option(`${m.label || m.name} · ${Math.round(m.bytes / 1e6)} MB`, m.id));
  let ready = '',
    busy = false,
    epoch = 0,
    serial = 0,
    history = [],
    buckle = 'pocket';
  const selected = () => models.find((m) => m.id === $('model').value),
    status = (t) => {
      $('status').textContent = t;
    };
  function refresh() {
    $('model').disabled = $('load').disabled = busy;
    $('send').disabled = busy || ready !== selected().id;
    $('place').disabled = busy || buckle !== 'pocket';
  }
  function item(s) {
    buckle = s.buckle;
    $('item').textContent = `Buckle: ${buckle}`;
    refresh();
  }
  function reset() {
    ++epoch;
    voice.sync();
    history = [];
    $('log').textContent = '';
    inspect({});
  }
  const log = (name, line) => {
    $('log').textContent += `${name}: ${line}\n`;
  };
  $('model').onchange = () => {
    reset();
    ready = '';
    status('Selected; not yet loaded.');
    refresh();
  };
  $('load').onclick = async () => {
    if (busy) return;
    busy = true;
    ready = '';
    refresh();
    const m = selected();
    try {
      await load(m, status);
      ready = m.id;
      status(`Ready: ${m.name}`);
    } catch (e) {
      status(`Not ready: ${e.message}. Retry Load model.`);
    } finally {
      busy = false;
      refresh();
    }
  };
  $('place').onclick = async () => {
    try {
      item(await op({ op: 'place' }));
    } catch (e) {
      status(e.message);
    }
  };
  $('message').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('words').value.trim();
    if (busy || !text || ready !== selected().id) return;
    voice.silence();
    busy = true;
    refresh();
    status('Thinking…');
    const id = ++serial,
      here = epoch,
      t = performance.now(),
      c = card();
    $('words').value = '';
    log('You', text);
    try {
      const s = await op({ op: 'begin', id, allowed: canMend(c) });
      if (!s.ok || here !== epoch) throw Error('Turn no longer active');
      const r = request(c, s, history, text);
      inspect({ request: r, model: ready });
      const reply = await ask(selected(), r);
      if (here !== epoch) return;
      const d = decide(reply.choices[0]),
        decisionMs = Math.round(performance.now() - t);
      const a = await op({
        op: 'finish',
        id,
        kind: d.kind,
        target: d.kind === 'mend' ? 'bent_buckle' : '',
      });
      if (here !== epoch) return;
      if (!a.ok) throw Error('Game refused the action');
      const acceptedMs = d.kind === 'mend' ? Math.round(performance.now() - t) : null;
      item(a);
      if (d.kind === 'mend') {
        // The next turn sees the mended buckle in game state, not as invented dialogue.
        log('Game', 'Buckle mended.');
      } else {
        log(c.name, d.line);
        voice.dialogue(d.line);
        history = [
          ...history,
          { role: 'user', content: text },
          { role: 'assistant', content: d.line },
        ].slice(-4);
      }
      const ms = Math.round(performance.now() - t);
      status(`Reply: ${ms} ms · ${d.kind === 'mend' ? 'repair accepted' : 'no action'}`);
      $('status').dataset.replyMs = String(ms);
      $('status').dataset.actionMs = acceptedMs === null ? '' : String(acceptedMs);
      inspect({
        request: r,
        model: ready,
        decision: d,
        receipt: a,
        decisionMs,
        acceptedMs,
        replyDomMs: ms,
      });
    } catch (err) {
      if (here === epoch) status(`No action: ${err.message}`);
    } finally {
      try {
        await op({ op: 'cancel', id });
      } catch {}
      busy = false;
      refresh();
    }
  };
  refresh();
  return {
    reset,
    item,
    invalidate() {
      ++epoch;
      voice.cancel();
      if (busy && ready) status('Turn cancelled by navigation.');
    },
  };
}
export async function readCardFile(file) {
  if (!file || file.size > 8192) throw Error('Select a card of at most 8 KiB');
  return file.text();
}
