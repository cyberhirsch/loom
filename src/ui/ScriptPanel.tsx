import { useEffect, useState } from 'react';
import { useLoomStore } from '../graph/store';
import type { ScriptError } from '../script/loomscript';
import { openLoomFile, saveLoomFile } from '../io/fileIO';

/** LoomScript panel: the live patch as text (docs/LOOMSCRIPT.md) — view it,
 *  edit it (or let an LLM edit it), apply it back, save/load .loom files. */
export function ScriptPanel({ onClose }: { onClose: () => void }) {
  const scriptText = useLoomStore((s) => s.scriptText);
  const applyScript = useLoomStore((s) => s.applyScript);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<ScriptError[]>([]);
  const [status, setStatus] = useState('');

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

  const saveFile = async () => {
    const result = await saveLoomFile(text);
    if (result === 'saved') {
      setStatus('saved ✓');
      setTimeout(() => setStatus(''), 1600);
    }
  };

  const loadFile = async () => {
    const picked = await openLoomFile();
    if (!picked) return;
    setText(picked.text);
    const errs = applyScript(picked.text);
    setErrors(errs ?? []);
    setStatus(errs ? '' : `loaded ${picked.name} ✓`);
    if (!errs) setTimeout(() => setStatus(''), 1600);
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
        <button className="play-btn" onClick={() => void saveFile()} title="Save as a .loom file">↧ .loom</button>
        <button className="play-btn" onClick={() => void loadFile()} title="Load a .loom file and apply it">↥ load</button>
      </div>
    </div>
  );
}
