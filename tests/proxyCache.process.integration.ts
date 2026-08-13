import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createProxyCache } from '../src';

const workerPath = path.join(import.meta.dir, 'fixtures', 'cross-process-cache-worker.ts');
const nodeReaderPath = path.join(import.meta.dir, 'fixtures', 'cross-runtime-cache-reader.cjs');

describe('cross-process cache sharing', () => {
  test('a CLI-style warm in one process primes requests in another', async () => {
    const workers: ManagedProcess<unknown>[] = [];
    let originRequests = 0;
    const server = http.createServer((_request, response) => {
      originRequests++;
      response.setHeader('cache-control', 'max-age=3600');
      response.end('shared-body');
    });
    const origin = await listen(server);
    const cachePath = tempCachePath();
    const url = `${origin}/asset`;
    try {
      const warm = await runWorker(workers, 'warm', cachePath, url);
      const nodeRead = await runNodeReader(workers, cachePath, url);
      const request = await runWorker(workers, 'request', cachePath, url);

      expect(warm).toMatchObject({ operation: 'warm', stats: { failures: 0, hits: 0, misses: 1, total: 1 } });
      expect(nodeRead).toEqual({ body: 'shared-body', entryCount: 1 });
      expect(request).toMatchObject({
        body: 'shared-body',
        cacheStatus: 'HIT',
        operation: 'request',
        statusCode: 200,
      });
      expect(originRequests).toBe(1);
    } finally {
      await stopWorkers(workers);
      await clearCache(cachePath);
      server.closeAllConnections();
      await close(server);
    }
  }, 90_000);

  test('overlapping cold writers leave a reusable entry', async () => {
    const workers: ManagedProcess<unknown>[] = [];
    let originRequests = 0;
    const bothRequestsStarted = deferred<void>();
    const releaseResponses = deferred<void>();
    const server = http.createServer(async (_request, response) => {
      originRequests++;
      if (originRequests === 2) bothRequestsStarted.resolve();
      await releaseResponses.promise;
      response.setHeader('cache-control', 'max-age=3600');
      response.end('concurrent-body');
    });
    const origin = await listen(server);
    const cachePath = tempCachePath();
    const url = `${origin}/asset`;
    try {
      const first = runWorker(workers, 'request', cachePath, url);
      const second = runWorker(workers, 'request', cachePath, url);
      await withTimeout(bothRequestsStarted.promise, 15_000, 'both origin requests did not start');
      releaseResponses.resolve();

      const responses = await Promise.all([first, second]);
      expect(responses).toHaveLength(2);
      for (const response of responses) {
        expect(response).toMatchObject({ body: 'concurrent-body', cacheStatus: 'MISS', statusCode: 200 });
      }
      expect(originRequests).toBe(2);

      const reuse = await runWorker(workers, 'request', cachePath, url);
      expect(reuse).toMatchObject({ body: 'concurrent-body', cacheStatus: 'HIT', statusCode: 200 });
      expect(originRequests).toBe(2);
    } finally {
      releaseResponses.resolve();
      await stopWorkers(workers);
      await clearCache(cachePath);
      server.closeAllConnections();
      await close(server);
    }
  }, 90_000);

  test('a process killed during a write does not poison a later request', async () => {
    const workers: ManagedProcess<unknown>[] = [];
    let originRequests = 0;
    const partialResponseStarted = deferred<void>();
    const server = http.createServer((_request, response) => {
      originRequests++;
      response.setHeader('cache-control', 'max-age=3600');
      if (originRequests === 1) {
        response.write('partial-');
        partialResponseStarted.resolve();
        return;
      }
      response.end('complete-body');
    });
    const origin = await listen(server);
    const cachePath = tempCachePath();
    const url = `${origin}/asset`;
    const interrupted = spawnWorker('request', cachePath, url);
    workers.push(interrupted);
    const interruptedResult = interrupted.completed.then(
      () => undefined,
      (error: unknown) => error
    );
    try {
      await withTimeout(partialResponseStarted.promise, 15_000, 'partial response did not start');
      expect(await waitForTemporaryWrite(cachePath, 15_000)).toBeGreaterThan(0);
      interrupted.process.kill();
      expect(await interruptedResult).toBeInstanceOf(Error);
      await expect(createProxyCache(baseOptions(cachePath)).ls()).resolves.toEqual({});

      const retry = await runWorker(workers, 'request', cachePath, url);
      const reuse = await runWorker(workers, 'request', cachePath, url);
      expect(retry).toMatchObject({ body: 'complete-body', cacheStatus: 'MISS', statusCode: 200 });
      expect(reuse).toMatchObject({ body: 'complete-body', cacheStatus: 'HIT', statusCode: 200 });
      expect(originRequests).toBe(2);

      const cache = createProxyCache(baseOptions(cachePath));
      await expect(cache.prune()).resolves.toMatchObject({ totalEntries: 1 });
    } finally {
      await stopWorkers(workers);
      await clearCache(cachePath);
      server.closeAllConnections();
      await close(server);
    }
  }, 90_000);
});

type WorkerOperation = 'request' | 'warm';
type ManagedProcess<T> = {
  completed: Promise<T>;
  process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
};
type WorkerResult = {
  body?: string;
  cacheStatus?: string;
  operation: WorkerOperation;
  stats?: { failures: number; hits: number; misses: number; total: number };
  statusCode?: number;
};

function spawnWorker(operation: WorkerOperation, cachePath: string, originUrl: string) {
  const subprocess = Bun.spawn([process.execPath, workerPath, operation, cachePath, originUrl], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = new Response(subprocess.stdout).text();
  const stderr = new Response(subprocess.stderr).text();
  const completed = Promise.all([subprocess.exited, stdout, stderr]).then(([exitCode, output, errorOutput]) => {
    if (exitCode !== 0) throw new Error(`cache worker exited ${exitCode}: ${errorOutput.trim()}`);
    const lastLine = output.trim().split('\n').at(-1);
    if (!lastLine) throw new Error('cache worker produced no result');
    return JSON.parse(lastLine) as WorkerResult;
  });
  void completed.catch(() => {});
  return { completed, process: subprocess };
}

async function runWorker(
  workers: ManagedProcess<unknown>[],
  operation: WorkerOperation,
  cachePath: string,
  originUrl: string
): Promise<WorkerResult> {
  const worker = spawnWorker(operation, cachePath, originUrl);
  workers.push(worker);
  return waitForWorker(worker, `cache ${operation} worker`, 20_000);
}

async function runNodeReader(
  workers: ManagedProcess<unknown>[],
  cachePath: string,
  originUrl: string
): Promise<{ body: string; entryCount: number }> {
  const nodePath = Bun.which('node');
  if (!nodePath) throw new Error('node executable not found');
  const subprocess = Bun.spawn([nodePath, nodeReaderPath, cachePath, originUrl], {
    cwd: import.meta.dir,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stdout = new Response(subprocess.stdout).text();
  const stderr = new Response(subprocess.stderr).text();
  const completed = Promise.all([subprocess.exited, stdout, stderr]).then(([exitCode, output, errorOutput]) => {
    if (exitCode !== 0) throw new Error(`Node cache reader exited ${exitCode}: ${errorOutput.trim()}`);
    return JSON.parse(output) as { body: string; entryCount: number };
  });
  void completed.catch(() => {});
  const worker = { completed, process: subprocess };
  workers.push(worker);
  return waitForWorker(worker, 'Node cache reader', 20_000);
}

async function waitForWorker<T>(worker: ManagedProcess<T>, label: string, milliseconds: number): Promise<T> {
  try {
    return await withTimeout(worker.completed, milliseconds, `${label} did not exit`);
  } catch (error) {
    if (worker.process.exitCode === null) worker.process.kill();
    await Promise.allSettled([worker.completed]);
    throw error;
  }
}

async function stopWorkers(workers: ManagedProcess<unknown>[]): Promise<void> {
  for (const worker of workers) {
    if (worker.process.exitCode === null) worker.process.kill();
  }
  await withTimeout(Promise.allSettled(workers.map((worker) => worker.completed)), 5_000, 'workers did not exit');
}

function baseOptions(cachePath: string) {
  return {
    cachePath,
    cacheSeeds: [],
    proxyPrefix: '/cache',
    shouldProxyPath: () => true,
  };
}

async function clearCache(cachePath: string): Promise<void> {
  await createProxyCache(baseOptions(cachePath)).clear();
  await rm(cachePath, { force: true, recursive: true });
}

function tempCachePath(): string {
  return path.join(os.tmpdir(), `cdn-proxy-cache-process-${randomUUID()}`);
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForTemporaryWrite(cachePath: string, milliseconds: number): Promise<number> {
  const deadline = Date.now() + milliseconds;
  const temporaryDirectory = path.join(cachePath, 'tmp');
  while (Date.now() < deadline) {
    const names = await readdir(temporaryDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names) {
      const file = await stat(path.join(temporaryDirectory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (file?.isFile() && file.size > 0) return file.size;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('cache temporary write did not receive the partial body');
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
