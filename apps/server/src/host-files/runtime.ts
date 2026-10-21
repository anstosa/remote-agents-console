import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ValidatedConfig } from '../config/schema.js';
import { tmuxBinary } from '../tmux/command.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import { createHostFilesBackend } from './broker.js';
import { createHostFilesEngine } from './engine.js';
import { HostFilesService } from './service.js';

// choose full host execution explicitly and never substitute container bind mounts
export function createRuntimeHostFiles(config: ValidatedConfig): HostFilesService {
  const checkout = serverCheckout();
  const hostCheckout = serverCheckoutOnHost(config.projects, process.env.RAC_HOST_WORKSPACE ?? process.env.RAC_HOST_REPOSITORY) ?? '';
  const bridged = existsSync('/.dockerenv') || process.env.RAC_HOST_PROC !== undefined || process.env.RAC_HOST_TMUX_DIR !== undefined;
  const journal = process.env.RAC_FILE_OPERATION_JOURNAL ?? join(checkout, '.data/file-operation-journal.json');
  const journalRelative = relative(checkout, journal);
  const favorites = process.env.RAC_FILE_FAVORITES_FILE ?? join(checkout, '.data/file-favorites.json');
  const favoritesRelative = relative(checkout, favorites);
  // map only checkout-owned favorite persistence to the host broker
  const hostFavorites = !isAbsolute(favoritesRelative) && favoritesRelative !== '..' && !favoritesRelative.startsWith('../') ? join(hostCheckout, favoritesRelative) : '';
  // map only checkout-owned persistent state into the host namespace
  const hostJournal = !isAbsolute(journalRelative) && journalRelative !== '..' && !journalRelative.startsWith('../')
    ? join(hostCheckout, journalRelative)
    : '';
  const backend = bridged ? createHostFilesBackend({
    tmuxBinary: tmuxBinary(),
    hostTmuxSocket: process.env.RAC_HOST_TMUX_DIR === undefined ? '' : join(process.env.RAC_HOST_TMUX_DIR, 'default'),
    hostProcRoot: process.env.RAC_HOST_PROC ?? '',
    serverCheckout: checkout,
    hostCheckout,
    hostNodeBin: process.env.RAC_HOST_NODE_BIN ?? '',
    hostPath: process.env.RAC_HOST_PATH,
    hostUid: Number(process.env.RAC_HOST_UID ?? 'NaN'),
    operationJournalPath: hostJournal,
    fileFavoritesPath: hostFavorites
  }) : createHostFilesEngine(undefined, { journalFile: journal, favoritesFile: favorites });
  return new HostFilesService({ backend, tokenSecret: process.env.RAC_SESSION_SECRET || randomBytes(32).toString('base64url') });
}
