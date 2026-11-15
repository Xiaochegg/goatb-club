'use client';

/**
 * FxLabLoader — FX Lab 面板挂载闸门（DEV ONLY）
 *
 * 双重门禁：① NODE_ENV=production 直接 null（且 dynamic chunk 永不请求）
 * ② URL 需带 ?fxlab=1。
 * 正常访客与生产构建零影响；开发时通过 /?fxlab=1 打开验证面板。
 */

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';

const FxLab = dynamic(
  () => import('@/components/fx/fx-lab').then(m => m.FxLab),
  { ssr: false, loading: () => null }
);

function FxLabGate() {
  const params = useSearchParams();
  if (process.env.NODE_ENV === 'production') return null;
  if (params.get('fxlab') !== '1') return null;
  return <FxLab />;
}

export function FxLabLoader() {
  return (
    <Suspense fallback={null}>
      <FxLabGate />
    </Suspense>
  );
}

export default FxLabLoader;
