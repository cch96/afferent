// The only place core code learns about destinations. Add a destination: one file + one line here.
import webhook from './webhook.js';
import supermemory from './supermemory.js';
import mem0 from './mem0.js';
import hindsight from './hindsight.js';

export const adapters = [webhook, supermemory, mem0, hindsight];
export const getAdapter = id => adapters.find(a => a.id === id);

// The paste box: the first platform that recognises the text on its own.
export function detectKey(text) {
  for (const a of adapters) { const cfg = a.fromKey(text); if (cfg) return { id: a.id, cfg }; }
  return null;
}
export const destName = (id, cfg) => cfg?.name || getAdapter(id).label;
