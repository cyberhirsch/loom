import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useLoomStore } from '../graph/store';
import { NODE_CATALOG } from '../graph/catalog';

/** Top-bar node creation: one dropdown per category — every node in the
 *  catalog is creatable here. Singletons already in the patch are greyed out. */
export function AddNodeMenu() {
  const [open, setOpen] = useState<string | null>(null);
  const nodes = useLoomStore((s) => s.nodes);
  const addNode = useLoomStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // drop new nodes near the middle of the current view, slightly scattered
  const dropPosition = () =>
    screenToFlowPosition({
      x: window.innerWidth * 0.42 + Math.random() * 80,
      y: window.innerHeight * 0.42 + Math.random() * 80,
    });

  return (
    <div className="add-menus" ref={ref}>
      {NODE_CATALOG.map((cat) => (
        <div key={cat.id} className="add-menu">
          <button
            className={`play-btn${open === cat.id ? ' on' : ''}`}
            onClick={() => setOpen(open === cat.id ? null : cat.id)}
            title={`Add a ${cat.label} node`}
          >
            + {cat.label} <span className="menu-caret">▾</span>
          </button>
          {open === cat.id && (
            <div className="menu-pop">
              {cat.items.map((item) => {
                const inPatch = Boolean(item.singleton) && nodes.some((n) => n.type === item.type);
                return (
                  <button
                    key={item.type}
                    className="menu-item"
                    disabled={inPatch}
                    title={item.hint}
                    onClick={() => {
                      addNode(item.type, dropPosition());
                      setOpen(null);
                    }}
                  >
                    <span className={`menu-icon menu-icon--${cat.id}`}>{item.icon}</span>
                    {item.label}
                    {inPatch && <span className="menu-note">in patch</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
