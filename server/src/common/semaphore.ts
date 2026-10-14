/**
 * 极简并发闸门：超过 limit 的请求在本地排队，不报错。
 * 只用于限制「同时打向上游的请求数」（设置项 limits.concurrency）。
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get queued(): number {
    return this.waiting.length;
  }

  /** 返回排队耗时（毫秒）；未排队时为 0。 */
  async acquire(): Promise<{ queuedMs: number }> {
    if (this.active < this.limit) {
      this.active += 1;
      return { queuedMs: 0 };
    }
    const started = Date.now();
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    return { queuedMs: Date.now() - started };
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}
