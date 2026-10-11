import type { ReactNode } from 'react';

export type PreviewHeaderProps = {
  titleSlot?: ReactNode;
  actionSlot?: ReactNode;
};

export function PreviewHeader({ titleSlot, actionSlot }: PreviewHeaderProps) {
  if (!titleSlot && !actionSlot) return null;

  return (
    <header className="iris-preview-header">
      <div className="iris-preview-header__title">{titleSlot}</div>
      <div className="iris-preview-header__action">{actionSlot}</div>
    </header>
  );
}

export function CadViewportSlot({ children }: { children: ReactNode }) {
  return <div className="iris-cad-viewport">{children}</div>;
}

export function PreviewToolbar({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div className="iris-preview-toolbar">{children}</div>;
}

export type CadWorkspaceProps = {
  previewSlot: ReactNode;
  titleSlot?: ReactNode;
  actionSlot?: ReactNode;
  toolbarSlot?: ReactNode;
  mobileControlsSlot?: ReactNode;
  topLeftControlSlot?: ReactNode;
};

export function CadWorkspace({
  previewSlot,
  titleSlot,
  actionSlot,
  toolbarSlot,
  mobileControlsSlot,
  topLeftControlSlot,
}: CadWorkspaceProps) {
  return (
    <main className="iris-workspace" aria-label="CAD workspace">
      {topLeftControlSlot}
      <PreviewHeader titleSlot={titleSlot} actionSlot={actionSlot} />
      <CadViewportSlot>{previewSlot}</CadViewportSlot>
      <PreviewToolbar>{toolbarSlot}</PreviewToolbar>
      {mobileControlsSlot}
    </main>
  );
}
