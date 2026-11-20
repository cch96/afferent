// Classic script (shared with content.js in the isolated world), also importable by node tests.
// Counts time while the page is read: active (visible AND focused) with input in the last 5 minutes.
globalThis.AfferentDwell = {
  createDwell(now, active) {
    let total = 0, since = active ? now : null, first = since, last = since;
    return {
      set(isActive, t) {
        if (isActive && since === null) { since = t; if (first === null) first = t; }
        else if (!isActive && since !== null) { total += t - since; last = t; since = null; }
      },
      ms: t => total + (since === null ? 0 : t - since),
      first: () => first,
      last: t => (since === null ? last : t),
    };
  },
};
