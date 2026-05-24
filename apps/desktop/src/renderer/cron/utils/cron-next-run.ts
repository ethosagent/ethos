import { Cron } from 'croner';

export function getNextRun(cronExpression: string): Date | null {
  try {
    const job = new Cron(cronExpression);
    return job.nextRun() ?? null;
  } catch {
    return null;
  }
}

export function formatNextRun(date: Date | null): string {
  if (!date) return 'Invalid schedule';

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (date.toDateString() === now.toDateString()) {
    return `Today ${timeStr}`;
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${dateStr}, ${timeStr}`;
}
