# Link ERP interface patterns

The interface deliberately uses compact, high-contrast controls familiar to
mill-floor and accounts operators. New components must reuse the existing
slate/blue status palette, `erp-btn` controls, 44px touch targets, and visible
keyboard focus rather than introducing a separate visual language.

## Workspace tabs

`WorkspaceTabs` keeps up to eight ERP screens mounted at once. Use it for
primary modules only—not dialogs or print previews. Selecting a tab changes the
URL hash, closing the active tab activates its nearest neighbour, and closing
the last tab is refused so the application never has an empty workspace.

- **Active:** white surface, blue text, `aria-selected=true`, keyboard tab stop.
- **Inactive:** slate surface and excluded from the normal tab order.
- **Keyboard:** Left and Right Arrow cycle between open workspaces.
- **Touch:** tab and close controls are at least 44px high and wide.
- **State:** inactive panels remain mounted so unsaved scans and form entries
  survive comparison with another document. No draft is written to storage.

## Server-state reads

Read-only API responses use a 30-second in-memory stale-while-revalidate cache.
Concurrent identical reads share one request, focus/online events refresh open
screens, and every successful financial write clears the cache. Accounting
writes are never optimistic: the UI reports success only after the server has
committed the transaction.
