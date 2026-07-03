/**
 * Text file save/load for LoomScript patches. Uses the File System Access API
 * (real "Save"/"Open" dialogs, re-savable to the same file) where the browser
 * supports it (Chromium); falls back to anchor-download + a hidden file input
 * elsewhere (Firefox, Safari). Feature-detected once at module load.
 */

const LOOM_TYPES = [{ description: 'LoomScript', accept: { 'text/plain': ['.loom'] } }];

export const supportsFileSystemAccess = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

/** the last handle a user picked, so repeated saves overwrite the same file */
let handle: FileSystemFileHandle | null = null;

export type SaveResult = 'saved' | 'cancelled' | 'unsupported';

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function downloadFallback(text: string, suggestedName: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Save via a native picker when available; downloads the file otherwise. */
export async function saveLoomFile(text: string, suggestedName = 'patch.loom'): Promise<SaveResult> {
  if (supportsFileSystemAccess) {
    try {
      const h = handle ?? (await window.showSaveFilePicker!({ suggestedName, types: LOOM_TYPES }));
      handle = h;
      const writable = await h.createWritable();
      await writable.write(text);
      await writable.close();
      return 'saved';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
      console.error('[loom] File System Access save failed, falling back to download', err);
    }
  }
  downloadFallback(text, suggestedName);
  return 'saved';
}

function openFallback(): Promise<{ text: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.loom,.txt';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      void f.text().then((text) => resolve({ text, name: f.name }));
    };
    // no 'cancel' event cross-browser — resolves null only if a file was chosen
    input.click();
  });
}

/** Open via a native picker when available; an <input type=file> otherwise. */
export async function openLoomFile(): Promise<{ text: string; name: string } | null> {
  if (supportsFileSystemAccess) {
    try {
      const [h] = await window.showOpenFilePicker!({ types: LOOM_TYPES, multiple: false });
      handle = h;
      const file = await h.getFile();
      return { text: await file.text(), name: file.name };
    } catch (err) {
      if (isAbort(err)) return null;
      console.error('[loom] File System Access open failed, falling back to file input', err);
    }
  }
  return openFallback();
}

/** Forget the remembered file handle (e.g. after loading a fresh/default patch). */
export function forgetFileHandle() {
  handle = null;
}
