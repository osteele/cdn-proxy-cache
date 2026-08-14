type Waiter = {
  kind: 'read' | 'write';
  resolve: () => void;
};

/** A writer-preferring lock for coordinating cache access within this process. */
export class AsyncReadWriteLock {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly waiters: Waiter[] = [];

  async withRead<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire('read');
    try {
      return await operation();
    } finally {
      this.activeReaders--;
      this.drain();
    }
  }

  async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire('write');
    try {
      return await operation();
    } finally {
      this.activeWriter = false;
      this.drain();
    }
  }

  private acquire(kind: Waiter['kind']): Promise<void> {
    const writerWaiting = this.waiters.some((waiter) => waiter.kind === 'write');
    if (kind === 'read' && !this.activeWriter && !writerWaiting) {
      this.activeReaders++;
      return Promise.resolve();
    }
    if (kind === 'write' && !this.activeWriter && this.activeReaders === 0 && this.waiters.length === 0) {
      this.activeWriter = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ kind, resolve }));
  }

  private drain(): void {
    if (this.activeWriter || this.activeReaders > 0 || this.waiters.length === 0) return;
    const first = this.waiters[0];
    if (first.kind === 'write') {
      this.waiters.shift();
      this.activeWriter = true;
      first.resolve();
      return;
    }
    while (this.waiters[0]?.kind === 'read') {
      const reader = this.waiters.shift();
      this.activeReaders++;
      reader?.resolve();
    }
  }
}
