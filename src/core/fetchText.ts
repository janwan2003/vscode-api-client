import { sendRequest, type SendOptions } from './send.ts';

/**
 * GET a definition or collection from a URL (for "import from URL"). Follows redirects; anything but
 * a 2xx text response is an error that names the URL. Not bundled into the website (node:http).
 */
export async function fetchText(url: string, opts: SendOptions = {}): Promise<{ text: string; fileName: string; url: string }> {
  if (!/^https?:\/\//i.test(url.trim())) throw new Error(`Not an http(s) URL: ${url}`);
  const res = await sendRequest({ method: 'GET', url: url.trim(), headers: [{ name: 'Accept', value: 'application/json, application/yaml, text/yaml, */*' }] }, { timeoutMs: 30000, ...opts, followRedirects: true });
  if (res.status < 200 || res.status >= 300) throw new Error(`GET ${url} returned ${res.status} ${res.statusText}`.trim());
  if (res.bodyEncoding !== 'utf8') throw new Error(`GET ${url} returned binary data, not JSON or YAML`);
  const last = new URL(res.url).pathname.split('/').filter(Boolean).pop() ?? '';
  return { text: res.body, fileName: decodeURIComponent(last) || 'openapi.json', url: res.url };
}
