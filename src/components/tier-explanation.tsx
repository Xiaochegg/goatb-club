'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Info } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import {
  NORMAL_TIERS, JIAHAO_TIERS,
  NORMAL_TIER_SCORES, JIAHAO_TIER_SCORES,
  TIER_COLORS, TIER_BG_COLORS,
  type NormalTier, type JiahaoTier,
} from '@/lib/constants';

// ============================================================
// Component: Tier Explanation Dropdown — liquid glass
// 拆分自 src/app/page.tsx (split-tier-expl, 2026-10)
// 纯展示：段位与积分说明折叠面板。store 驱动开合态。
// ============================================================
export function TierExplanation() {
  const { tierDropdownOpen, setTierDropdownOpen } = useAppStore();

  return (
    <div className="px-4 mb-3">
      <motion.button
        onClick={() => setTierDropdownOpen(!tierDropdownOpen)}
        aria-label="段位与积分说明"
        aria-expanded={tierDropdownOpen}
        whileTap={{ scale: 0.97 }}
        className="liquid-press flex items-center gap-2 text-xs text-muted-foreground hover:text-secondary-foreground transition-colors min-h-[44px]"
      >
        <Info className="w-3.5 h-3.5" />
        <span>段位与积分说明</span>
        <motion.div animate={{ rotate: tierDropdownOpen ? 180 : 0 }} transition={{ duration: 0.25 }}>
          <ChevronDown className="w-3.5 h-3.5" />
        </motion.div>
      </motion.button>
      <AnimatePresence>
        {tierDropdownOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 26 }}
            className="overflow-hidden"
          >
            <div className="mt-3 liquid-glass-subtle v2l-card rounded-[var(--radius-liquid-md)] p-4 space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-secondary-foreground mb-2 tracking-wider uppercase">普通模式段位</h4>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                  {NORMAL_TIERS.map(tier => (
                    <div key={tier} className="flex items-center gap-2 px-2 py-1 rounded-lg liquid-tier-badge" style={{ background: TIER_BG_COLORS[tier] }}>
                      <span className="text-xs font-mono font-bold" style={{ color: TIER_COLORS[tier] }}>{tier}</span>
                      <span className="text-xs text-muted-foreground number-score">{NORMAL_TIER_SCORES[tier as NormalTier].toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-secondary-foreground mb-2 tracking-wider uppercase">嘉豪模式段位（娱乐）</h4>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                  {JIAHAO_TIERS.map(tier => (
                    <div key={tier} className="flex items-center gap-2 px-2 py-1 rounded-lg liquid-tier-badge" style={{ background: TIER_BG_COLORS[tier] }}>
                      <span className="text-xs font-mono font-bold" style={{ color: TIER_COLORS[tier] }}>{tier}</span>
                      <span className="text-xs text-muted-foreground number-score">{JIAHAO_TIER_SCORES[tier as JiahaoTier].toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-secondary-foreground mb-2 tracking-wider uppercase">小鸟模式段位（娱乐）</h4>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                  {JIAHAO_TIERS.map(tier => (
                    <div key={tier} className="flex items-center gap-2 px-2 py-1 rounded-lg liquid-tier-badge" style={{ background: TIER_BG_COLORS[tier] }}>
                      <span className="text-xs font-mono font-bold" style={{ color: TIER_COLORS[tier] }}>{tier}</span>
                      <span className="text-xs text-muted-foreground number-score">{JIAHAO_TIER_SCORES[tier as JiahaoTier].toLocaleString()}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                  🐦 小鸟规则：小鸟闯关达成<b className="text-secondary-foreground">全三星（★★★）</b>才能上榜；积分沿用嘉豪积分（LZ/LL 段位表），不计入总榜。
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground">总榜 = 11 个普通模式段位分之和（嘉豪 / 小鸟为娱乐模式，不计入总榜）</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
