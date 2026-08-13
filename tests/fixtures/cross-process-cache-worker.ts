import { EventEmitter } from 'node:events';
import stream from 'node:stream';
import { createProxyCache, HTTP_RESPONSE_HEADER_CACHE_STATUS, type RequestI, type ResponseI } from '../../src';

class RecordingResponse extends stream.Writable implements ResponseI {
  readonly chunks: Buffer[] = [];
  readonly headers: Record<string, string> = {};
  statusCode = 200;

  setHeader(key: string, value: string | number | readonly string[]) {
    this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  send(chunk: string | Buffer) {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    this.end();
  }

  status(code: number) {
    this.statusCode = code;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.chunks.push(chunk);
    callback();
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

const [operation, cachePath, originUrl] = process.argv.slice(2);
if (!operation || !cachePath || !originUrl) {
  throw new Error('usage: cross-process-cache-worker.ts <request|warm> <cache-path> <origin-url>');
}

const cache = createProxyCache({
  cachePath,
  cacheSeeds: [originUrl],
  proxyPrefix: '/cache',
  shouldProxyPath: (url) => url === originUrl,
});

if (operation === 'warm') {
  const stats = await cache.warm({ concurrency: 1 });
  console.log(JSON.stringify({ operation, stats }));
} else if (operation === 'request') {
  const response = new RecordingResponse();
  const request = Object.assign(new EventEmitter(), {
    headers: {
      accept: '*/*',
      'accept-encoding': 'gzip, deflate',
      'accept-language': 'en-US,en;q=0.9',
    },
    path: cache.encodeProxyPath(originUrl),
    query: {},
  }) satisfies RequestI & EventEmitter;

  await cache.router(request, response);
  console.log(
    JSON.stringify({
      body: response.body,
      cacheStatus: response.headers[HTTP_RESPONSE_HEADER_CACHE_STATUS],
      operation,
      statusCode: response.statusCode,
    })
  );
} else {
  throw new Error(`unknown operation: ${operation}`);
}
