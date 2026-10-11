import { cn } from '@/lib/utils';
import './iris-brand.css';

export type IrisWordmarkProps = {
  className?: string;
  compact?: boolean;
};

export function IrisWordmark({
  className,
  compact = false,
}: IrisWordmarkProps) {
  const baseUrl = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  const asset = compact
    ? 'iris-wordmark-compact@4x.webp'
    : 'iris-wordmark-normal@4x.webp';

  return (
    <img
      className={cn(
        'iris-wordmark',
        compact && 'iris-wordmark--compact',
        className,
      )}
      src={`${baseUrl}${asset}`}
      alt="IrisCAD"
      draggable={false}
    />
  );
}
