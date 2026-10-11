import { useEffect, useRef } from 'react';
import { useSharedSpinnerVerb } from '@/hooks/useSharedSpinnerVerb';
import { IrisLogo } from '@/components/iris/IrisLogo';

type Props = {
  showLoadingText?: boolean;
};

const Loader = ({ showLoadingText = false }: Props) => {
  const dot2 = useRef<HTMLSpanElement>(null);
  const dot3 = useRef<HTMLSpanElement>(null);
  const sharedVerb = useSharedSpinnerVerb(showLoadingText);

  useEffect(() => {
    // ANIMATE LAST TWO DOTS WITH DELAYS AND INTERVALS
    const interval = setInterval(() => {
      dot2.current?.classList.toggle('opacity-0');
      setTimeout(() => {
        dot3.current?.classList.toggle('opacity-0');
      }, 300);
      setTimeout(() => {
        dot2.current?.classList.toggle('opacity-0');
        dot3.current?.classList.toggle('opacity-0');
      }, 600);
    }, 900);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative h-32 w-32">
        <IrisLogo active className="h-full w-full" alt="Iris working" />
      </div>
      {showLoadingText && (
        <p className="mt-4 text-base text-[#1d1d1f]">
          {sharedVerb}
          <span>.</span>
          <span
            ref={dot2}
            className="opacity-0 transition-opacity duration-200"
          >
            .
          </span>
          <span
            ref={dot3}
            className="opacity-0 transition-opacity duration-200"
          >
            .
          </span>
        </p>
      )}
    </div>
  );
};

export default Loader;
