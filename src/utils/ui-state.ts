/**
 * Cross-component UI signals that must be reachable from outside the component
 * tree — chiefly the Android back handler in App.vue, which has to close an
 * open overlay before it pops the router stack.
 *
 * A full store would be overkill: this is one nullable handle, and the reader
 * registers it while a sheet/menu/panel is open.
 */
import { reactive } from 'vue'

interface UiState {
  /** Name of the currently open overlay, or '' when nothing is open. */
  overlay: string
  /** Clears the overlay; set by whichever component opened it. */
  closeOverlay: (() => void) | null
  /**
   * Set while a page wants the tab bar out of the way.
   *
   * The shelf's multi-select mode uses it: the bulk-action bar takes the tab
   * bar's place at the bottom, exactly as it does in WeRead, so the two never
   * stack and the user cannot navigate away mid-selection by accident.
   */
  hideTabBar: boolean
}

export const uiState = reactive<UiState>({
  overlay: '',
  closeOverlay: null,
  hideTabBar: false,
})

/** Register an overlay as the back-press target. */
export function openOverlay(name: string, close: () => void): void {
  uiState.overlay = name
  uiState.closeOverlay = close
}

/** Unregister, but only if this overlay is still the active one. */
export function closeOverlay(name: string): void {
  if (uiState.overlay === name) {
    uiState.overlay = ''
    uiState.closeOverlay = null
  }
}
