import test from 'node:test';
import assert from 'node:assert/strict';

test('dashboard connects with credentials and saves original streams; truncated frames never count as saved', async () => {
  const elements = new Map();
  globalThis.document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', checked: false, disabled: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(id);
  } };
  globalThis.location = { href: 'chrome-extension://test/dashboard.html?server=https://render.example' };
  let grantedOrigin, socketOrigin, socketOptions, disconnected = false;
  globalThis.chrome = { permissions: { async request(value) { grantedOrigin = value.origins[0]; return true; } } };
  const socketEvents = {};
  const socket = { on(event, fn) { socketEvents[event] = fn; }, disconnect() { disconnected = true; } };
  const files = new Map();
  const aborted = [];
  const folder = {
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFileHandle(name) { return { async createWritable() {
      const chunks = [];
      return { async write(chunk) { chunks.push(...chunk); }, async close() { files.set(name, chunks); }, async abort() { aborted.push(name); } };
    } }; },
  };
  const windowEvents = {};
  globalThis.window = {
    io(origin, options) { socketOrigin = origin; socketOptions = options; return socket; },
    async showDirectoryPicker() { return { name: 'test-destination', async getDirectoryHandle() { return folder; } }; },
    addEventListener(event, fn) { windowEvents[event] = fn; },
  };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/render_list')) return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    const headers = { 'content-type': 'image/png', 'content-length': '3', 'last-modified': 'Thu, 29 Oct 2026 10:00:00 GMT' };
    if (options.method === 'HEAD') return new Response(null, { headers });
    return new Response(new Uint8Array(url.endsWith('0002.png') ? [1] : [1, 2, 3]), { headers });
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 9000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for dashboard'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    await import('../dashboard.js');
    await elements.get('connect').listeners.click();
    assert.equal(grantedOrigin, 'https://render.example/*');
    assert.equal(socketOrigin, 'https://render.example');
    assert.equal(socketOptions.withCredentials, true);
    assert.deepEqual(socketOptions.transports, ['websocket']);
    socketEvents.connect();
    // Event received before choosing a folder must remain available to queue.
    socketEvents.live_base64({ image_name: '0001.png', image_string: 'DO NOT SAVE PREVIEW' });
    await elements.get('start').listeners.click();
    await waitFor(() => files.has('0001.png'));
    assert.deepEqual(files.get('0001.png'), [1, 2, 3]);
    assert.equal(elements.get('saved').textContent, 1);
    socketEvents.live_base64({ image_name: '../escape.png' });
    socketEvents.live_base64({ image_name: '0001.png' });
    socketEvents.live_base64({ image_name: '0002.png' });
    await waitFor(() => elements.get('failed').textContent === 1);
    assert.equal(files.has('0002.png'), false);
    assert.equal(aborted.length, 3);
    assert.equal(elements.get('saved').textContent, 1);
    assert.equal(requests.filter(r => r.url.endsWith('0001.png') && r.options.method !== 'HEAD').length, 1);
    assert.ok(requests.every(r => r.options.credentials === 'include'));
    assert.ok(requests.every(r => !r.url.includes('escape')));
  } finally { windowEvents.pagehide?.(); }
  assert.equal(disconnected, true);
});
