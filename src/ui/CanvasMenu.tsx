import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useLoomStore } from '../graph/store';
import { NODE_CATALOG } from '../graph/catalog';

export interface CanvasMenuState {
  x: number; // screen coords of the right-click
  y: number;
  nodeId?: string; // set when a node (not the pane) was right-clicked
}

/** Canvas right-click menu: one flyout submenu per node category, plus
 *  copy / cut / paste / delete acting on the clicked node or the selection. */
export function CanvasMenu({ menu, onClose }: { menu: CanvasMenuState; onClose: () => void }) {
  const { screenToFlowPosition } = useReactFlow();
  const nodes = useLoomStore((s) => s.nodes);
  const addNode = useLoomStore((s) => s.addNode);
  const copySelection = useLoomStore((s) => s.copySelection);
  const cutSelection = useLoomStore((s) => s.cutSelection);
  const deleteSelection = useLoomStore((s) => s.deleteSelection);
  const pasteClipboard = useLoomStore((s) => s.pasteClipboard);
  const hasClipboard = useLoomStore((s) => Boolean(s.clipboard?.nodes.length));
  const [openCat, setOpenCat] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const hasTarget = Boolean(menu.nodeId) || nodes.some((n) => n.selected);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const flowPoint = () => screenToFlowPosition({ x: menu.x, y: menu.y });
  const run = (action: () => void) => {
    action();
    onClose();
  };

  // keep the panel (and its flyouts) on screen
  const style = {
    left: Math.min(menu.x, window.innerWidth - 230),
    top: Math.min(menu.y, window.innerHeight - 280),
  };
  const flyLeft = style.left + 420 > window.innerWidth;

  return (
    <div className="ctx-menu" style={style} ref={ref} onContextMenu={(e) => e.preventDefault()}>
      {NODE_CATALOG.map((cat) => (
        <div
          key={cat.id}
          className="menu-cat-row"
          onMouseEnter={() => setOpenCat(cat.id)}
          onMouseLeave={() => setOpenCat(null)}
        >
          <button
            className={`menu-item${openCat === cat.id ? ' is-open' : ''}`}
            onClick={() => setOpenCat(openCat === cat.id ? null : cat.id)}
          >
            <span className={`menu-icon menu-icon--${cat.id}`}>▪</span>
            add {cat.label}
            <span className="menu-caret-r">▸</span>
          </button>
          {openCat === cat.id && (
            <div className={`menu-sub${flyLeft ? ' menu-sub--left' : ''}`}>
              {cat.items.map((item) => {
                const inPatch = Boolean(item.singleton) && nodes.some((n) => n.type === item.type);
                return (
                  <button
                    key={item.type}
                    className="menu-item"
                    disabled={inPatch}
                    title={item.hint}
                    onClick={() => run(() => addNode(item.type, flowPoint()))}
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
      <div className="menu-sep" />
      <button className="menu-item" disabled={!hasTarget} onClick={() => run(() => copySelection(menu.nodeId))}>
        copy
      </button>
      <button className="menu-item" disabled={!hasTarget} onClick={() => run(() => cutSelection(menu.nodeId))}>
        cut
      </button>
      <button className="menu-item" disabled={!hasClipboard} onClick={() => run(() => pasteClipboard(flowPoint()))}>
        paste
      </button>
      <button className="menu-item" disabled={!hasTarget} onClick={() => run(() => deleteSelection(menu.nodeId))}>
        delete
      </button>
    </div>
  );
}
