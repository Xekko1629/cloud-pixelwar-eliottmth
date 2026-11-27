import { useEffect, useSyncExternalStore } from 'react';
import { LogOutIcon, UserIcon } from '../ui/icons';
import { CALLBACK_PATH, type Auth } from './auth';

/** Asks the gateway for the Discord authorization URL, then leaves for Discord. */
export async function redirectToLogin(auth: Auth): Promise<void> {
  const url = await auth.startLogin();
  if (url) window.location.assign(url);
}

// Header block of the Discord login (WEB-02b): who is signed in, and sign-out. Signed out,
// the sign-in page of the App holds the button and the errors.
export function AuthControls({ auth }: { auth: Auth }) {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);

  // Back from Discord: exchange the code, then drop code and state from the address bar.
  useEffect(() => {
    if (window.location.pathname !== CALLBACK_PATH) return;
    const search = window.location.search;
    window.history.replaceState(null, '', '/');
    void auth.completeLogin(search);
  }, [auth]);

  if (state.status !== 'signed-in') return null;
  const name = state.user.name;
  return (
    <div className="account">
      <span className="account__name" title="Compte Discord connecté">
        <UserIcon width={16} height={16} />
        {name}
      </span>
      <button type="button" className="icon-button" onClick={() => auth.signOut()} aria-label="Se déconnecter" title="Se déconnecter">
        <LogOutIcon />
      </button>
    </div>
  );
}
