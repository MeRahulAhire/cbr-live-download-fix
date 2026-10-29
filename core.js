export function serverOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS server URL without embedded credentials.');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the server origin, without a path, share key, or query.');
  return url.origin;
}

export function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 240 &&
    !/[\\/\x00-\x1f<>:"|?*]/.test(name) && !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && name !== '.' && name !== '..';
}

export function imageName(name) {
  return validName(name) && /\.(png|jpe?g|exr|tiff?|tga|bmp|webp|hdr|jp2|cin|dpx|rgb|rgba|sgi|bw)$/i.test(name);
}

export function frameURL(origin, name) {
  if (!validName(name)) throw new Error('Unsafe or unsupported filename');
  return `${origin}/images/${encodeURIComponent(name)}`;
}

// Recovery heuristic only; unchanged metadata cannot prove a writer has finished.
export class StabilityTracker {
  constructor() { this.records = new Map(); }
  observe(name, size, modified, now) {
    if (!Number.isSafeInteger(size) || size <= 0 || !modified) { this.records.delete(name); return false; }
    const signature = `${size}:${modified}`;
    const old = this.records.get(name);
    if (!old || old.signature !== signature) {
      this.records.set(name, { signature, since: now, count: 1 });
      return false;
    }
    old.count++;
    return old.count >= 3 && now - old.since >= 6000;
  }
  retain(names) { for (const name of this.records.keys()) if (!names.has(name)) this.records.delete(name); }
}

export class DownloadQueue {
  constructor(save, changed = () => {}, concurrency = 2) {
    this.save = save; this.changed = changed; this.concurrency = concurrency;
    this.items = new Map(); this.running = false; this.active = 0;
  }
  add(name) {
    if (!imageName(name) || this.items.has(name)) return;
    this.items.set(name, { name, state: 'queued', attempts: 0 });
    this.changed(); this.pump();
  }
  resume() { this.running = true; this.pump(); }
  pause() { this.running = false; this.changed(); }
  retry() {
    for (const item of this.items.values()) if (item.state === 'failed') { item.state = 'queued'; item.attempts = 0; }
    this.changed(); this.pump();
  }
  pump() {
    while (this.running && this.active < this.concurrency) {
      const item = [...this.items.values()].find(item => item.state === 'queued');
      if (!item) break;
      item.state = 'active'; this.active++; this.changed();
      this.run(item);
    }
  }
  async run(item) {
    try {
      item.attempts++;
      await this.save(item.name);
      item.state = 'saved'; item.error = '';
    } catch (error) {
      item.error = error.message;
      // Automatic retries are bounded. Delay does not occupy a download slot.
      if (item.attempts < 3 && !['NotAllowedError', 'SecurityError', 'QuotaExceededError'].includes(error.name)) {
        item.state = 'waiting';
        setTimeout(() => { item.state = 'queued'; this.changed(); this.pump(); }, 1000 * 2 ** item.attempts);
      } else item.state = 'failed';
    } finally { this.active--; this.changed(); this.pump(); }
  }
  counts() {
    const items = [...this.items.values()];
    return { saved: items.filter(x => x.state === 'saved').length, failed: items.filter(x => x.state === 'failed').length, pending: items.filter(x => !['saved', 'failed'].includes(x.state)).length };
  }
}
