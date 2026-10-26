import { getRandomValues } from 'expo-crypto';

// Expo's native getRandomValues has no development Math.random fallback.
// Installing the random source does not import or initialize a connection backend.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { ...globalThis.crypto, getRandomValues: getRandomValues as unknown as Crypto['getRandomValues'] }
  });
}
