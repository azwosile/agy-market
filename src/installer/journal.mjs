// Crash-Recovery Journal (`pending-journal.json`) for 8s Boot Recovery (`src/installer/journal.mjs`).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDisabledPluginsDir } from '../shared/paths.mjs';
import { syncDirectoryLockSafe } from './sync-dir.mjs';

export function getJournalPath(dataDir) {
  return join(dataDir, 'pending-journal.json');
}

export function writePendingJournal(dataDir, record) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(getJournalPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function clearPendingJournal(dataDir) {
  rmSync(getJournalPath(dataDir), { force: true });
}

/**
 * Invoked 8s after Sidecar boot to complete or roll back any install/update interrupted by power loss or IDE exit.
 */
export function recoverInterruptedJournal({ dataDir, pluginsDir }) {
  const journalPath = getJournalPath(dataDir);
  if (!existsSync(journalPath)) {
    return { recovered: false, action: 'none' };
  }

  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    clearPendingJournal(dataDir);
    return { recovered: false, action: 'corrupt-cleared' };
  }

  const targetRoot = journal.parkedByMarket ? resolveDisabledPluginsDir(dataDir) : pluginsDir;
  const targetPluginDir = join(targetRoot, String(journal.dir || ''));
  try {
    if (journal.stagingBundleDir && existsSync(join(journal.stagingBundleDir, 'plugin.json'))) {
      syncDirectoryLockSafe({
        stagingBundleDir: journal.stagingBundleDir,
        targetPluginDir,
        dataDir,
        preservePaths: journal.preservePaths || [],
      });
      if (journal.receipt) {
        writeFileSync(
          join(targetPluginDir, '.agy-market-receipt.json'),
          `${JSON.stringify(journal.receipt, null, 2)}\n`,
          'utf8',
        );
      }
      if (journal.stagingRootDir) {
        rmSync(journal.stagingRootDir, { recursive: true, force: true });
      }
      clearPendingJournal(dataDir);
      return { recovered: true, action: 'completed-forward', dir: journal.dir };
    }

    if (journal.backupDir && existsSync(join(journal.backupDir, 'plugin.json'))) {
      syncDirectoryLockSafe({
        stagingBundleDir: journal.backupDir,
        targetPluginDir,
        dataDir,
        preservePaths: journal.preservePaths || [],
      });
      rmSync(journal.backupDir, { recursive: true, force: true });
      clearPendingJournal(dataDir);
      return { recovered: true, action: 'rolled-back', dir: journal.dir };
    }
  } catch (err) {
    return { recovered: false, action: 'error', error: err?.message || String(err) };
  }

  clearPendingJournal(dataDir);
  return { recovered: false, action: 'stale-cleared' };
}
