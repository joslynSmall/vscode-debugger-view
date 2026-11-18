import { pad } from '../node_modules/leftpad/index';
import { leaf } from './flow';

export function useLib(value: string): string {
  const padded = pad(value);
  return leaf(padded);
}
