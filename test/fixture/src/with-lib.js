import { pad } from '../node_modules/leftpad/index.js';
import { leaf } from './flow.js';

export function useLib(value) {
  const padded = pad(value);
  return leaf(padded);
}
