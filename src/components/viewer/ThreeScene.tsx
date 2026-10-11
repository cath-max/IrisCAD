import { Canvas } from '@react-three/fiber';
import {
  OrbitControls,
  Stage,
  Environment,
  Bounds,
  OrthographicCamera,
  PerspectiveCamera,
  useBounds,
} from '@react-three/drei';
import * as THREE from 'three';
import { Maximize2 } from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { OrthographicPerspectiveToggle } from '@/components/viewer/OrthographicPerspectiveToggle';
import { ViewGizmo } from '@/components/viewer/ViewGizmo';
import { cn } from '@/lib/utils';
import {
  CAD_PREVIEW_MATERIAL,
  CAD_PREVIEW_TINT,
} from '@/utils/previewMaterial';
import { modelCenterOffset } from '@/utils/modelCenterOffset';

const DevOrbitGifExporter = import.meta.env.DEV
  ? lazy(() => import('./DevOrbitGifExporter'))
  : null;

interface ThreeSceneProps {
  geometry: THREE.BufferGeometry | null;
  color: string;
  filenameBase?: string;
  previewKey?: string;
  boundsRevision?: number;
  isMobile?: boolean;
  coloredGroup?: THREE.Group | null;
  coloredGroupVisible?: boolean;
  /**
   * When true, use geometry's `color` attribute (e.g. SimpleCADAPI render_mesh
   * tag colors). Defaults to auto-detect from `geometry.hasAttribute('color')`.
   */
  vertexColors?: boolean;
}

export function ThreeScene({
  geometry,
  color,
  filenameBase = 'parametric-model',
  previewKey,
  boundsRevision,
  isMobile = false,
  coloredGroup,
  coloredGroupVisible = true,
  vertexColors,
}: ThreeSceneProps) {
  const [isOrthographic, setIsOrthographic] = useState(true);
  const fitToViewRef = useRef<(() => void) | null>(null);
  const exportObjectRef = useRef<THREE.Object3D | null>(null);
  const setExportObject = useCallback((object: THREE.Object3D | null) => {
    exportObjectRef.current = object;
  }, []);

  // Store the initial isMobile value to prevent position changes during resize
  const [initialIsMobile] = useState(isMobile);

  const useVertexColors =
    vertexColors ?? !!(geometry && geometry.hasAttribute('color'));

  const setFitToView = useCallback((fitToView: (() => void) | null) => {
    fitToViewRef.current = fitToView;
  }, []);

  // Component meshes sit at their original CAD coordinates.
  // Offset so the combined bounds are centered at origin, mirroring the
  // STL path's geom.center() behavior.
  const groupCenterOffset = useMemo(() => {
    if (!coloredGroup) return null;
    return modelCenterOffset(coloredGroup);
    // Incremental assembly updates mutate the same Group in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coloredGroup, boundsRevision]);

  // Center does not observe geometry changes automatically. Invalidate its
  // cached bounds so Stage also moves the contact-shadow plane to the new base.
  const centerCacheKey = useMemo(
    () => ({ geometry, coloredGroup, boundsRevision }),
    [geometry, coloredGroup, boundsRevision],
  );

  return (
    <div className="iris-three-scene relative h-full w-full overflow-hidden">
      {/* Local Suspense boundary — `<Canvas>` re-throws suspension upward
          when any drei loader (e.g. <Environment> fetching city.hdr) is in
          flight. Without this boundary the suspension propagates all the
          way to <Await> inside TanStack's StartClient and tears down the
          entire app subtree. */}
      <Suspense
        fallback={<div className="iris-preview-surface h-full w-full" />}
      >
        <Canvas
          className="block h-full w-full"
          gl={{ alpha: true }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        >
          {isOrthographic ? (
            <OrthographicCamera
              makeDefault
              position={initialIsMobile ? [-100, 150, 100] : [-100, 100, 100]}
              zoom={40}
              near={0.1}
              far={1000}
            />
          ) : (
            <PerspectiveCamera
              makeDefault
              position={initialIsMobile ? [-100, 150, 100] : [-100, 100, 100]}
              fov={45}
              near={0.1}
              far={1000}
              zoom={0.4}
            />
          )}
          {/* Lighting belongs to the scene, outside Stage's moving Center. */}
          <Environment files={`${import.meta.env.BASE_URL}city.hdr`} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[5, 5, 5]} intensity={1.2} castShadow />
          <directionalLight position={[-5, 5, 5]} intensity={0.2} />
          <directionalLight position={[-5, 5, -5]} intensity={0.2} />
          <directionalLight position={[0, 5, 0]} intensity={0.2} />
          <directionalLight position={[-5, -5, -5]} intensity={0.6} />
          <Bounds>
            <FitToViewBridge onReady={setFitToView} />
            <Stage
              environment={null}
              intensity={0.6}
              position={[0, 0, 0]}
              center={{ cacheKey: centerCacheKey }}
            >
              {coloredGroup && groupCenterOffset ? (
                <group
                  rotation={[-Math.PI / 2, 0, 0]}
                  ref={import.meta.env.DEV ? setExportObject : undefined}
                >
                  <primitive
                    object={coloredGroup}
                    position={groupCenterOffset.toArray()}
                    visible={coloredGroupVisible}
                  />
                </group>
              ) : geometry ? (
                <mesh
                  ref={import.meta.env.DEV ? setExportObject : undefined}
                  geometry={geometry}
                  rotation={[-Math.PI / 2, 0, 0]}
                  position={[0, 0, 0]}
                >
                  <meshStandardMaterial
                    // Match the assembly tint; keep the caller's solid-color fallback.
                    color={useVertexColors ? CAD_PREVIEW_TINT : color}
                    vertexColors={useVertexColors}
                    {...CAD_PREVIEW_MATERIAL}
                  />
                </mesh>
              ) : null}
            </Stage>
          </Bounds>
          {/* <Grid
          position={[0, 0, 0]}
          cellSize={30}
          cellThickness={0.5}
          sectionSize={10}
          sectionColor="gray"
          sectionThickness={0.5}
          fadeDistance={500}
          fadeStrength={1}
          followCamera={false}
          infiniteGrid={true}
        /> */}
          <OrbitControls
            makeDefault
            enableDamping={true}
            dampingFactor={0.05}
          />
          {import.meta.env.DEV && DevOrbitGifExporter && (
            <Suspense fallback={null}>
              <DevOrbitGifExporter
                key={previewKey}
                objectRef={exportObjectRef}
                filenameBase={filenameBase}
              />
            </Suspense>
          )}
          {!initialIsMobile && (
            <ViewGizmo alignment="bottom-left" margin={[72, 112]} />
          )}
        </Canvas>
      </Suspense>

      <div
        className={cn(
          'absolute flex flex-col items-center',
          initialIsMobile ? 'bottom-2 right-2' : 'bottom-4 left-4',
        )}
      >
        <div className="flex items-center gap-2">
          <OrthographicPerspectiveToggle
            isOrthographic={isOrthographic}
            onToggle={setIsOrthographic}
          />
          <button
            type="button"
            className="iris-viewer-tool iris-viewer-fit"
            onClick={() => fitToViewRef.current?.()}
            aria-label="Fit model to view"
            title="Fit to view"
          >
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function FitToViewBridge({
  onReady,
}: {
  onReady: (fitToView: (() => void) | null) => void;
}) {
  const bounds = useBounds();

  useEffect(() => {
    const fitToView = () => {
      bounds.refresh().clip().reset().fit();
    };
    onReady(fitToView);
    return () => onReady(null);
  }, [bounds, onReady]);

  return null;
}
