import assert from 'node:assert';
import stream from 'node:stream';

/** A stream.Writable that counts the number of characters, buffer items,
 * Uint8Array items, or objects written to it. */
export class WritableCounter extends stream.Writable {
  length = 0;
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    if (typeof chunk === 'string' || chunk instanceof Buffer || chunk instanceof Uint8Array) {
      this.length += chunk.length;
    } else {
      this.length++;
    }
    callback();
  }
}

/** Read the remaining chunks from a ReadableStream, and combine them into a
 * single string (if they are all strings) or Buffer.
 *
 * Note: Doesn't handle chunks of type `Uint8Array`.
 */
export async function fromReadable(
  stream: NodeJS.ReadableStream,
  emptyValue: string | Buffer = ''
): Promise<string | Buffer> {
  const chunks: (string | Buffer)[] = [];
  for await (const chunk of stream) {
    assert.ok(typeof chunk === 'string' || Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  return chunks.length === 0
    ? emptyValue
    : chunks.length === 1
      ? chunks[0]
      : chunks.every((chunk) => typeof chunk === 'string')
        ? chunks.join('')
        : chunks.every((chunk) => chunk instanceof Buffer)
          ? Buffer.concat(chunks as Buffer[])
          : Buffer.concat(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk)));
}

export function multiplexStreamWriter(streams: NodeJS.WritableStream[]): NodeJS.WritableStream {
  assert.notEqual(streams.length, 0);
  const writer = new stream.PassThrough({
    write(chunk, encoding, callback) {
      let error: Error | null | undefined = null;
      let count = streams.length;
      for (const stream of streams) {
        stream.write(chunk, encoding, (err) => {
          error ??= err; // invoke the callback with only the first error
          if (--count === 0) {
            callback(error);
          }
        });
      }
    },
    final(callback) {
      let count = streams.length;
      for (const stream of streams) {
        stream.end(() => {
          if (--count === 0) {
            callback();
          }
        });
      }
    },
  });
  for (const destination of streams) {
    destination.on('error', (error) => writer.destroy(error));
  }
  return writer;
}
