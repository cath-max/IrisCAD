import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { resolveIrisLogoAsset } from './irisLogoState';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

export type IrisLogoProps = {
  active?: boolean;
  className?: string;
  alt?: string;
};

export function IrisLogo({
  active = false,
  className,
  alt = 'Iris',
}: IrisLogoProps) {
  const reducedMotion = usePrefersReducedMotion();
  const animate = active && !reducedMotion;
  const baseUrl = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const asset = resolveIrisLogoAsset(active, reducedMotion);

  return (
    <img
      key={animate ? 'active' : 'static'}
      className={cn('block object-contain', className)}
      src={`${baseUrl}${asset}`}
      alt={alt}
      data-agent-active={animate}
      draggable={false}
    />
  );
}
