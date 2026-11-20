import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/dwell.js';
const { createDwell } = globalThis.AfferentDwell;

test('starts inactive: nothing counted, no first/last', () => {
  const d = createDwell(0, false);
  assert.equal(d.ms(5000), 0);
  assert.equal(d.first(), null);
  assert.equal(d.last(5000), null);
});

test('accumulates only while active, across transitions', () => {
  const d = createDwell(1000, true);  // visible+focused at load
  d.set(false, 4000);                 // blur: 3 s
  d.set(false, 5000);                 // repeated inactive is a no-op
  d.set(true, 10000);                 // back
  d.set(true, 11000);                 // repeated active is a no-op
  assert.equal(d.ms(12000), 5000);
  assert.equal(d.first(), 1000);
  assert.equal(d.last(12000), 12000); // still active -> now
  d.set(false, 13000);
  assert.equal(d.ms(99000), 6000);
  assert.equal(d.last(99000), 13000);
});

test('background tab first opened later', () => {
  const d = createDwell(0, false);
  d.set(true, 60000);
  assert.equal(d.first(), 60000);
  assert.equal(d.ms(70000), 10000);
});
