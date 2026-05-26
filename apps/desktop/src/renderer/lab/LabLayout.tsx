import type { ReactNode } from 'react';

interface LabLayoutProps {
  children: ReactNode;
}

export function LabLayout({ children }: LabLayoutProps) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>{children}</div>;
}
