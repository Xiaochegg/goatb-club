'use client'
import gsap from 'gsap'
import { MOTION } from '@/lib/motion-tokens'
import { useInterruptible } from '@/hooks/useInterruptible'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// ============================================================
// TextMaskReveal — 逐字遮罩入场
//
// increment-patch（A01）：
//   - 旧实现除 useInterruptible 内部的 useGSAP 外，还有一个独立的
//     useLayoutEffect 处理 reduced-motion（gsap.set yPercent:0）——也是
//     裸 effect 驱动 gsap，违反 A01。
//   - 现把 reduced 判断并入 build 回调：reduced=true 时 gsap.set 到终态 +
//     返回空 timeline（不播放入场动画）。reduced 在 deps 中，变化时 useGSAP
//     自动重跑 build，效果与旧 useLayoutEffect 等价但无裸 effect。
// ============================================================

export function TextMaskReveal({
  text, keySeed = 'default', className = '',
}: {
  text: string
  keySeed?: string
  className?: string
}) {
  const reduced = useReducedMotion()
  const chars   = text.split('')

  const ref = useInterruptible<HTMLSpanElement>(
    `mask:${keySeed}`,
    (el, from) => {
      // reduced-motion：直接落终态，返回空 timeline（不播放入场）
      if (reduced) {
        gsap.set(el.querySelectorAll('.ch'), { yPercent: 0 })
        return gsap.timeline()
      }
      return gsap.fromTo(
        el.querySelectorAll('.ch'),
        { yPercent: 110 },
        {
          yPercent: 0,
          duration: MOTION.duration.hero,
          ease: MOTION.ease.out,
          stagger: MOTION.stagger,
          overwrite: 'auto',
          ...(from > 0 ? { progress: from } : {}),
        }
      )
    },
    [text, keySeed, reduced]
  )

  return (
    <span
      ref={ref}
      className={className}
      aria-label={text}
    >
      {chars.map((c, i) => (
        <span
          key={i}
          className="ch"
          style={{ display: 'inline-block', willChange: 'transform' }}
        >
          {c === ' ' ? '\u00A0' : c}
        </span>
      ))}
    </span>
  )
}
