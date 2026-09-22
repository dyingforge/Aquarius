/**
 * Minimal async mutex.
 *
 * Node runs JavaScript on one thread, but Git writes span multiple `await`
 * points, so two writers could still interleave. This serializes the critical
 * sections: the job queue handler and every direct user-initiated write share one
 * mutex, which is how "all Git writes go through a single writer" is enforced.
 */
export class AsyncMutex {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    this.#depth += 1;
    try {
      return await fn();
    } finally {
      this.#depth -= 1;
      release();
    }
  }

  get busy(): boolean {
    return this.#depth > 0;
  }
}
