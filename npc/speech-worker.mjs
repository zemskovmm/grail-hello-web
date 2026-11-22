const dictionaryBase = 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/59eb19938f12e30881c81d86ce4a7de25414c9f4/dictsource/';
const dictionary = [
  { name: 'en_rules', bytes: 161691, sha256: '8e75e9341ea735cc514b29a7d3a95c6c241c1cc176ad43e5699b8f7f66ab3194' },
  { name: 'en_list', bytes: 102788, sha256: '24eb79018ed6253c10682096de672ce9265c1fe15c3e19e7f754d57a0fcd9790' },
];
const status = (text) => postMessage({ type: 'status', text });
let engine, modelId, voices;
let busy = false;

async function matches(data, pin) {
  if (data.byteLength !== pin.bytes) return false;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('') === pin.sha256;
}

// Only callers handling an explicit load may acquire assets. Locks and digest-based
// keys share verified entries across fixtures/tabs; partial or bad data is never published.
async function asset(dir, base, pin) {
  return navigator.locks.request(`grail-npc-speech:${pin.sha256}`, async () => {
    let handle;
    try {
      handle = await dir.getFileHandle(pin.sha256);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    if (handle) {
      const file = await handle.getFile();
      status(`Verifying cached ${pin.name}…`);
      if (file.size === pin.bytes) {
        const data = new Uint8Array(await file.arrayBuffer());
        if (await matches(data, pin)) {
          status(`Using verified cache: ${pin.name}`);
          return data;
        }
      }
    }

    status(`Downloading ${pin.name}: 0%`);
    const response = await fetch(base + pin.name, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body) throw Error(`${pin.name} download HTTP ${response.status}`);
    const data = new Uint8Array(pin.bytes);
    let read = 0, shown = 0;
    for await (const chunk of response.body) {
      if (read + chunk.length > pin.bytes) throw Error(`${pin.name} length mismatch`);
      data.set(chunk, read);
      read += chunk.length;
      const percent = Math.floor(read * 100 / pin.bytes);
      if (percent !== shown) {
        shown = percent;
        status(`Downloading ${pin.name}: ${percent}% (${read}/${pin.bytes} bytes)`);
      }
    }
    if (read !== pin.bytes || !(await matches(data, pin))) throw Error(`${pin.name} digest/size mismatch`);
    handle ??= await dir.getFileHandle(pin.sha256, { create: true });
    const out = await handle.createWritable();
    try {
      await out.write(data);
      await out.close();
    } catch (error) {
      try { await out.abort(); } catch {}
      throw error;
    }
    return data;
  });
}

async function load(model) {
  if (!['nano-int8', 'micro'].includes(model)) throw Error('Unsupported speech model');
  if (engine) {
    if (model !== modelId) throw Error('Model changes require a new speech worker');
    return;
  }
  if (!navigator.storage?.getDirectory || !navigator.locks || !globalThis.crypto?.subtle) {
    throw Error('Persistent speech cache requires a secure browser origin with OPFS and Web Locks');
  }
  status('Checking speech assets…');
  const response = await fetch(new URL('./speech-models.json', import.meta.url));
  if (!response.ok) throw Error(`Speech catalog HTTP ${response.status}`);
  const entry = (await response.json()).find(({ id }) => id === model);
  if (!entry) throw Error('Speech model missing from catalog');
  const { repo, revision, files } = entry;
  if (!/^KittenML\/kitten-tts-[a-z0-9.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(revision)
      || files?.length !== 2 || !/^kitten_tts_[a-z_0-9]+\.onnx$/.test(files[0]?.name) || files[1]?.name !== 'voices.npz'
      || files.some((file) => !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes <= 0)
      || files[0].bytes + files[1].bytes !== entry.bytes || entry.bytes > 50_000_000) {
    throw Error('Invalid speech catalog pins');
  }
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('grail-npc-speech-v1', { create: true });
  const base = `https://huggingface.co/${repo}/resolve/${revision}/`;
  const onnxData = await asset(dir, base, files[0]);
  const voicesData = await asset(dir, base, files[1]);
  const rulesData = await asset(dir, dictionaryBase, dictionary[0]);
  const listData = await asset(dir, dictionaryBase, dictionary[1]);

  status('Initializing local speech…');
  const { KittenTTS, CEPhonemizer, ALL_VOICE_IDS, MemoryAssetStorage } = await import('./vendor/speech/kittentts-web.mjs');
  const decode = new TextDecoder('utf-8', { fatal: true });
  engine = await KittenTTS.create({
    model,
    modelFiles: { onnxData, voicesData },
    phonemizer: new CEPhonemizer({ rulesText: decode.decode(rulesData), listText: decode.decode(listData) }),
    storage: new MemoryAssetStorage(),
    // Deny SDK download/repair fallbacks, even if an explicitly supplied asset is rejected.
    fetch: async () => { throw Error('Unexpected KittenTTS download'); },
    analytics: false,
    ortNumThreads: 1,
    ortWasmPath: { wasm: new URL('./vendor/speech/ort-wasm-simd-threaded.wasm', import.meta.url).href },
  });
  voices = new Set(ALL_VOICE_IDS);
  modelId = model;
}

async function speak({ text, speaker, speed }) {
  if (!engine) throw Error('Speech is not loaded');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw Error('Speech needs 1–4000 characters');
  if (!voices.has(speaker)) throw Error('Unsupported speech voice');
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw Error('Speech speed must be between 0.5 and 2');
  const { samples, sampleRate } = await engine.generate(text, { voice: speaker, speed });
  if (!(samples instanceof Float32Array) || !samples.length || sampleRate !== 24000
      || !samples.every(Number.isFinite) || !samples.some((sample) => sample !== 0)) {
    throw Error('Speech model returned no usable PCM');
  }
  postMessage({ type: 'audio', samples, sampleRate }, [samples.buffer]);
}

self.onmessage = async ({ data }) => {
  if (busy) {
    postMessage({ type: 'error', message: 'Speech worker is busy' });
    return;
  }
  busy = true;
  try {
    if (data?.type === 'load') {
      await load(data.model);
      postMessage({ type: 'ready' });
    } else if (data?.type === 'speak') {
      await speak(data);
    } else {
      throw Error('Unknown speech request');
    }
  } catch (error) {
    postMessage({ type: 'error', message: error?.message || String(error) });
  } finally {
    busy = false;
  }
};
