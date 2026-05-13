export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

class ConfirmState {
  queue = $state<PendingConfirm[]>([]);

  get current(): PendingConfirm | null {
    return this.queue[0] ?? null;
  }

  push(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue = [...this.queue, { ...opts, resolve }];
    });
  }

  resolve(ok: boolean): void {
    const head = this.queue[0];
    if (!head) return;
    this.queue = this.queue.slice(1);
    head.resolve(ok);
  }
}

export const confirmState = new ConfirmState();

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return confirmState.push(opts);
}
