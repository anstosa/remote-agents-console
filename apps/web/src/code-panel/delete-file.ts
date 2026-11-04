import { useEffect, useRef, useState } from 'react';
import type { FilesController } from '../files-panel/controller.js';
import type { PreparedOperation } from '../files-panel/contracts.js';
import { isPlaceRelativePath } from './editor-jump.js';

type DeleteSelection = { path: string; hostPath?: string; prepared?: PreparedOperation };
export type CodeFileDeletion = ReturnType<typeof useCodeFileDeletion>;

// prepare one exact working-tree object before requesting permanent deletion
export function useCodeFileDeletion(files: FilesController, onDeleted: () => void) {
  const [selection, setSelection] = useState<DeleteSelection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const generation = useRef(0);
  // revoke pending preparations when the owning split or place changes
  useEffect(() => {
    generation.current += 1;
    busyRef.current = false;
    setSelection(undefined);
    setBusy(false);
    setError(undefined);
    return () => { generation.current += 1; };
  }, [files.placeId]);

  // resolve the place's canonical host home without changing Files navigation
  const prepare = async (path: string) => {
    // serialize reads and refuse paths outside the working tree
    if (busyRef.current || !isPlaceRelativePath(path) || path.includes('\0')) return;
    const scope = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setSelection({ path });
    try {
      const home = await files.directoryAt();
      // preserve sanitized directory failures
      if ('code' in home) throw new Error(home.message);
      const root = home.path.replace(/\/$/u, '');
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? home : await files.directoryAt(`${root}/${path.slice(0, slash)}`);
      // preserve inaccessible parent failures
      if ('code' in parent) throw new Error(parent.message);
      // a symlinked parent must not turn a code action into an outside-home deletion
      if (parent.path !== home.path && !parent.path.startsWith(`${root}/`)) throw new Error('This file resolves outside the working tree and cannot be deleted here.');
      const hostPath = `${parent.path.replace(/\/$/u, '')}/${path.slice(slash + 1)}`;
      const entry = parent.entries.find(candidate => candidate.hostPath === hostPath && candidate.name === path.slice(slash + 1));
      // never guess a missing token or delete a replacement directory
      if (entry === undefined || entry.kind !== 'file' && entry.kind !== 'symlink') throw new Error('The file is unavailable or is no longer a file. Refresh and try again.');
      // a closed or replaced split cannot publish a new confirmation
      if (generation.current !== scope) return;
      const prepared = await files.prepare({ kind: 'delete', sourceTokens: [entry.objectToken] });
      // require exactly one identity-bound delete manifest
      if (!('operationId' in prepared)) throw new Error(prepared.message);
      // reject an unexpected manifest before allowing confirmation
      if (prepared.kind !== 'delete' || prepared.totalItems !== 1 || prepared.conflicts.length !== 0) throw new Error('The delete confirmation was invalid. Refresh and try again.');
      // retain only the current split's prepared capability
      if (generation.current === scope) setSelection({ path, hostPath, prepared });
    } catch (failure) {
      // keep preparation failures visible without granting delete authority
      if (generation.current === scope) setError(failure instanceof Error ? failure.message : 'Unable to prepare file deletion.');
    } finally {
      // stale reads cannot unlock a newer operation
      if (generation.current === scope) { busyRef.current = false; setBusy(false); }
    }
  };

  // execute only the manifest the operator explicitly confirmed
  const confirm = async () => {
    const prepared = selection?.prepared;
    // prevent duplicate or unprepared execution
    if (busyRef.current || prepared === undefined) return;
    const scope = generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    // an ambiguous mutation must never be retried from this confirmation
    setSelection(current => current === undefined ? current : { ...current, prepared: undefined });
    try {
      const result = await files.execute(prepared, {}, true);
      // a departed split no longer owns result presentation
      if (generation.current !== scope) return;
      // expose rejected or stale object capabilities
      if (!('state' in result)) throw new Error(result.message);
      // report success only when this one object was actually deleted
      if (result.state !== 'completed' || result.results.length !== 1 || result.results[0]?.outcome !== 'deleted') throw new Error(result.results.find(item => item.message)?.message ?? 'The file was not deleted. Refresh Files to check the result.');
      setSelection(undefined);
      onDeleted();
    } catch (failure) {
      // keep the failure visible without replaying a possibly completed mutation
      if (generation.current === scope) setError(failure instanceof Error ? failure.message : 'Unable to delete this file. Refresh Files to check the result.');
    } finally {
      // only the active mutation may release its controls
      if (generation.current === scope) { busyRef.current = false; setBusy(false); }
    }
  };

  // leave files untouched when confirmation is canceled
  const cancel = () => {
    // retain a mutation already submitted to the server
    if (busyRef.current) return;
    setSelection(undefined);
    setError(undefined);
  };
  return { selection, busy, error, prepare, confirm, cancel };
}
