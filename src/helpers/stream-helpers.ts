import assert from 'node:assert';
import stream from 'node:stream';

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

type DestroyableWritable = NodeJS.WritableStream & { destroy(error?: Error): void };

export function multiplexStreamWriter(streams: DestroyableWritable[]): stream.Writable {
  assert.notEqual(streams.length, 0);
  const errorListeners = new Map<DestroyableWritable, (error: Error) => void>();
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
    destroy(error, callback) {
      for (const destination of streams) destination.destroy(error ?? undefined);
      callback(error);
    },
  });
  for (const destination of streams) {
    const listener = (error: Error) => writer.destroy(error);
    errorListeners.set(destination, listener);
    destination.on('error', listener);
  }
  const removeErrorListeners = () => {
    for (const [destination, listener] of errorListeners) destination.off('error', listener);
  };
  writer.once('finish', removeErrorListeners);
  writer.once('close', removeErrorListeners);
  return writer;
}
