import { parseCard } from './core.mjs';
import { mount, readCardFile } from './panel.mjs';
const $ = (id) => document.getElementById(id),
  asset = (n) => new URL(n, import.meta.url);
const picker = $('shader');
const catalog = await (await fetch(asset('./models.json'))).json();
const first = 'lfm-1.2b';
const models = [
  catalog.find((m) => m.web && m.id === first),
  ...catalog
    .filter((m) => m.web && m.id !== first)
    .map((m) => ({ ...m, label: `${m.name} · experimental` })),
];
let c = parseCard(await (await fetch(asset('./blacksmith.json'))).text()),
  runtime,
  handler,
  appliedShader,
  seq = 0;
const waiting = new Map();
window.GrailNPC = Object.freeze({
  attach(fn, modes, current) {
    handler = fn;
    $('forge').disabled = false;
    if (!picker) return false;
    if (!modes) {
      picker.replaceChildren(new Option('Unavailable in this build'));
      return false;
    }
    picker.replaceChildren(...Object.entries(JSON.parse(modes)).map(([id, title]) => new Option(title, id)));
    picker.value = appliedShader = current;
    picker.disabled = false;
    return true;
  },
  publish(raw) {
    const s = JSON.parse(raw);
    waiting.get(s.rid)?.(s);
  },
});
function op(x) {
  return new Promise((resolve, reject) => {
    if (!handler) {
      reject(Error('Game not attached'));
      return;
    }
    const rid = ++seq,
      t = setTimeout(() => {
        waiting.delete(rid);
        reject(Error('Game did not acknowledge'));
      }, 2000);
    waiting.set(rid, (s) => {
      clearTimeout(t);
      waiting.delete(rid);
      resolve(s);
    });
    try {
      handler(JSON.stringify({ ...x, rid }));
    } catch (e) {
      clearTimeout(t);
      waiting.delete(rid);
      reject(e);
    }
  });
}
const chat = mount({
  models,
  card: () => c,
  setProfile: (speech) => { c = { ...c, speech }; },
  op,
  load: async (m, status) => {
    runtime ??= await import('./browser.mjs');
    await runtime.load(m, status);
  },
  ask: (m, r) => runtime.ask(m, r),
});
async function grant(next) {
  const s = await op({ op: 'card', role: next.role, tools: next.tools });
  if (!s.ok) throw Error('Game refused this card');
}
async function view(name) {
  chat.invalidate();
  if (name === 'forge') await grant(c);
  const s = await op({ op: 'view', name });
  if (!s.ok) throw Error('View refused');
  const forge = s.view === 'forge';
  $('drawer').hidden = !forge;
  $('board').setAttribute('aria-pressed', String(!forge));
  $('forge').setAttribute('aria-pressed', String(forge));
  $('who').textContent = c.name;
  $('witness').textContent = s.beacon ? 'The camp beacon is lit.' : 'The camp beacon is dark.';
  chat.item(s);
}
function showError(e) {
  $('note').textContent = e.message;
}
picker?.addEventListener('change', async ({ target }) => {
  target.disabled = true;
  $('shader-error').textContent = '';
  try {
    const state = await op({ op: 'shader', name: target.value });
    if (!state.ok) throw Error('Game refused this shader');
    appliedShader = state.shader;
  } catch (err) {
    $('shader-error').textContent = err.message;
  } finally {
    target.value = appliedShader;
    target.disabled = false;
  }
});
$('board').onclick = () => {
  if (handler) view('board').catch(showError);
};
$('forge').onclick = () => view('forge').catch(showError);
$('import').onchange = async (e) => {
  try {
    const next = parseCard(await readCardFile(e.target.files[0]));
    if (next.role !== 'blacksmith') throw Error('This scene requires a blacksmith card');
    await grant(next);
    c = next;
    chat.reset();
    $('who').textContent = c.name;
    $('note').textContent = `Using ${c.name}`;
  } catch (err) {
    showError(err);
  }
};
const game = $('game');
// Attach the bridge before navigating the iframe. The static build supplies a versioned URL.
game.src = game.dataset.src || './game/index.html';
