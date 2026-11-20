// In-memory stand-ins for chrome.storage.local, chrome.alarms and fetch.
export function fakeStore(data = {}) {
  const clone = v => structuredClone(v);
  return {
    data,
    async get(keys) {
      if (keys == null) return clone(data);
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = clone(v); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    async getKeys() { return Object.keys(data); },
  };
}

export function fakeAlarms() {
  const set = new Map();
  return {
    set,
    create(name, info) { set.set(name, info); },
    clear(name) { set.delete(name); },
  };
}

export function fakeClock(t = Date.UTC(2026, 10, 5, 10, 0, 0)) {
  const c = () => c.t;
  c.t = t;
  return c;
}

// Each call shifts one scripted response: a number (status), an object {status, body}, or 'network'/'timeout'.
export function fakeFetch(script) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body && JSON.parse(init.body) });
    const s = script.shift() ?? 200;
    if (s === 'network') throw new TypeError('Failed to fetch');
    if (s === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const { status, body } = typeof s === 'number' ? { status: s, body: s === 200 ? { status: 'stored' } : {} } : s;
    return new Response(JSON.stringify(body), { status });
  };
  f.calls = calls;
  return f;
}
