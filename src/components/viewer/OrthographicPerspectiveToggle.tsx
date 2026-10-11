import OrthographicCube from '@/components/viewer/OrthographicCube';
import PerspectiveCube from '@/components/viewer/PerspectiveCube';

interface OrthographicPerspectiveToggleProps {
  isOrthographic: boolean;
  onToggle: (value: boolean) => void;
}

export function OrthographicPerspectiveToggle({
  isOrthographic,
  onToggle,
}: OrthographicPerspectiveToggleProps) {
  return (
    <div
      className="iris-viewer-projection"
      role="group"
      aria-label="Camera projection"
    >
      <button
        type="button"
        className="iris-viewer-tool"
        data-active={isOrthographic}
        aria-label="Orthographic view"
        aria-pressed={isOrthographic}
        onClick={() => onToggle(true)}
      >
        <OrthographicCube aria-hidden="true" />
      </button>
      <button
        type="button"
        className="iris-viewer-tool"
        data-active={!isOrthographic}
        aria-label="Perspective view"
        aria-pressed={!isOrthographic}
        onClick={() => onToggle(false)}
      >
        <PerspectiveCube aria-hidden="true" />
      </button>
    </div>
  );
}
