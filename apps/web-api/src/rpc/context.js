import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
export const os = implement(contract).$context();
