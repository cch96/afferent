// Content-side playback tracker: counted time, background time, played ranges per element.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/media.js';
import { fakeMedia } from './fakedom.js';
const { createMedia } = globalThis.AfferentMedia;

// Plays `el` for `s` seconds from media time `from`, sampling every second like the content tick.
function play(m, el, t, s, from, active) {
  for (let i = 1; i <= s; i++) {
    el.ranges = [...el.ranges.filter(r => r[1] < from), [from, from + i]];
    el.currentTime = from + i * (el.playbackRate ?? 1);
    m.sample(t + i * 1000, active);
  }
  return t + s * 1000;
}

test('played 0-30 s, then seek to 60-90 s: exactly those two ranges', () => {
  const m = createMedia(), el = fakeMedia();
  let t = 0;
  m.see(el); m.sample(t, true);
  t = play(m, el, t, 30, 0, true);
  t = play(m, el, t, 30, 60, true);
  const [e] = m.list();
  assert.equal(e.played.length, 2);
  e.played.forEach(([a, b], i) => {
    const [x, y] = [[0, 30], [60, 90]][i];
    assert.ok(Math.abs(a - x) <= 1 && Math.abs(b - y) <= 1, `${a}-${b}`);
  });
  assert.ok(Math.abs(e.playMs - 60000) <= 1000, e.playMs);
  assert.equal(e.bgMs, 0);
});

test('audible playback in the background for 10 min counts as play and background time', () => {
  const m = createMedia(), el = fakeMedia({ tagName: 'AUDIO' });
  m.see(el); m.sample(0, false);
  for (let t = 1000; t <= 600000; t += 1000) m.sample(t, false);
  const [e] = m.list();
  assert.equal(e.kind, 'audio');
  assert.ok(e.playMs >= 590000 && e.bgMs >= 590000, `${e.playMs} ${e.bgMs}`);
  assert.equal(m.counting(), true);
});

test('muted autoplay in the background: nothing listed', () => {
  for (const over of [{ muted: true }, { volume: 0 }]) {
    const m = createMedia(), el = fakeMedia(over);
    m.see(el); m.sample(0, false);
    for (let t = 1000; t <= 600000; t += 1000) m.sample(t, false);
    assert.deepEqual(m.list(), []);
    assert.equal(m.counting(), false);
  }
});

test('muted playback counts while the page is active', () => {
  const m = createMedia(), el = fakeMedia({ muted: true });
  m.see(el); m.sample(0, true);
  m.sample(5000, true);
  assert.equal(m.list()[0].playMs, 5000);
});

test('paused and ended do not count; a long gap (sleep) is capped', () => {
  const m = createMedia(), el = fakeMedia({ paused: true });
  m.see(el); m.sample(0, true); m.sample(10000, true);
  assert.deepEqual(m.list(), []);
  el.paused = false; m.sample(10000, true);
  m.sample(10000 + 3600e3, true);
  assert.equal(m.list()[0].playMs, 65000);
  el.ended = true; m.sample(10000 + 3600e3, true); m.sample(20000 + 3600e3, true);
  assert.equal(m.list()[0].playMs, 65000);
  assert.equal(m.counting(), false);
});

test('a src change on the same element starts a new entry; first/last follow counted play', () => {
  const m = createMedia(), el = fakeMedia();
  m.see(el); m.sample(1000, true);
  el.ranges = [[0, 5]]; m.sample(6000, true);
  el.currentSrc = 'https://cdn.e.com/next.mp4'; el.ranges = [];
  m.sample(6000, true);
  el.ranges = [[0, 3]]; m.sample(9000, true);
  const [a, b] = m.list();
  assert.equal(a.src, 'https://cdn.e.com/v.mp4');
  assert.deepEqual(a.played, [[0, 5]]);
  assert.equal(b.src, 'https://cdn.e.com/next.mp4');
  assert.deepEqual(b.played, [[0, 3]]);
  assert.equal(a.playMs + b.playMs, 8000);
  assert.equal(m.first(), 1000);
  assert.equal(m.last(), 9000);
});

test('ranges survive a reload of the same src (played resets)', () => {
  const m = createMedia(), el = fakeMedia();
  m.see(el); m.sample(0, true);
  el.ranges = [[0, 10]]; m.sample(10000, true);
  el.ranges = []; m.sample(10000, true);
  el.ranges = [[50, 55]]; m.sample(15000, true);
  assert.deepEqual(m.list()[0].played, [[0, 10], [50, 55]]);
});

// Neurosea transcribes only what was heard: the played parts while unmuted with volume > 0.
const near = (rs, want) => rs.length === want.length && rs.every(([a, b], i) => Math.abs(a - want[i][0]) <= 1 && Math.abs(b - want[i][1]) <= 1);
const heardOf = (over, active = true, s = 30) => {
  const m = createMedia(), el = fakeMedia({ currentTime: 0, ...over });
  m.see(el); m.sample(0, active);
  play(m, el, 0, s, 0, active);
  return m.list()[0];
};

test('heard: muted the whole time -> []; volume 0 counts as muted', () => {
  const muted = heardOf({ muted: true });
  assert.ok(muted.playMs >= 29000, muted.playMs);
  assert.deepEqual(muted.heard, []);
  assert.deepEqual(heardOf({ volume: 0 }).heard, []);
});

test('heard: muted then unmuted covers only the unmuted part', () => {
  const m = createMedia(), el = fakeMedia({ muted: true, currentTime: 0 });
  m.see(el); m.sample(0, true);
  const t = play(m, el, 0, 180, 0, true);
  el.muted = false;
  play(m, el, t, 120, 180, true);
  const [e] = m.list();
  assert.ok(near(e.heard, [[180, 300]]), JSON.stringify(e.heard));
  assert.ok(near(e.played, [[0, 300]]), JSON.stringify(e.played));
});

test('heard: a seek leaves a gap', () => {
  const m = createMedia(), el = fakeMedia({ currentTime: 0 });
  m.see(el); m.sample(0, true);
  const t = play(m, el, 0, 30, 0, true);
  play(m, el, t, 30, 100, true); // jumped from 30 to 100
  const [e] = m.list();
  assert.ok(near(e.heard, [[0, 30], [100, 130]]), JSON.stringify(e.heard));
});

test('heard: audible background playback follows played; playbackRate 2 still counts', () => {
  const bg = heardOf({}, false);
  assert.ok(bg.bgMs >= 29000);
  assert.ok(near(bg.heard, bg.played) && near(bg.heard, [[0, 30]]), JSON.stringify(bg.heard));
  const fast = heardOf({ playbackRate: 2 });
  assert.ok(near(fast.heard, [[0, 60]]), JSON.stringify(fast.heard));
});
