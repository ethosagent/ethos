import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QuickChatApp } from './QuickChatApp';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QuickChatApp />
    </StrictMode>,
  );
}
