import { describe, expect, it } from 'vitest';

import { EventType, WorkspaceId, idSchema } from '../src/index.ts';

describe('ids', () => {
  it('accepts a prefixed ULID', () => {
    expect(WorkspaceId.safeParse('ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3').success).toBe(true);
  });

  it('rejects wrong prefix, length or alphabet', () => {
    expect(WorkspaceId.safeParse('usr_01J8Z3M4Q9V0X7K2B5N6P8R1T3').success).toBe(false);
    expect(WorkspaceId.safeParse('ws_01J8Z3M4Q9V0X7K2B5N6P8R1T').success).toBe(false);
    expect(WorkspaceId.safeParse('ws_01J8Z3M4Q9V0X7K2B5N6P8R1TI').success).toBe(false);
  });

  it('builds schemas for any prefix', () => {
    expect(idSchema('cat').safeParse('cat_01J8Z3M4Q9V0X7K2B5N6P8R1T3').success).toBe(true);
  });
});

describe('EventType', () => {
  it('does not include high-volume operational events', () => {
    expect(EventType.options).not.toContain('agent.authenticated');
    expect(EventType.options).not.toContain('sync.candidate_classified');
  });
});
