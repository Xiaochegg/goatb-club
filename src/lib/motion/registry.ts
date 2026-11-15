import type { core } from 'gsap'

const live = new Map<string, core.Tween | core.Timeline>()

export function register(key: string, anim: core.Tween | core.Timeline) {
  live.set(key, anim)
}
export function unregister(key: string) {
  live.delete(key)
}
export function liveCount() {
  return live.size
}
export function killAll() {
  live.forEach((a) => a.kill())
  live.clear()
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__motionRegistry = {
    liveCount,
    killAll,
  }
}
