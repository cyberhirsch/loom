import { useEffect, useRef, useState } from 'react';
import { useLoomStore } from '../graph/store';
import type { ScriptError } from '../script/loomscript';

/** LoomScript panel: the live patch as text (docs/LOOMSCRIPT.md) — view it,
 *  edit it (or let an LLM edit it), apply it back, save/load .loom files. */
export function ScriptPanel({ onClose }: { onClose: () => void }) {
  const scriptText = useLoomStore((s) => s.scriptText);
  const applyScript = useLoomStore((s) => s.applyScript);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<ScriptError[]>([]);
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(scriptText());
  }, [scriptText]);

  const apply = () => {
    const errs = applyScript(text);
    if (errs) {
      setErrors(errs);
      setStatus('');
    } else {
      setErrors([]);
      setStatus('applied ✓');
      setTimeout(() => setStatus(''), 1600);
    }
  };

  const refresh = () => {
    setText(scriptText());
    setErrors([]);
    setStatus('refreshed from patch');
    setTimeout(() => setStatus(''), 1600);
  };

  const saveFile = () => {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'patch.loom';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadFile = (file: File) => {
    void file.text().then((content) => {
      setText(content);
      const errs = applyScript(content);
      setErrors(errs ?? []);
      setStatus(errs ? '' : `loaded ${file.name} ✓`);
      if (!errs) setTimeout(() => setStatus(''), 1600);
    });
  };

  return (
    <div className="script-panel">
      <header className="script-panel__header">
        <span className="loom-node__icon" style={{ color: 'var(--cat-io)' }}>⟨⟩</span>
        <span>LoomScript</span>
        <span className="script-status">{status}</span>
        <button className="node-btn" onClick={onClose}>✕</button>
      </header>
      <textarea
        className="script-editor nodrag"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {errors.length > 0 && (
        <div className="script-errors">
          {errors.map((e, i) => (
            <div key={i}>
              <b>{e.line > 0 ? `line ${e.line}: ` : ''}</b>
              {e.message}
            </div>
          ))}
        </div>
      )}
      <div className="script-panel__actions">
        <button className="play-btn" onClick={apply} title="Parse the script and replace the patch (takes effect next loop)">apply</button>
        <button className="play-btn" onClick={refresh} title="Re-generate the script from the current patch (discards edits)">refresh</button>
        <button className="play-btn" onClick={() => void navigator.clipboard.writeText(text)} title="Copy the script — paste it to any LLM">copy</button>
        <button className="play-btn" onClick={saveFile} title="Download as a .loom file">↧ .loom</button>
        <button className="play-btn" onClick={() => fileRef.current?.click()} title="Load a .loom file and apply it">↥ load</button>
        <input
          ref={fileRef}
          type="file"
          accept=".loom,.txt"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
