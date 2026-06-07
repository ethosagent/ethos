import { Dropdown, type MenuProps } from 'antd';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onSaveToDashboard: () => void;
}

export function SaveToDashboardContextMenu({ children, onSaveToDashboard }: Props) {
  const items: MenuProps['items'] = [
    { key: 'save', label: 'Save to Dashboard', onClick: onSaveToDashboard },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']}>
      {children}
    </Dropdown>
  );
}
