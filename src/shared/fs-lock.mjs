import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Publish a unique ticket before looking for other contenders. Two simultaneous
// callers can both decline, but neither can enter while the other holds a ticket.
// A dead process's unique ticket can be removed without unlinking a new owner's.
export function acquireTicketLock(lockDir, busyCode, busyMessage) {
  mkdirSync(lockDir, { recursive: true });
  const name = `${process.pid}-${randomUUID()}`;
  const ticket = join(lockDir, name);
  writeFileSync(ticket, '', { flag: 'wx' });
  const release = () => {
    rmSync(ticket, { force: true });
  };
  try {
    for (const other of readdirSync(lockDir)) {
      if (other === name) continue;
      const pid = Number(other.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const otherTicket = join(lockDir, other);
      let alive = true;
      try { process.kill(pid, 0); }
      catch (err) { alive = err.code !== 'ESRCH'; }
      if (alive) throw Object.assign(new Error(busyMessage), { code: busyCode });
      rmSync(otherTicket, { force: true });
    }
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const LOCK_RETRY_DELAYS_MS = [30, 80, 150];
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  }
}

/**
 * Retries a synchronous filesystem operation on transient Windows lock errors (`EBUSY`/`EPERM`/`EACCES`).
 */
export function withLockRetrySync(fn, retryDelays = LOCK_RETRY_DELAYS_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!LOCK_ERROR_CODES.has(err?.code) || attempt >= retryDelays.length) {
        throw err;
      }
      sleepSync(retryDelays[attempt]);
    }
  }
  throw lastErr;
}
