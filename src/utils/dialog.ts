/**
 * App-owned dialogs.
 *
 * `window.confirm` / `window.alert` render the WebView's platform sheet, which
 * looks nothing like WeRead and cannot be styled or themed. Screens ask these
 * helpers instead; one <DialogHost /> in App.vue renders the card.
 */
import { reactive } from 'vue'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  /** Colour the confirm button red for destructive actions. */
  danger?: boolean
}

export interface AlertOptions {
  title?: string
  message: string
  confirmText?: string
}

interface DialogState {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
  danger: boolean
  alert: boolean
}

export const dialogState = reactive<DialogState>({
  open: false,
  title: '',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  alert: false,
})

let resolver: ((ok: boolean) => void) | null = null

function open(opts: ConfirmOptions & { alert?: boolean }): Promise<boolean> {
  // A second request replaces the first; the stale promise must not hang.
  resolver?.(false)
  return new Promise<boolean>((resolve) => {
    resolver = resolve
    Object.assign(dialogState, {
      open: true,
      title: opts.title || '',
      message: opts.message,
      confirmText: opts.confirmText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: Boolean(opts.danger),
      alert: Boolean(opts.alert),
    })
  })
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return open(opts)
}

export function alertDialog(opts: AlertOptions): Promise<void> {
  return open({ ...opts, alert: true }).then(() => undefined)
}

export function resolveDialog(ok: boolean): void {
  const resolve = resolver
  resolver = null
  dialogState.open = false
  resolve?.(ok)
}
