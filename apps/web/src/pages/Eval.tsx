import { Navigate } from 'react-router-dom';

// Eval content now lives inside the Batch page's Eval tab.
// This route redirects to /batch?tab=eval.
export function Eval() {
  return <Navigate to="/batch?tab=eval" replace />;
}
