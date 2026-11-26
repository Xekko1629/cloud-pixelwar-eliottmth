import { useEffect, useSyncExternalStore } from 'react';
import { AUTH_ERRORS, CALLBACK_PATH, type Auth } from './auth';

// Header block of the Discord login (WEB-02b): button, current user, sign-out, errors.
export function AuthControls({ auth }: { auth: Auth }) {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);

  // Back from Discord: exchange the code, then drop code and state from the address bar.
  useEffect(() => {
    if (window.location.pathname !== CALLBACK_PATH) return;
    const search = window.location.search;
    window.history.replaceState(null, '', '/');
    void auth.completeLogin(search);
  }, [auth]);

  async function login() {
    const url = await auth.startLogin();
    if (url) window.location.assign(url);
  }

  if (state.status === 'signed-in') {
    return (
      <div className="auth">
        <span className="auth__user">Connecté : {state.user.name}</span>
        <button type="button" className="auth__button" onClick={() => auth.signOut()}>Se déconnecter</button>
      </div>
    );
  }

  const pending = state.status === 'pending';
  return (
    <div className="auth">
      {state.status === 'signed-out' && state.error && (
        <span className="auth__error" role="alert">{AUTH_ERRORS[state.error]}</span>
      )}
      <button type="button" className="auth__button" disabled={pending} onClick={() => void login()}>
        {pending ? 'Connexion…' : 'Se connecter avec Discord'}
      </button>
    </div>
  );
}
