import { describe, expect, test } from 'bun:test';
import { AsyncReadWriteLock } from '../src/internal/async-read-write-lock';

describe('AsyncReadWriteLock', () => {
  test('allows concurrent readers', async () => {
    const lock = new AsyncReadWriteLock();
    const release = deferred<void>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const first = lock.withRead(async () => {
      firstEntered.resolve();
      await release.promise;
    });
    await firstEntered.promise;
    const second = lock.withRead(async () => {
      secondEntered.resolve();
      await release.promise;
    });

    await expect(settlesNextTurn(secondEntered.promise)).resolves.toBe(true);
    release.resolve();
    await Promise.all([first, second]);
  });

  test('queues a writer behind readers and later readers behind the writer', async () => {
    const lock = new AsyncReadWriteLock();
    const events: string[] = [];
    const releaseFirst = deferred<void>();
    const releaseWriter = deferred<void>();
    const firstEntered = deferred<void>();
    const writerEntered = deferred<void>();
    const secondEntered = deferred<void>();

    const first = lock.withRead(async () => {
      events.push('first read');
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const writer = lock.withWrite(async () => {
      events.push('write');
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    const second = lock.withRead(async () => {
      events.push('second read');
      secondEntered.resolve();
    });

    expect(await settlesNextTurn(writerEntered.promise)).toBe(false);
    expect(await settlesNextTurn(secondEntered.promise)).toBe(false);
    releaseFirst.resolve();
    await writerEntered.promise;
    expect(events).toEqual(['first read', 'write']);
    expect(await settlesNextTurn(secondEntered.promise)).toBe(false);
    releaseWriter.resolve();
    await Promise.all([first, writer, second]);
    expect(events).toEqual(['first read', 'write', 'second read']);
  });

  test('runs one writer at a time', async () => {
    const lock = new AsyncReadWriteLock();
    const releaseFirst = deferred<void>();
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const first = lock.withWrite(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = lock.withWrite(async () => {
      secondEntered.resolve();
    });

    expect(await settlesNextTurn(secondEntered.promise)).toBe(false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(await settlesNextTurn(secondEntered.promise)).toBe(true);
  });

  test('waits for every reader and preserves ownership across queued handoffs', async () => {
    const lock = new AsyncReadWriteLock();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const releaseWriter = deferred<void>();
    const readersEntered = deferred<void>();
    const writerEntered = deferred<void>();
    const lateReaderEntered = deferred<void>();
    let activeReaders = 0;

    const reader = (release: Promise<void>) =>
      lock.withRead(async () => {
        activeReaders++;
        if (activeReaders === 2) readersEntered.resolve();
        await release;
        activeReaders--;
      });
    const first = reader(releaseFirst.promise);
    const second = reader(releaseSecond.promise);
    await readersEntered.promise;
    const writer = lock.withWrite(async () => {
      expect(activeReaders).toBe(0);
      writerEntered.resolve();
      await releaseWriter.promise;
    });

    expect(await settlesNextTurn(writerEntered.promise)).toBe(false);
    releaseFirst.resolve();
    await first;
    expect(await settlesNextTurn(writerEntered.promise)).toBe(false);
    releaseSecond.resolve();
    await writerEntered.promise;
    const lateReader = lock.withRead(async () => {
      lateReaderEntered.resolve();
    });
    expect(await settlesNextTurn(lateReaderEntered.promise)).toBe(false);
    releaseWriter.resolve();
    await Promise.all([first, second, writer, lateReader]);
    await expect(lock.withWrite(async () => 'available')).resolves.toBe('available');
    await expect(lock.withRead(async () => 'available')).resolves.toBe('available');
  });

  test('releases read and write ownership after a rejected operation', async () => {
    const lock = new AsyncReadWriteLock();
    const failure = new Error('operation failed');
    await expect(lock.withRead(async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(lock.withWrite(async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(lock.withRead(async () => 'available')).resolves.toBe('available');
  });
});

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settlesNextTurn(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
}
