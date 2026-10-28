import { expect, it, vi } from 'vitest';
import { MobileReplyQuotePreferences } from './mobile-reply-quote-preferences';

it('preserves the last saved quote visibility when saving fails and restores its exact preference on reopen', async () => {
  let stored: string | null = null;
  const storage = { getItem: vi.fn(async () => stored), setItem: vi.fn(async (_key: string, value: string) => { stored = value; }) };
  const preferences = new MobileReplyQuotePreferences(storage); await preferences.hydrate();
  expect(preferences.snapshot.visible).toBe(true);
  await preferences.save(false); storage.setItem.mockRejectedValueOnce(new Error('Unavailable storage'));
  await expect(preferences.save(true)).rejects.toThrow('could not be saved');
  expect(preferences.snapshot).toMatchObject({ visible: false, saving: false, failed: true });
  const reopened = new MobileReplyQuotePreferences(storage); await reopened.hydrate(); expect(reopened.snapshot.visible).toBe(false);
});
