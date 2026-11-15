export const MOTION = {
  duration: { micro: 0.12, small: 0.24, base: 0.5, large: 0.9, hero: 1.2 },
  ease:     { out: 'power3.out', inOut: 'power2.inOut', snap: 'expo.out' },
  stagger:  0.045,
  interrupt: { minGapMs: 80 },
} as const

export const INTERRUPT = {
  COALESCE: 'coalesce',
  IGNORE:   'ignore',
  PREEMPT:  'preempt',
  QUEUE:    'queue',
  REVERSE:  'reverse',
  PAUSE:    'pause',
} as const

export type InterruptStrategy =
  (typeof INTERRUPT)[keyof typeof INTERRUPT]

export type StrategyTable = Partial<Record<InterruptStrategy, string>>
