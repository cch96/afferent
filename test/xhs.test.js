// Xiaohongshu / rednote: the note's video file address, from the page's resource timing (audio contract).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/xhs.js';
const { note, audio } = globalThis.AfferentXhs;

const ID = '6a52522e0000000011015940';
test('note(): xiaohongshu.com and rednote.com, /explore/<id> and /discovery/item/<id>', () => {
  for (const host of ['www.xiaohongshu.com', 'www.rednote.com']) {
    assert.equal(note(`https://${host}/explore/${ID}`), ID);
    assert.equal(note(`https://${host}/explore/${ID}?xsec_token=x&xsec_source=pc_feed`), ID);
    assert.equal(note(`https://${host}/discovery/item/${ID}`), ID);
    assert.equal(note(`https://${host}/discovery/item/${ID}/`), ID);
  }
  for (const u of ['https://www.xiaohongshu.com/explore', 'https://www.xiaohongshu.com/', `https://www.xiaohongshu.com/user/profile/${ID}`,
    `https://xiaohongshu.com.evil.io/explore/${ID}`, `https://e.com/explore/${ID}`, `https://m.xiaohongshu.com/discovery/item/${ID}`,
    `https://www.rednote.com/explore/${ID}/comments`, 'not a url']) assert.equal(note(u), null, u);
});

// Signed-looking: params and their order must come back byte for byte.
const V = n => `https://sns-video-hw.xhscdn.com/stream/1/110/259/01e6${n}_259.mp4?sign=ab%2Fcd&t=6a52522e&z=1`;
const e = (name, startTime, initiatorType = 'fetch') => ({ name, startTime, initiatorType });
test('audio(): the most recent video file on a Xiaohongshu CDN host; thumbnails, images and other hosts ignored', () => {
  const entries = [
    e('https://www.rednote.com/explore', 1, 'navigation'),
    e(V(1), 10),
    e('https://sns-webpic-qc.xhscdn.com/202611171200/abc/1040g2sg31!nd_dft_wlteh_webp_3', 20, 'img'),
    e('https://sns-avatar-qc.xhscdn.com/avatar/1040g.jpg?imageView2/2/w/80', 21, 'img'),
    e(V(2), 30),
    e('https://fe-static.xhscdn.com/formula-static/xhs-pc-web/public/resource/js/main.js', 40, 'script'),
    e('https://sns-img-qc.xhscdn.com/notes_pre_post/1040g.webp', 41, 'img'),
    e('https://cdn.e.com/v/1.mp4', 50),
    e('https://xhscdn.com.evil.io/v.mp4', 51),
    e('https://sns-video-qc.xhscdn.com/stream/cover.jpg', 52, 'img'),
    e('https://sns-video-qc.xhscdn.com/stream/a.m4a', 53), // only .mp4 was seen on real notes
    e('https://sns-video-qc.xhscdn.com/stream/a.mov', 54),
  ];
  assert.deepEqual(audio(entries), { audio: { source: 'xiaohongshu', urls: [V(2)], expires: null } });
  assert.deepEqual(audio([e('https://sns-video-al.rednotecdn.com/stream/1/x_259.mp4?a=1', 1)]),
    { audio: { source: 'xiaohongshu', urls: ['https://sns-video-al.rednotecdn.com/stream/1/x_259.mp4?a=1'], expires: null } });
});

test('audio(): none found -> audio_error; over-long or non-http names are not used', () => {
  assert.deepEqual(audio([]), { audio_error: 'xhs no video url' });
  assert.deepEqual(audio(), { audio_error: 'xhs no video url' }); // node has no such entries
  assert.deepEqual(audio([e('https://sns-webpic-qc.xhscdn.com/a!nd_dft_wlteh_webp_3', 1, 'img'),
    e('https://sns-video-hw.xhscdn.com/' + 'a'.repeat(4096) + '.mp4', 2), e('blob:https://www.rednote.com/x.mp4', 3)]),
  { audio_error: 'xhs no video url' });
});
