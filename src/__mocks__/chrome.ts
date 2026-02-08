import { vi } from 'vitest';

const storage: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        if (typeof keys === 'string') {
          return { [keys]: storage[keys] };
        }
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          result[key] = storage[key];
        }
        return result;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storage, items);
      }),
    },
  },
  identity: {
    getAuthToken: vi.fn(async () => ({ token: 'mock-token' })),
    removeCachedAuthToken: vi.fn(async () => {}),
  },
};

Object.assign(globalThis, { chrome: chromeMock });