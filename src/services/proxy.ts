import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PROXY_FILE = path.resolve(process.cwd(), 'proxy.txt');
const FAILED_COOLDOWN_MS = 5 * 60 * 1000;

const PROXY_FILE_TEMPLATE = [
  '# Add proxies here, one per line. Supported formats:',
  '#',
  '#   84.247.60.125:6095',
  '#   84.247.60.125:6095:username:password',
  '#   username:password@84.247.60.125:6095',
  '#   http://84.247.60.125:6095',
  '#   socks5://username:password@84.247.60.125:6095',
  '#',
  '# Proxies are picked randomly per connection. Failed proxies are',
  '# retried after 5 minutes. Edit this file anytime — no restart needed.',
  '',
].join('\n');

function parseProxyLine(line: string): string | null {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  if (/^(https?|socks[45]):\/\//i.test(line)) return line;

  if (line.includes('@')) return `http://${line}`;

  const parts = line.split(':');
  if (parts.length === 2) return `http://${line}`;
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  return null;
}

class ProxyManager {
  private proxies: string[] = [];
  private failed = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: fs.FSWatcher | null = null;

  constructor() {
    this.ensureFile();
    this.load();
    this.startWatch();
  }

  private ensureFile(): void {
    if (!fs.existsSync(PROXY_FILE)) {
      fs.writeFileSync(PROXY_FILE, PROXY_FILE_TEMPLATE, 'utf8');
      console.log('[proxy] Created proxy.txt (add proxies to enable routing)');
    }
  }

  private load(): void {
    try {
      const content = fs.readFileSync(PROXY_FILE, 'utf8');
      const parsed = content
        .split('\n')
        .map(parseProxyLine)
        .filter((p): p is string => p !== null);
      this.proxies = parsed;
      if (parsed.length > 0) {
        console.log(`[proxy] Loaded ${parsed.length} proxy${parsed.length === 1 ? '' : 's'}`);
      }
    } catch {
      this.proxies = [];
    }
  }

  private startWatch(): void {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      this.watcher = fs.watch(PROXY_FILE, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          this.failed.forEach((t) => clearTimeout(t));
          this.failed.clear();
          this.load();
        }, 200);
      });
    } catch {
      // fs.watch unavailable — proxy.txt changes require restart
    }
  }

  getRandomProxy(): string | null {
    const available = this.proxies.filter((p) => !this.failed.has(p));
    if (!available.length) return null;
    return available[Math.floor(Math.random() * available.length)];
  }

  markFailed(proxyUrl: string): void {
    if (this.failed.has(proxyUrl)) return;
    console.warn(`[proxy] Failed — cooling down 5 min: ${proxyUrl}`);
    const timer = setTimeout(() => {
      this.failed.delete(proxyUrl);
      console.log(`[proxy] Re-enabled: ${proxyUrl}`);
    }, FAILED_COOLDOWN_MS);
    this.failed.set(proxyUrl, timer);
  }

  createAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent {
    if (/^socks/i.test(proxyUrl)) return new SocksProxyAgent(proxyUrl);
    return new HttpsProxyAgent(proxyUrl);
  }

  hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  destroy(): void {
    this.watcher?.close();
    this.failed.forEach((t) => clearTimeout(t));
  }
}

export const proxyManager = new ProxyManager();
