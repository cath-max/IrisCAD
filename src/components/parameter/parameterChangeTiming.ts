import type { Parameter } from '@shared/types';

export type ParameterChangeTiming = {
  started_at_ms: number;
  debounce_ms: number;
};

export type ParameterChangeHandler = (
  parameters: Parameter[],
  timing?: ParameterChangeTiming,
) => void;
