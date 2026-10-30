import type { CSSProperties } from 'react';

// share decorative loading geometry without owning request state
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <span className={`skeleton${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />;
}
