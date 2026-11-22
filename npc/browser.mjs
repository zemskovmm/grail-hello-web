import { Wllama } from './vendor/wllama.mjs';
import { weight } from './cache.mjs';
let engine;
export async function load(m, status) {
  if (engine) {
    await engine.exit();
    engine = null;
  }
  const file = await weight(m, status);
  status('Loading verified weights on this device…');
  const w = new Wllama({ default: new URL('./vendor/wllama.wasm', import.meta.url).href });
  try {
    await w.loadModel([file], { n_ctx: 2048, n_batch: 128, n_threads: 1 });
    engine = w;
  } catch (e) {
    try {
      await w.exit();
    } catch {}
    throw e;
  }
}
export function ask(_m, request) {
  if (!engine) throw Error('Model is not ready');
  return engine.createChatCompletion(request);
}
