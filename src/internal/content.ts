import type stream from 'node:stream';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import * as csstree from 'css-tree';
import { parse as parseCss } from 'css-tree';
import { fromReadable } from '../helpers/stream-helpers';

export type CssUrlTransformer = (url: string) => string | undefined;

export class ContentTooLargeError extends Error {
  constructor(limit: number) {
    super(`CSS content exceeds the ${limit}-byte transformation limit`);
    this.name = 'ContentTooLargeError';
  }
}

export function replaceUrlsInCss(text: string, transformUrl: CssUrlTransformer): string {
  const stylesheet = parseCss(text);
  let modified = false;

  cssForEachUrl(stylesheet, (value) => {
    const transformed = transformUrl(value);
    if (transformed === undefined) return undefined;
    modified = true;
    return transformed;
  });
  return modified ? csstree.generate(stylesheet) : text;
}

export function makeProxyReplacementStream(
  input: NodeJS.ReadableStream,
  contentType: string | undefined,
  contentEncoding: string | undefined,
  transformUrl: CssUrlTransformer,
  maxTransformBytes = Number.POSITIVE_INFINITY
): NodeJS.ReadableStream {
  if (!contentType?.startsWith('text/css')) return input;
  return makeCssRewriterStream(input, contentEncoding, transformUrl, maxTransformBytes);
}

function makeCssRewriterStream(
  input: NodeJS.ReadableStream,
  encoding: string | undefined,
  transformUrl: CssUrlTransformer,
  maxTransformBytes: number
): NodeJS.ReadableStream {
  switch (encoding) {
    case 'deflate': {
      const decompressor = zlib.createInflate();
      const compressor = zlib.createDeflate();
      const rewritten = makeCssRewriterStream(decompressor, undefined, transformUrl, maxTransformBytes);
      forwardErrors(compressor, [input, decompressor, rewritten]);
      input.pipe(decompressor);
      rewritten.pipe(compressor);
      return compressor;
    }
    case 'gzip':
    case 'x-gzip': {
      const decompressor = zlib.createGunzip();
      const compressor = zlib.createGzip();
      const rewritten = makeCssRewriterStream(decompressor, undefined, transformUrl, maxTransformBytes);
      forwardErrors(compressor, [input, decompressor, rewritten]);
      input.pipe(decompressor);
      rewritten.pipe(compressor);
      return compressor;
    }
    default:
      if (encoding) return input;
  }

  async function* rewrite() {
    // css-tree requires the complete stylesheet before it can rewrite its AST.
    const text = await readWithLimit(input, maxTransformBytes);
    yield replaceUrlsInCss(text.toString(), transformUrl);
  }
  return Readable.from(rewrite());
}

export function decodeContent(
  data: Buffer,
  encoding?: string,
  maxOutputBytes = Number.POSITIVE_INFINITY
): Buffer | null {
  if (!encoding && data.length > maxOutputBytes) throw new ContentTooLargeError(maxOutputBytes);
  const options = Number.isFinite(maxOutputBytes) ? { maxOutputLength: maxOutputBytes } : undefined;
  switch (encoding) {
    case 'deflate':
      return zlib.inflateSync(data, options);
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(data, options);
    default:
      return encoding ? null : data;
  }
}

async function readWithLimit(input: NodeJS.ReadableStream, limit: number): Promise<string | Buffer> {
  if (!Number.isFinite(limit)) return fromReadable(input);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    length += buffer.length;
    if (length > limit) throw new ContentTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Call `callback` for each URL in the CSS stylesheet. If `callback` returns a
 * value, replace the URL with that value. */
export function cssForEachUrl(
  stylesheet: csstree.CssNode | string,
  callback: (url: string) => undefined | string
): void {
  csstree.walk(typeof stylesheet === 'string' ? parseCss(stylesheet) : stylesheet, {
    visit: 'Url',
    enter(node) {
      const urlNode = node as unknown as { value: string };
      const transformed = callback(urlNode.value);
      if (transformed !== undefined) urlNode.value = transformed;
    },
  });
}

function forwardErrors(destination: stream.Readable, sources: NodeJS.ReadableStream[]): void {
  for (const source of sources) {
    source.on('error', (error) => destination.destroy(error));
  }
}
