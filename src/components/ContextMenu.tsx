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

  // Capture the element that had focus when the menu opened, and restore it on
  // close/unmount: the focused menu item unmounts, which would otherwise drop
  // focus to <body> and strand keyboard users. Declared before the
  // focus-first-item effect so the capture happens before focus moves.
  useEffect(() => {
    if (!open) return;
    const invoker =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      if (invoker?.isConnected) invoker.focus();
    };
  }, [open]);

  // Focus the first enabled item when the menu opens so keyboard users can
  // navigate immediately (Enter then activates the focused item natively).
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      ".context-menu-item:not(:disabled)",
    );
    first?.focus();
  }, [open, items]);

  // Roving focus: ArrowDown/ArrowUp move through enabled items with wrap;
  // Home/End jump to the first/last. Tab/Shift+Tab are trapped and behave like
  // the arrows, so focus can't escape the open menu to a background control
  // (which would leave the menu visible but un-navigable). Enter is the button's
  // native activation.
  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const focusable = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        ".context-menu-item:not(:disabled)",
      ),
    );
    if (focusable.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const current = focusable.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const forward =
      e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = focusable.length - 1;
    else if (forward)
      next = current < 0 ? 0 : (current + 1) % focusable.length;
    else
      next =
        current < 0
          ? focusable.length - 1
          : (current - 1 + focusable.length) % focusable.length;
    focusable[next].focus();
  }

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
        onKeyDown={onMenuKeyDown}
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
