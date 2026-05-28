import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { evolverKeys, skillKeys } from './keys';

export function useSkillDelete() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.skills.delete({ id }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: skillKeys.list() });
      notification.success({ message: `Deleted skill ${id}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });
}

export function useSkillCreate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: { id: string; body: string }) => rpc.skills.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: skillKeys.list() });
      notification.success({ message: 'Skill created', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });
}

export function useSkillUpdate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => rpc.skills.update({ id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: skillKeys.list() });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}

export function useEvolverConfigUpdate() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (cfg: Parameters<typeof rpc.evolver.configUpdate>[0]) =>
      rpc.evolver.configUpdate(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evolverKeys.config() });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });
}

export function useEvolverPendingApprove() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingApprove({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evolverKeys.pending() });
      qc.invalidateQueries({ queryKey: skillKeys.list() });
      notification.success({ message: 'Approved — skill is now live.', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });
}

export function useEvolverPendingReject() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingReject({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: evolverKeys.pending() });
      qc.invalidateQueries({ queryKey: skillKeys.list() });
      notification.success({ message: 'Rejected', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
  });
}
