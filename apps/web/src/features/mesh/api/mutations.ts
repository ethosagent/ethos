import { useMutation } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';

export function useMeshRouteTest() {
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (capability: string) => rpc.mesh.routeTest({ capability }),
    onSuccess: (result) => {
      if (result.ok && result.routedTo) {
        notification.success({
          message: `Routed to ${result.routedTo}`,
          description: 'The mesh would dispatch a task with this capability to this peer.',
          placement: 'topRight',
        });
      } else {
        notification.warning({
          message: 'No peer available',
          description: result.reason ?? 'No live mesh agent advertises this capability.',
          placement: 'topRight',
        });
      }
    },
    onError: (err) =>
      notification.error({ message: 'Route failed', description: (err as Error).message }),
  });
}
