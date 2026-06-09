// The single app-level right-click menu. Driven by useContextMenuStore: any
// surface calls openMenu(x, y, items); this renders the list at that point,
// clamped to stay on-screen, and dismisses on outside-click / Escape / scroll.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextMenuStore } from "../state/contextMenuStore";

export function ContextMenu() {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const closeMenu = useContextMenuStore((s) => s.closeMenu);

  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Re-clamp whenever the menu opens at a new point or its items change. Start at
  // the click point, then flip back inside the viewport if it would overflow.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    let left = x;
    let top = y;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      const margin = 4;
      if (left + width > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - width - margin);
      }
      if (top + height > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - height - margin);
      }
    }
    setPos({ left, top });
  }, [open, x, y, items]);

  // Dismiss on Escape, on any scroll (the menu is anchored to a point that would
  // drift), and on window resize. Document-level because the menu div isn't
  // focused, so a local onKeyDown would never fire.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeMenu, { capture: true });
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeMenu, { capture: true });
      window.removeEventListener("resize", closeMenu);
    };
  }, [open, closeMenu]);

  if (!open) return null;

  return (
    <div
      className="context-menu-overlay"
      // Mouse-down (not click) so the menu dismisses before any underlying
      // handler runs; right-click elsewhere also closes it.
      onMouseDown={closeMenu}
      onContextMenu={(e) => {
        e.preventDefault();
        closeMenu();
      }}
    >
      <div
        ref={menuRef}
        className="context-menu"
        role="menu"
        style={{ left: pos.left, top: pos.top }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <button
            key={`${item.label}-${i}`}
            type="button"
            role="menuitem"
            className={
              "context-menu-item" +
              (item.disabled ? " disabled" : "") +
              (item.separatorBefore ? " separator-before" : "")
            }
            disabled={item.disabled}
            // Run on click; the overlay's mousedown already closed sibling menus.
            onClick={() => {
              closeMenu();
              item.run();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
