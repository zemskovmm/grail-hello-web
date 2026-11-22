import { createSHA256 } from './vendor/hash.mjs';
async function digest(file) {
  const h = await createSHA256();
  h.init();
  for await (const data of file.stream()) h.update(data);
  return h.digest();
}
export async function weight(m, status, transfer = fetch) {
  if (!navigator.storage?.getDirectory || !navigator.locks)
    throw Error('Persistent model cache is not available on this origin');
  if (!/^[0-9a-f]{64}$/.test(m.sha256) || !/^[0-9a-f]{40}$/.test(m.revision) || !m.web)
    throw Error('Unsupported model');
  return navigator.locks.request('grail-npc:' + m.sha256, async () => {
    const root = await navigator.storage.getDirectory(),
      dir = await root.getDirectoryHandle('grail-npc-v1', { create: true });
    const key = m.sha256 + '.gguf';
    let handle;
    try {
      handle = await dir.getFileHandle(key);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    if (handle) {
      const f = await handle.getFile();
      status('Verifying cached weights…');
      if (f.size === m.bytes && (await digest(f)) === m.sha256) {
        status('Using verified cache');
        return f;
      }
    }
    const space = await navigator.storage.estimate();
    if (space.quota && space.quota - (space.usage || 0) < m.bytes)
      throw Error('Insufficient browser storage');
    const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
    const response = await transfer(url, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(900000),
    });
    if (!response.ok || !response.body) throw Error(`Weight download HTTP ${response.status}`);
    handle ??= await dir.getFileHandle(key, { create: true });
    const h = await createSHA256();
    h.init();
    const out = await handle.createWritable();
    let n = 0,
      shown = -1;
    try {
      for await (const chunk of response.body) {
        n += chunk.length;
        if (n > m.bytes) throw Error('Weight length mismatch');
        h.update(chunk);
        await out.write(chunk);
        const pct = Math.floor((n * 100) / m.bytes);
        if (pct !== shown) {
          shown = pct;
          status(`Downloading ${pct}% (${n}/${m.bytes} bytes)`);
        }
      }
      if (n !== m.bytes || h.digest() !== m.sha256) throw Error('Weight digest/size mismatch');
      await out.close();
    } catch (e) {
      try {
        await out.abort();
      } catch {}
      throw e;
    }
    return handle.getFile();
  });
}
