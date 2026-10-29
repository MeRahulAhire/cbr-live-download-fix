import { serverOrigin, imageName, frameURL, StabilityTracker, DownloadQueue } from './core.js';
const $ = id => document.getElementById(id);
let origin, socket, queue, folder, timer, scanning = false;
const stability = new StabilityTracker();
const announced = new Set();
const reportedFailures = new Set();
$('server').value = new URL(location.href).searchParams.get('server') || '';

function log(message) {
  const lines = `${new Date().toLocaleTimeString()}  ${message}\n${$('log').textContent}`.split('\n');
  $('log').textContent = lines.slice(0, 100).join('\n');
}
function update() {
  if (!queue) return;
  for (const [key, value] of Object.entries(queue.counts())) $(key).textContent = value;
  $('retry').disabled = !folder || queue.counts().failed === 0;
  for (const item of queue.items.values()) {
    if (item.state === 'failed' && !reportedFailures.has(item.name)) {
      reportedFailures.add(item.name); log(`Failed: ${item.name} — ${item.error}`);
    }
  }
}
async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    credentials: 'include', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(20000), ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}. ${[401,403].includes(response.status) ? 'Open your share link in this Chrome profile and check cookie settings.' : 'Check the server connection.'}`);
  return response;
}
async function listFrames() {
  const response = await request('/render_list', { method: 'POST' });
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.some(name => typeof name !== 'string')) throw new Error('This server did not return a valid Cloud Blender Render file list.');
  return payload.data.filter(imageName);
}
async function metadata(name) {
  const response = await request(`/images/${encodeURIComponent(name)}`, { method: 'HEAD' });
  return { size: Number(response.headers.get('content-length')), modified: response.headers.get('last-modified') };
}

async function save(name) {
  const destination = folder;
  if (!destination) throw new DOMException('Select a destination folder.', 'NotAllowedError');
  if (await destination.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    queue.pause(); $('pause').textContent = 'Resume';
    throw new DOMException('Folder access was revoked. Click Resume to grant it again.', 'NotAllowedError');
  }
  const before = await metadata(name);
  const response = await fetch(frameURL(origin, name), {
    credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${name}`);
  if (!response.body || /text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('The server returned a page or error instead of a frame.');
  const handle = await destination.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      await writer.write(value);
    }
    const after = await metadata(name);
    if (received === 0 || before.size !== received || after.size !== received || before.modified !== after.modified) throw new Error('Frame changed during transfer or byte count differs. Will retry.');
    await writer.close();
    log(`Saved ${name} (${(received / 1048576).toFixed(2)} MB)`);
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function scan() {
  if (scanning || !queue?.running || !$('catchup').checked) return;
  scanning = true;
  try {
    const names = await listFrames();
    stability.retain(new Set(names));
    // Bounded workers avoid opening thousands of HEAD requests at once.
    const candidates = names.filter(name => !queue.items.has(name));
    let cursor = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (cursor < candidates.length && queue.running && $('catchup').checked) {
        const name = candidates[cursor++];
        try {
          const { size, modified } = await metadata(name);
          if (stability.observe(name, size, modified, Date.now())) queue.add(name);
        } catch (error) { stability.records.delete(name); log(`Recovery check: ${name} — ${error.message}`); }
      }
    }));
  } catch (error) { log(`Recovery: ${error.message}`); }
  finally { scanning = false; }
}

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  try {
    origin = serverOrigin($('server').value.trim());
    const url = new URL(origin);
    const allowed = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (!allowed) throw new Error('Server access was not granted.');
    const existing = await listFrames();
    queue = new DownloadQueue(save, update);
    $('server').disabled = true;
    $('start').disabled = false;
    $('status').textContent = `${existing.length} image files found. Choose a folder to start listening and saving.`;
    // The application connects WebSocket-first. Avoid polling/upgrade here:
    // the reported deployment rejects follow-up polling requests with HTTP 400.
    socket = window.io(origin, { withCredentials: true, transports: ['websocket'], reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 30000, timeout: 20000 });
    socket.on('connect', () => {
      $('connection').textContent = `Connected to ${origin}`;
      log('Connected over WebSocket. Live frame events enabled.'); scan();
    });
    socket.on('disconnect', (reason, details) => {
      $('connection').textContent = 'Disconnected — reconnecting';
      log(`Disconnected: ${reason}${details?.message ? ` — ${details.message}` : ''}. Missed events require recovery or manual download.`);
    });
    socket.on('connect_error', error => {
      $('connection').textContent = `Socket connection failed: ${error.message}`;
      const status = error.context?.status;
      const description = typeof error.description === 'string' || typeof error.description === 'number' ? ` — ${error.description}` : '';
      log(`WebSocket connection error: ${error.message}${status ? ` (HTTP ${status})` : ''}${description}. Retrying automatically.`);
      // Browser WebSocket failures often hide the HTTP handshake response from
      // JavaScript. Preserve the error object for inspection without guessing.
      console.error('CBR WebSocket connection error', error);
    });
    socket.on('live_base64', payload => {
      if (imageName(payload?.image_name)) {
        announced.add(payload.image_name);
        if (folder) queue.add(payload.image_name);
      }
    });
    socket.on('live-base64-error', message => log(`Preview unavailable: ${String(message)}. Recovery or manual download may be needed.`));
    timer = setInterval(scan, 4000);
  } catch (error) {
    $('connection').textContent = error.message; $('connect').disabled = false;
  }
});

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    const root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cbr-live-frames' });
    const name = `CBR-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
    folder = await root.getDirectoryHandle(name, { create: true });
    $('destination').textContent = `${root.name} / ${name}`;
    for (const name of announced) queue.add(name);
    queue.resume(); $('pause').disabled = false;
    $('status').textContent = 'Watching for completed-frame preview events. Keep this tab open.';
    log('Download session started.'); scan();
  } catch (error) {
    $('start').disabled = false;
    if (error.name !== 'AbortError') { $('status').textContent = error.message; log(error.message); }
  }
});
$('pause').addEventListener('click', async () => {
  try {
    if (queue.running) {
      queue.pause(); $('pause').textContent = 'Resume';
      $('status').textContent = 'Paused. Active transfers finish; live events remain queued.';
    } else {
      if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Folder write access is required.');
      queue.resume(); $('pause').textContent = 'Pause';
      $('status').textContent = 'Watching for completed-frame preview events.'; scan();
    }
  } catch (error) { $('status').textContent = error.message; }
});
$('retry').addEventListener('click', () => { reportedFailures.clear(); queue.retry(); if (!queue.running) $('status').textContent = 'Retries queued. Click Resume to download them.'; });
$('catchup').addEventListener('change', () => { stability.records.clear(); scan(); });
window.addEventListener('pagehide', () => { clearInterval(timer); socket?.disconnect(); });
