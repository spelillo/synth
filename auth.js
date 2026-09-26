    // ---- Cloud sync (optional) ----
    // Sign-in is entirely optional: Synth works fully offline/anonymously
    // with these left unconfigured. Fill in to enable "Sign in" + cloud
    // save/load of CSVs and chat sessions. Get these from your Supabase
    // project: Settings -> API -> Project URL / anon public key.
    const SUPABASE_URL = 'https://gukxpikthryasymfuhgl.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1a3hwaWt0aHJ5YXN5bWZ1aGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMDAyNTQsImV4cCI6MjEwNDU3NjI1NH0.NFhryLa7MLSvjRGnT75EfxH_4M9tACdbVWOlmaLSXbw';

    // Session storage is a shared cookie (storage-cookie.js), not the
    // client's default localStorage, so a signed-in session here also
    // signs the user into synth-bi on the same parent domain.
    let sb = null;
    if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && window.supabase) {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { storage: window.sharedAuthStorage },
      });
    }

    async function initAuth() {
      if (!sb) return;
      const { data: { session } } = await sb.auth.getSession();
      handleAuthChange(session);
      sb.auth.onAuthStateChange((event, newSession) => {
        handleAuthChange(newSession);
        // Fires when someone clicks the link in the reset-password email
        // instead of pasting the code — Supabase's client auto-detects the
        // recovery tokens in the URL and authenticates them, but without
        // this they'd just land signed in with no way to actually set a
        // new password. Send them to the same "set new password" step the
        // paste-a-code flow ends on.
        if (event === 'PASSWORD_RECOVERY') openPasswordRecoveryReset();
      });
    }

    // Stripe redirects back to /?checkout=success after a completed
    // embedded-form payment (see return_url in api/create-checkout-session.js).
    const SAVE_SESSION_NUDGE_SEEN_KEY = 'synth_save_session_nudge_seen_v1';

    function maybeShowSaveSessionBanner() {
      if (currentUser) return;
      if (localStorage.getItem(SAVE_SESSION_NUDGE_SEEN_KEY)) return;
      document.getElementById('save-session-nudge-banner').hidden = false;
    }

    window.dismissSaveSessionNudgeBanner = function() {
      localStorage.setItem(SAVE_SESSION_NUDGE_SEEN_KEY, '1');
      document.getElementById('save-session-nudge-banner').hidden = true;
    };

    window.signInFromSaveSessionNudge = function() {
      window.dismissSaveSessionNudgeBanner();
      openAccountModal('signin');
    };

    function handleAuthChange(session) {
      currentUser = session?.user || null;
      const signInBtn = document.getElementById('sign-in-btn');

      if (currentUser) {
        signInBtn.textContent = currentUser.email;
        signInBtn.title = 'Account settings';
        document.getElementById('my-projects-btn').hidden = false;
        refreshPremiumStatus();
        resumePendingSaveQuery();
        resumePendingJoinLink();
      } else {
        signInBtn.textContent = 'Sign in';
        signInBtn.title = '';
        document.getElementById('my-projects-btn').hidden = true;
        isPremium = false;
        updatePremiumUI();
      }
      updateCloudButtons();
      updateAIState();
      refreshHomeWorkspaces();
      syncChartAccess();
    }

    // Signed in: the header button is the user's email and opens Settings.
    // Signed out: it opens the account modal.
    window.toggleAuthPanel = function() {
      if (currentUser) {
        openSettingsPanel();
        return;
      }
      openAccountModal('signin');
    };

    window.togglePasswordField = function(inputId, btnEl) {
      const input = document.getElementById(inputId);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btnEl.classList.toggle('is-showing', !showing);
      btnEl.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    };

    // ---- Account modal: sign in / sign up / confirm email / reset password ----
    // Supabase's signUp/signInWithPassword handle password hashing (bcrypt),
    // and every query goes through the client library's parameterized calls.
    // Nothing in this file builds SQL strings.

    const ACCOUNT_VIEWS = {
      fields: 'auth-fields-step',
      confirm: 'auth-confirm-step',
      forgot: 'forgot-step-request',
      reset: 'forgot-step-reset',
    };

    let authPanelMode = 'signin';
    // Set while waiting on the signup confirmation code (between signUp()
    // returning no session and verifyOtp() succeeding). Survives closing
    // the modal, so reopening it lands back on the code step.
    let pendingConfirmEmail = null;

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function setAccountMessage(el, text, kind) {
      el.textContent = text;
      el.classList.toggle('error', kind === 'error');
      el.classList.toggle('success', kind === 'success');
    }

    window.authPanelModeOpposite = function() {
      return authPanelMode === 'signin' ? 'signup' : 'signin';
    };

    window.openAccountModal = function(mode, view) {
      if (!sb) {
        alert('Cloud sync is not configured yet. Set SUPABASE_URL / SUPABASE_ANON_KEY in auth.js.');
        return;
      }
      document.getElementById('account-modal').hidden = false;
      if (view) {
        showAccountView(view);
      } else if (pendingConfirmEmail) {
        showAccountView('confirm');
      } else {
        showAccountView('fields');
        setAuthPanelMode(mode || 'signin');
      }
    };

    window.closeAccountModal = function() {
      document.getElementById('account-modal').hidden = true;
      document.getElementById('auth-password').value = '';
    };

    window.showAccountView = function(view) {
      Object.entries(ACCOUNT_VIEWS).forEach(([key, id]) => {
        document.getElementById(id).hidden = key !== view;
      });
      let focusId = { fields: 'auth-email', confirm: 'auth-confirm-code', forgot: 'forgot-email', reset: 'forgot-new-password' }[view];
      if (view === 'fields' && document.getElementById('auth-email').value.trim()) focusId = 'auth-password';
      // The shared modal focus trap (app.js) focuses [autofocus] when the
      // overlay opens, so mark the target as well as focusing it directly
      // for view switches while the modal is already open.
      document.querySelectorAll('#account-modal [autofocus]').forEach(el => el.removeAttribute('autofocus'));
      const focusEl = document.getElementById(focusId);
      focusEl.setAttribute('autofocus', '');
      focusEl.focus();
    };

    window.setAuthPanelMode = function(mode) {
      authPanelMode = mode;
      const isSignin = mode === 'signin';
      const signinTab = document.getElementById('auth-tab-signin');
      const signupTab = document.getElementById('auth-tab-signup');
      signinTab.classList.toggle('is-active', isSignin);
      signupTab.classList.toggle('is-active', !isSignin);
      signinTab.setAttribute('aria-selected', isSignin);
      signupTab.setAttribute('aria-selected', !isSignin);

      document.getElementById('account-title').textContent = isSignin ? 'Welcome back' : 'Create your account';
      document.getElementById('account-sub').textContent = isSignin
        ? 'Sign in to save files and sessions, use the AI tools, and build charts.'
        : "Sign up with your email and a password. We'll email you a code to confirm the address.";
      document.getElementById('auth-panel-submit-btn').textContent = isSignin ? 'Sign in' : 'Create account';
      document.getElementById('auth-forgot-link').hidden = !isSignin;
      document.getElementById('auth-password-help').hidden = isSignin;
      document.getElementById('auth-password').setAttribute('autocomplete', isSignin ? 'current-password' : 'new-password');
      document.getElementById('auth-switch-text').textContent = isSignin ? 'New to Synth?' : 'Already have an account?';
      document.getElementById('auth-switch-link').textContent = isSignin ? 'Create an account' : 'Sign in';
      setAccountMessage(document.getElementById('auth-message'), '');
    };

    window.authPanelSubmit = async function() {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      const msgEl = document.getElementById('auth-message');
      const submitBtn = document.getElementById('auth-panel-submit-btn');
      if (submitBtn.disabled) return;

      if (!EMAIL_RE.test(email)) {
        setAccountMessage(msgEl, 'Enter a valid email.', 'error');
        document.getElementById('auth-email').focus();
        return;
      }
      if (password.length < 8) {
        setAccountMessage(msgEl, 'Password must be at least 8 characters.', 'error');
        document.getElementById('auth-password').focus();
        return;
      }

      const mode = authPanelMode;
      setAccountMessage(msgEl, mode === 'signin' ? 'Signing in...' : 'Creating account...');
      submitBtn.disabled = true;

      let data, error;
      try {
        ({ data, error } = mode === 'signin'
          ? await sb.auth.signInWithPassword({ email, password })
          : await sb.auth.signUp({ email, password }));
      } catch (err) {
        error = err;
      }
      submitBtn.disabled = false;

      if (error) {
        setAccountMessage(msgEl, error.message, 'error');
        return;
      }

      document.getElementById('auth-password').value = '';
      setAccountMessage(msgEl, '');

      if (data.session) {
        closeAccountModal();
        return; // onAuthStateChange -> handleAuthChange takes it from here
      }

      // Supabase's "confirm email" project setting is on, so there's no
      // session yet. Ask for the emailed code right here instead of making
      // people round-trip through their inbox and sign in again.
      startAuthConfirmStep(email);
    };

    function startAuthConfirmStep(email) {
      pendingConfirmEmail = email;
      document.getElementById('auth-confirm-copy').textContent =
        `We sent a confirmation code to ${email}. Enter it below to finish creating your account.`;
      document.getElementById('auth-confirm-code').value = '';
      document.getElementById('auth-confirm-submit-btn').disabled = false;
      setAccountMessage(document.getElementById('auth-confirm-message'), '');
      showAccountView('confirm');
    }

    window.cancelAuthConfirmStep = function() {
      pendingConfirmEmail = null;
      showAccountView('fields');
      setAuthPanelMode('signup');
    };

    window.submitAuthConfirmCode = async function() {
      const token = document.getElementById('auth-confirm-code').value.trim();
      const msgEl = document.getElementById('auth-confirm-message');
      const submitBtn = document.getElementById('auth-confirm-submit-btn');
      if (!token) { setAccountMessage(msgEl, 'Enter the code from your email.', 'error'); return; }
      if (submitBtn.disabled) return;

      submitBtn.disabled = true;
      setAccountMessage(msgEl, 'Confirming...');
      const { error } = await sb.auth.verifyOtp({ email: pendingConfirmEmail, token, type: 'signup' });
      submitBtn.disabled = false;

      if (error) {
        setAccountMessage(msgEl, error.message, 'error');
        return;
      }

      // verifyOtp returns a real session; onAuthStateChange -> handleAuthChange
      // takes it from here, same as a normal sign-in.
      pendingConfirmEmail = null;
      closeAccountModal();
      showAccountView('fields');
    };

    window.resendAuthConfirmCode = async function() {
      const msgEl = document.getElementById('auth-confirm-message');
      const resendLink = document.getElementById('auth-confirm-resend-link');
      if (resendLink.classList.contains('is-disabled')) return;
      setAccountMessage(msgEl, 'Sending a new code...');
      resendLink.classList.add('is-disabled');
      const { error } = await sb.auth.resend({ type: 'signup', email: pendingConfirmEmail });
      if (error) {
        setAccountMessage(msgEl, error.message, 'error');
      } else {
        setAccountMessage(msgEl, 'New code sent.', 'success');
      }
      resendLink.classList.remove('is-disabled');
    };

    // ---- Forgot password ----
    // The link is Supabase's own recovery flow (sb.auth.resetPasswordForEmail).
    // Clicking it fires the PASSWORD_RECOVERY auth event (see initAuth), which
    // opens openPasswordRecoveryReset() straight to "set new password".

    window.showForgotPassword = function() {
      const emailField = document.getElementById('forgot-email');
      emailField.value = document.getElementById('auth-email').value.trim();
      emailField.disabled = false;
      document.getElementById('forgot-request-submit-btn').disabled = false;
      setAccountMessage(document.getElementById('forgot-request-message'), '');
      showAccountView('forgot');
    };

    // The reset-email link already authenticated a recovery session, so this
    // opens straight to "set new password" instead of leaving the user
    // signed in with no way to actually change anything.
    function openPasswordRecoveryReset() {
      document.getElementById('forgot-new-password').value = '';
      setAccountMessage(document.getElementById('forgot-reset-message'), '');
      openAccountModal(null, 'reset');
      // Supabase's client already consumed the recovery tokens in the URL.
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState({}, '', clean);
    }

    window.submitForgotPasswordRequest = async function() {
      const emailField = document.getElementById('forgot-email');
      const email = emailField.value.trim();
      const msgEl = document.getElementById('forgot-request-message');
      const submitBtn = document.getElementById('forgot-request-submit-btn');
      if (submitBtn.disabled) return;

      if (!EMAIL_RE.test(email)) {
        setAccountMessage(msgEl, 'Enter a valid email first.', 'error');
        return;
      }

      submitBtn.disabled = true;
      setAccountMessage(msgEl, 'Sending link...');
      const { error } = await sb.auth.resetPasswordForEmail(email);
      if (error) {
        submitBtn.disabled = false;
        setAccountMessage(msgEl, error.message, 'error');
        return;
      }

      emailField.disabled = true;
      setAccountMessage(msgEl, 'Check your email for a password reset link.', 'success');
    };

    window.submitForgotPasswordReset = async function() {
      const newPassword = document.getElementById('forgot-new-password').value;
      const msgEl = document.getElementById('forgot-reset-message');

      if (newPassword.length < 8) {
        setAccountMessage(msgEl, 'Password must be at least 8 characters.', 'error');
        return;
      }

      const { error: updateError } = await sb.auth.updateUser({ password: newPassword });
      if (updateError) {
        setAccountMessage(msgEl, updateError.message, 'error');
        return;
      }

      setAccountMessage(msgEl, 'Password updated. You are signed in.', 'success');
      setTimeout(() => {
        closeAccountModal();
        showAccountView('fields');
      }, 1500);
    };

    window.signOutUser = async function() {
      if (!sb) return;
      await sb.auth.signOut();
      closeSettingsPanel();

      // The view swap alone only hides stale data. On a shared device the
      // previous account's CSVs and chat history would still be in memory,
      // so reset the same way loading a fresh workspace does.
      db = new SQL.Database();
      tables = [];
      activeTableName = null;
      focusedTableNames = new Set();
      chatHistory = [];
      currentCSVFile = null;
      currentWorkspaceId = null;
      currentWorkspaceName = null;
      csvLoaded = false;
      aiEnabled = false;

      openHome();
    };

    // Serializes a live table's current rows back into CSV text, so saving
    // doesn't depend on still having the original uploaded File object
    // around (renamed tables, or tables added well after the first upload,
    // don't have one) — it always reflects exactly what's in `db` right now.
