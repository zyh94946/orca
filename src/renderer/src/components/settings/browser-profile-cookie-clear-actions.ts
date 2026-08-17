import { toast } from 'sonner'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function clearProfileCookiesLabel(): string {
  return translate(
    'auto.components.settings.BrowserProfileRow.clearProfileCookies',
    'Clear profile cookies'
  )
}

export function clearGoogleCookiesLabel(): string {
  return translate(
    'auto.components.settings.BrowserProfileRow.clearGoogleCookies',
    'Clear Google cookies'
  )
}

type ProfileClearOptions = {
  confirm: ConfirmationDialogContextValue
  profileLabel: string
  executionHostLabel: string
}

// Why: this empties the whole jar, not just the Google family, and it also drops the profile's
// import source — so the confirmation has to name both losses, and the control must never be a
// single unguarded click.
export async function confirmAndClearProfileCookies(
  options: ProfileClearOptions & { onPendingChange: (pending: boolean) => void }
): Promise<void> {
  const confirmed = await options.confirm({
    title: translate(
      'auto.components.settings.BrowserProfileRow.clearProfileCookiesConfirmTitle',
      'Clear all cookies for this profile?'
    ),
    description: translate(
      'auto.components.settings.BrowserProfileRow.clearProfileCookiesConfirmDescription',
      'This deletes every cookie in the {{value0}} browser profile on {{value1}}, signing you out of every site in it, including Google. Orca also forgets which browser these cookies were imported from, so you would have to import them again.',
      { value0: options.profileLabel, value1: options.executionHostLabel }
    ),
    confirmLabel: clearProfileCookiesLabel(),
    confirmVariant: 'destructive'
  })
  if (!confirmed) {
    return
  }
  options.onPendingChange(true)
  try {
    const cleared = await useAppStore.getState().clearDefaultSessionCookies()
    toast[cleared ? 'success' : 'error'](
      cleared
        ? translate(
            'auto.components.settings.BrowserProfileRow.2d4bea7f35',
            'Default cookies cleared.'
          )
        : translate(
            'auto.components.settings.BrowserProfileRow.profileCookiesClearFailed',
            'Failed to clear profile cookies.'
          )
    )
  } finally {
    options.onPendingChange(false)
  }
}

// Why: the clear is domain-scoped to the google.com family and remove-only, which is what lets the
// confirmation promise that cookies for other sites survive it.
export async function confirmAndClearGoogleCookies(
  options: ProfileClearOptions & { profileId: string }
): Promise<void> {
  const confirmed = await options.confirm({
    title: translate(
      'auto.components.settings.BrowserProfileRow.clearGoogleCookiesConfirmTitle',
      'Clear Google cookies?'
    ),
    description: translate(
      'auto.components.settings.BrowserProfileRow.clearGoogleCookiesConfirmDescription',
      'This signs you out of Google in the {{value0}} browser profile on {{value1}}. Cookies for other sites are kept.',
      { value0: options.profileLabel, value1: options.executionHostLabel }
    ),
    confirmLabel: clearGoogleCookiesLabel(),
    confirmVariant: 'destructive'
  })
  if (!confirmed) {
    return
  }
  const cleared = await useAppStore.getState().clearBrowserProfileGoogleCookies(options.profileId)
  toast[cleared ? 'success' : 'error'](
    cleared
      ? translate(
          'auto.components.settings.BrowserProfileRow.googleCookiesCleared',
          'Google cookies cleared.'
        )
      : translate(
          'auto.components.settings.BrowserProfileRow.googleCookiesClearFailed',
          'Failed to clear Google cookies.'
        )
  )
}
