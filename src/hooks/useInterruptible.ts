'use client'
import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { register, unregister } from '@/lib/motion/registry'

// ============================================================
// useInterruptible — 可中断接管式 GSAP 动画 hook
//
// increment-patch（A01/A02）：
//   - 旧实现用裸 useLayoutEffect 驱动 gsap（违反 A01），无 scope（违反 A02）
//   - 现改用 @gsap/react 的 useGSAP：自动 gsap.context 包裹 + scope 限定 +
//     deps 变化/卸载时 context.revert() 自动清理（revertOnUpdate 默认 true）
//   - 保留原有「从当前进度接管」语义：build 收到 from=prev.progress()
//     （实际 deps 变化时 cleanup 先 null 化 cur，from 恒为 0；保留以防未来
//      非依赖触发的重跑场景）
//   - 保留 motion/registry 注册（dev 调试 liveCount/killAll）
// ============================================================

type Build = (
  el: HTMLElement,
  from: number
) => gsap.core.Tween | gsap.core.Timeline

export function useInterruptible<T extends HTMLElement = HTMLElement>(
  key: string,
  build: Build,
  deps: unknown[] = []
) {
  const ref = useRef<T | null>(null)
  const cur = useRef<gsap.core.Tween | gsap.core.Timeline | null>(null)

  useGSAP(
    () => {
      const el = ref.current
      if (!el) return
      const prev = cur.current
      const from = prev ? prev.progress() : 0   // 从当前进度接管，不跳变
      prev?.kill()
      if (prev) unregister(key)

      const anim = build(el, from)
      cur.current = anim
      register(key, anim)

      // useGSAP cleanup：deps 变化或卸载时调用（先于 context.revert 执行）
      return () => {
        anim.kill()
        unregister(key)
        if (cur.current === anim) cur.current = null
      }
    },
    { scope: ref, dependencies: deps }
  )

  return ref
}
