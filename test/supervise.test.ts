import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
import { startInBackground } from '../src/supervise.js';

const quiet = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const log = {
    lines,
    debug: () => undefined,
    info: (m: string) => void lines.push(`info ${m}`),
    warn: (m: string) => void lines.push(`warn ${m}`),
    error: (m: string) => void lines.push(`error ${m}`),
    child: () => log,
  };
  return log;
};

class Permanent extends Error {}

describe('startInBackground', () => {
  it('starts once and keeps the handle for stop()', async () => {
    const stop = vi.fn(() => Promise.resolve());
    const start = vi.fn(() => Promise.resolve({ stop }));
    const handle = startInBackground({
      name: 'X',
      start,
      isPermanent: () => false,
      onPermanent: () => undefined,
      retryMs: 10,
      log: quiet(),
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await handle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('retries a passing failure until it works, without calling onPermanent', async () => {
    const log = quiet();
    const onPermanent = vi.fn();
    const start = vi
      .fn<() => Promise<{ stop(): Promise<void> }>>()
      .mockRejectedValueOnce(new Error('gateway unreachable'))
      .mockRejectedValueOnce(new Error('gateway unreachable'))
      .mockResolvedValue({ stop: () => Promise.resolve() });
    startInBackground({ name: 'X', start, isPermanent: () => false, onPermanent, retryMs: 15, log });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 80));
    expect(start).toHaveBeenCalledTimes(3); // working now: no more attempts
    expect(onPermanent).not.toHaveBeenCalled();
    expect(log.lines.filter((l) => l.startsWith('warn'))).toHaveLength(2);
  });

  it('gives up and reports once on a failure that retrying cannot fix', async () => {
    const onPermanent = vi.fn();
    const start = vi.fn(() => Promise.reject(new Permanent('token refused')));
    startInBackground({
      name: 'X',
      start,
      isPermanent: (e) => e instanceof Permanent,
      onPermanent,
      retryMs: 10,
      log: quiet(),
    });
    await vi.waitFor(() => expect(onPermanent).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(start).toHaveBeenCalledTimes(1);
    expect(onPermanent).toHaveBeenCalledTimes(1);
    expect((onPermanent.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Permanent);
  });

  it('stop() ends the retrying', async () => {
    const start = vi.fn(() => Promise.reject(new Error('down')));
    const handle = startInBackground({ name: 'X', start, isPermanent: () => false, onPermanent: () => undefined, retryMs: 10, log: quiet() });
    await vi.waitFor(() => expect(start.mock.calls.length).toBeGreaterThanOrEqual(2));
    await handle.stop();
    await new Promise((r) => setTimeout(r, 30));
    const calls = start.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(start).toHaveBeenCalledTimes(calls);
  });

  it('stops an attempt that finishes after stop() was called', async () => {
    let finish: (a: { stop(): Promise<void> }) => void = () => undefined;
    const stop = vi.fn(() => Promise.resolve());
    const start = vi.fn(() => new Promise<{ stop(): Promise<void> }>((resolve) => (finish = resolve)));
    const handle = startInBackground({ name: 'X', start, isPermanent: () => false, onPermanent: () => undefined, retryMs: 10, log: quiet() });
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await handle.stop();
    finish({ stop });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});
