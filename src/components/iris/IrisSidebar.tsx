import type { ReactNode } from 'react';

export type IrisSidebarProps = {
  primaryActionSlot?: ReactNode;
  historySlot?: ReactNode;
  accountSlot?: ReactNode;
};

export function IrisSidebar({
  primaryActionSlot,
  historySlot,
  accountSlot,
}: IrisSidebarProps) {
  return (
    <aside className="iris-sidebar" aria-label="Creation controls">
      <div className="iris-sidebar__primary">{primaryActionSlot}</div>
      <div className="iris-sidebar__history">{historySlot}</div>
      <div className="iris-sidebar__account">{accountSlot}</div>
    </aside>
  );
}
