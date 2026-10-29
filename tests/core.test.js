import test from 'node:test';
import assert from 'node:assert/strict';
import { validName, imageName, frameURL, serverOrigin, StabilityTracker, DownloadQueue } from '../core.js';

test('server configuration rejects credentials, share tokens and non-HTTP schemes', () => {
  assert.equal(serverOrigin('http://localhost:4000/'), 'http://localhost:4000');
  for (const value of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com/share?key=secret']) assert.throws(() => serverOrigin(value));
});
test('filenames cannot escape destination; URL names are encoded', () => {
  for (const name of ['../x.png', 'a/b.png', 'a\\b.png', 'CON.png', 'x.png ', '.', 'x\u0000.png']) assert.equal(validName(name), false);
  assert.equal(imageName('frame 0001.exr'), true);
  assert.equal(imageName('movie.mp4'), false);
  assert.equal(frameURL('https://example.com', 'frame #1.png'), 'https://example.com/images/frame%20%231.png');
});
test('recovery requires three separated observations and resets on writes or deletion', () => {
  const tracker = new StabilityTracker();
  assert.equal(tracker.observe('1.png', 100, 'a', 0), false);
  assert.equal(tracker.observe('1.png', 100, 'a', 4000), false);
  assert.equal(tracker.observe('1.png', 100, 'a', 8000), true);
  assert.equal(tracker.observe('1.png', 200, 'b', 9000), false);
  tracker.retain(new Set());
  assert.equal(tracker.observe('1.png', 200, 'b', 20000), false);
  assert.equal(tracker.observe('zero.png', 0, 'a', 0), false);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
test('queue deduplicates, bounds concurrency, and preserves queued work while paused', async () => {
  const release = [];
  let active = 0, peak = 0;
  const queue = new DownloadQueue(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => release.push(resolve)); active--;
  });
  queue.add('1.png'); queue.add('1.png'); queue.add('2.exr'); queue.add('3.png');
  assert.equal(queue.counts().pending, 3);
  queue.resume(); assert.equal(active, 2);
  queue.pause(); release.splice(0).forEach(fn => fn()); await tick();
  assert.deepEqual(queue.counts(), { saved: 2, pending: 1, failed: 0 });
  queue.resume(); release.splice(0).forEach(fn => fn()); await tick();
  assert.equal(peak, 2); assert.equal(queue.counts().saved, 3);
});
test('failed disk permissions are not counted as saved and can be retried', async () => {
  let fail = true;
  const queue = new DownloadQueue(async () => { if (fail) throw new DOMException('Denied', 'NotAllowedError'); });
  queue.add('1.png'); queue.resume(); await tick();
  assert.equal(queue.counts().failed, 1); assert.equal(queue.counts().saved, 0);
  fail = false; queue.retry(); await tick();
  assert.equal(queue.counts().saved, 1);
});
