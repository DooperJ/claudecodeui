import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

/**
 * This fork never looks up the upstream project's releases, so no update is
 * ever offered; the "restart required" hint, which only compares this build
 * with the running server, still works.
 */
describe('useVersionCheck', () => {
  const requested: string[] = [];

  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ installMode: 'git', version: '9.9.9' }), { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks only the local server and offers no update', async () => {
    const { result } = renderHook(() => useVersionCheck('siteboon', 'claudecodeui'));

    await waitFor(() => expect(result.current.runningVersion).toBe('9.9.9'));

    expect(requested).toEqual(['/health']);
    expect(result.current.updateAvailable).toBe(false);
    expect(result.current.latestVersion).toBeNull();
    expect(result.current.releaseInfo).toBeNull();
  });
});
