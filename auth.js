    // ---- Cloud sync (optional) ----
    // Sign-in is entirely optional: Synth works fully offline/anonymously
    // with these left unconfigured. Fill in to enable "Sign in" + cloud
    // save/load of CSVs and chat sessions. Get these from your Supabase
    // project: Settings -> API -> Project URL / anon public key.
    const SUPABASE_URL = 'https://gukxpikthryasymfuhgl.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1a3hwaWt0aHJ5YXN5bWZ1aGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMDAyNTQsImV4cCI6MjEwNDU3NjI1NH0.NFhryLa7MLSvjRGnT75EfxH_4M9tACdbVWOlmaLSXbw';

    let sb = null;
    if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && window.supabase) {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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

    window.signInFromSaveSessionNudge = function(event) {
      window.dismissSaveSessionNudgeBanner();
      toggleAuthPanel();
      // The document-level click-outside listener that closes #auth-panel
      // (near the end of this script) only exempts #auth-panel itself and
      // #sign-in-btn — without this, this same click keeps bubbling after
      // toggleAuthPanel() opens the panel and immediately closes it again.
      event?.stopPropagation();
    };

    function handleAuthChange(session) {
      currentUser = session?.user || null;
      const signInBtn = document.getElementById('sign-in-btn');

      if (currentUser) {
        signInBtn.textContent = currentUser.email;
        signInBtn.title = 'Account settings';
        // Signed in — the dropdown only ever holds the signed-out sign-in
        // form, so there's nothing for it to show now. Clicking the email
        // goes straight to Settings instead (see toggleAuthPanel).
        document.getElementById('auth-panel').hidden = true;
        document.getElementById('my-projects-btn').hidden = false;
        confirmLandingSignIn(currentUser.email);
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
      updateSignInButtonAvailability();
      updateCloudButtons();
      updateAIState();
    }

    // Lite Mode's whole pitch is "no account needed to start" — a clickable
    // Sign in button on the pre-upload landing page undercuts that, so it's
    // greyed out there until Normal Mode is picked. But that's a landing-page
    // affordance only: once the user is actually in the app (uploaded a CSV),
    // every Premium/Save-Query/Dashboard gate expects Sign in to work, so it
    // must never stay disabled there just because Lite Mode was picked
    // before upload — same for an existing session (currentUser), which
    // always gets a live "Account settings" link.
    function updateSignInButtonAvailability() {
      const signInBtn = document.getElementById('sign-in-btn');
      if (currentUser) {
        signInBtn.disabled = false;
        signInBtn.title = 'Account settings';
        return;
      }
      const onLandingView = !document.getElementById('landing-view').hidden;
      const disabled = onLandingView && landingMode === 'lite';
      signInBtn.disabled = disabled;
      signInBtn.title = disabled ? 'Switch to Normal Mode to sign in' : '';
    }

    window.toggleAuthPanel = function() {
      // Signed in: the header button is the user's email, and there's
      // nothing left for the dropdown to show — go straight to Settings.
      if (currentUser) {
        openSettingsPanel();
        return;
      }
      if (!sb) {
        alert('Cloud sync is not configured yet. Set SUPABASE_URL / SUPABASE_ANON_KEY in synth.html.');
        return;
      }
      const panel = document.getElementById('auth-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) setAuthPanelMode(authPanelMode);
    };

    // ---- Show/hide toggle, shared by every password field on the page ----

    window.togglePasswordField = function(inputId, btnEl) {
      const input = document.getElementById(inputId);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btnEl.classList.toggle('is-showing', !showing);
      btnEl.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    };

    // ---- Header sign-in dropdown: email + password, sign in or sign up ----
    // Supabase's own signUp/signInWithPassword do the real work here — bcrypt
    // hashing and every query going through the client library's parameterized
    // calls (never raw SQL string-building) come for free from that, not from
    // anything written in this file.

    let authPanelMode = 'signin';
    // Set while the header auth panel is waiting on the signup confirmation
    // code (between signUp() returning no session and verifyOtp() succeeding).
    // null means the panel is showing the normal email/password fields.
    let pendingConfirmEmail = null;

    window.setAuthPanelMode = function(mode) {
      authPanelMode = mode;
      document.getElementById('auth-tab-signin').classList.toggle('is-active', mode === 'signin');
      document.getElementById('auth-tab-signup').classList.toggle('is-active', mode === 'signup');
      document.getElementById('auth-panel-submit-btn').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      document.getElementById('auth-forgot-link').hidden = mode !== 'signin';
      document.getElementById('auth-message').textContent = '';
    };

    window.authPanelSubmit = async function() {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      const msgEl = document.getElementById('auth-message');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = 'Enter a valid email.';
        return;
      }
      if (password.length < 8) {
        msgEl.textContent = 'Password must be at least 8 characters.';
        return;
      }

      msgEl.textContent = authPanelMode === 'signin' ? 'Signing in...' : 'Creating account...';

      const { data, error } = authPanelMode === 'signin'
        ? await sb.auth.signInWithPassword({ email, password })
        : await sb.auth.signUp({ email, password });

      if (error) {
        msgEl.textContent = error.message;
        return;
      }

      if (data.session) {
        document.getElementById('auth-panel').hidden = true;
        document.getElementById('auth-password').value = '';
        return; // onAuthStateChange -> handleAuthChange takes it from here
      }

      // Supabase's "confirm email" project setting is on — no session yet.
      // Previously this told people to "check your email, then sign in" and
      // switched to the sign-in form, but signing in before confirming
      // doesn't actually work (and shouldn't) — it just meant most people's
      // effective flow was "type your password twice." Ask for the emailed
      // code directly instead: it's a real second factor, and typing 8
      // digits back into this same panel is a smaller ask than round-
      // tripping through an email client.
      document.getElementById('auth-password').value = '';
      startAuthConfirmStep(email);
    };

    function startAuthConfirmStep(email) {
      pendingConfirmEmail = email;
      document.getElementById('auth-fields-step').hidden = true;
      document.getElementById('auth-confirm-step').hidden = false;
      document.getElementById('auth-confirm-copy').textContent =
        `We sent a confirmation code to ${email}. Enter it below to finish creating your account.`;
      document.getElementById('auth-confirm-code').value = '';
      document.getElementById('auth-confirm-message').textContent = '';
      document.getElementById('auth-confirm-message').className = 'auth-message';
      document.getElementById('auth-confirm-code').focus();
    }

    window.cancelAuthConfirmStep = function() {
      pendingConfirmEmail = null;
      document.getElementById('auth-confirm-step').hidden = true;
      document.getElementById('auth-fields-step').hidden = false;
      setAuthPanelMode('signup');
    };

    window.submitAuthConfirmCode = async function() {
      const token = document.getElementById('auth-confirm-code').value.trim();
      const msgEl = document.getElementById('auth-confirm-message');
      const submitBtn = document.getElementById('auth-confirm-submit-btn');
      msgEl.className = 'auth-message';
      if (!token) { msgEl.textContent = 'Enter the code from your email.'; return; }
      if (submitBtn.disabled) return;

      submitBtn.disabled = true;
      msgEl.textContent = 'Confirming...';
      const { data, error } = await sb.auth.verifyOtp({ email: pendingConfirmEmail, token, type: 'signup' });

      if (error) {
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        return;
      }

      pendingConfirmEmail = null;
      document.getElementById('auth-panel').hidden = true;
      document.getElementById('auth-confirm-step').hidden = true;
      document.getElementById('auth-fields-step').hidden = false;
      // handleAuthChange fires from onAuthStateChange (verifyOtp returns a
      // real session on success) and takes it from here, same as a normal
      // sign-in — submitBtn is left disabled since this whole step is about
      // to be hidden and reset on next open, not re-shown.
      if (data.session) return;
    };

    window.resendAuthConfirmCode = async function() {
      const msgEl = document.getElementById('auth-confirm-message');
      const resendLink = document.getElementById('auth-confirm-resend-link');
      if (resendLink.classList.contains('is-disabled')) return;
      msgEl.className = 'auth-message';
      msgEl.textContent = 'Sending a new code...';
      resendLink.classList.add('is-disabled');
      const { error } = await sb.auth.resend({ type: 'signup', email: pendingConfirmEmail });
      if (error) {
        msgEl.classList.add('is-error');
        msgEl.textContent = error.message;
      } else {
        msgEl.textContent = 'New code sent.';
      }
      resendLink.classList.remove('is-disabled');
    };

    window.openForgotPasswordFromHeader = function() {
      document.getElementById('auth-panel').hidden = true;
      openForgotPasswordModal(document.getElementById('auth-email').value.trim());
    };

    // ---- Landing panel: same email + password flow, styled for the hero ----

    let landingAuthMode = 'signup';
    // Set while the landing page's "Create your account" panel is waiting
    // on a signup confirmation code.
    let landingConfirmEmail = null;

    window.toggleLandingAuthMode = function() {
      landingAuthMode = landingAuthMode === 'signup' ? 'signin' : 'signup';
      renderLandingAuthMode();
    };

    function renderLandingAuthMode() {
      const isSignup = landingAuthMode === 'signup';
      document.getElementById('landing-auth-title').textContent = isSignup ? 'Create your account.' : 'Sign in.';
      document.getElementById('landing-auth-submit-btn').textContent = isSignup ? 'Create account' : 'Sign in';
      document.getElementById('landing-auth-switch-text').textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
      document.getElementById('landing-auth-switch-link').textContent = isSignup ? 'Sign in' : 'Sign up';
      document.getElementById('landing-auth-forgot-wrap').hidden = isSignup;
      const msgEl = document.getElementById('landing-auth-message');
      msgEl.textContent = '';
      msgEl.classList.remove('error', 'success');
    }

    window.landingAuthSubmit = async function() {
      const emailInput = document.getElementById('landing-email');
      const passwordInput = document.getElementById('landing-password');
      const msgEl = document.getElementById('landing-auth-message');
      const email = emailInput.value.trim();
      const password = passwordInput.value;

      msgEl.classList.remove('error');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = 'Enter a valid email first.';
        msgEl.classList.add('error');
        return;
      }
      if (password.length < 8) {
        msgEl.textContent = 'Password must be at least 8 characters.';
        msgEl.classList.add('error');
        return;
      }

      if (!sb) {
        // Cloud sign-in isn't configured — nothing to actually confirm, so
        // don't block the product behind a check we can't perform.
        unlockLandingUpload();
        return;
      }

      msgEl.textContent = landingAuthMode === 'signup' ? 'Creating account...' : 'Signing in...';

      const { data, error } = landingAuthMode === 'signup'
        ? await sb.auth.signUp({ email, password })
        : await sb.auth.signInWithPassword({ email, password });

      if (error) {
        msgEl.textContent = error.message;
        msgEl.classList.add('error');
        return;
      }

      if (!data.session) {
        // Supabase's "confirm email" project setting is on — no session yet.
        // Ask for the emailed code directly instead of bouncing to a sign-in
        // form that would just fail anyway before confirmation. See the
        // same change in authPanelSubmit (header auth panel) for context.
        passwordInput.value = '';
        startLandingConfirmStep(email);
        return;
      }
      // onAuthStateChange -> handleAuthChange -> confirmLandingSignIn takes it from here.
    };

    function startLandingConfirmStep(email) {
      landingConfirmEmail = email;
      document.getElementById('landing-auth-fields-step').hidden = true;
      document.getElementById('landing-auth-confirm-step').hidden = false;
      document.getElementById('landing-confirm-copy').textContent =
        `We sent a confirmation code to ${email}. Enter it below to finish creating your account.`;
      document.getElementById('landing-confirm-code').value = '';
      document.getElementById('landing-confirm-message').textContent = '';
      document.getElementById('landing-confirm-message').className = 'landing-auth-message';
      document.getElementById('landing-confirm-code').focus();
    }

    window.cancelLandingConfirmStep = function() {
      landingConfirmEmail = null;
      document.getElementById('landing-auth-confirm-step').hidden = true;
      document.getElementById('landing-auth-fields-step').hidden = false;
      landingAuthMode = 'signup';
      renderLandingAuthMode();
    };

    window.submitLandingConfirmCode = async function() {
      const token = document.getElementById('landing-confirm-code').value.trim();
      const msgEl = document.getElementById('landing-confirm-message');
      const submitBtn = document.getElementById('landing-confirm-submit-btn');
      msgEl.className = 'landing-auth-message';
      if (!token) { msgEl.textContent = 'Enter the code from your email.'; msgEl.classList.add('error'); return; }
      if (submitBtn.disabled) return;

      submitBtn.disabled = true;
      msgEl.textContent = 'Confirming...';
      const { error } = await sb.auth.verifyOtp({ email: landingConfirmEmail, token, type: 'signup' });

      if (error) {
        msgEl.textContent = error.message;
        msgEl.classList.add('error');
        submitBtn.disabled = false;
        return;
      }

      landingConfirmEmail = null;
      // confirmLandingSignIn (via onAuthStateChange -> handleAuthChange)
      // writes its "Connected" message into #landing-auth-message, which
      // lives in the fields step — switch back to it first or that message
      // lands in a hidden element and nobody sees it.
      document.getElementById('landing-auth-confirm-step').hidden = true;
      document.getElementById('landing-auth-fields-step').hidden = false;
    };

    window.resendLandingConfirmCode = async function() {
      const msgEl = document.getElementById('landing-confirm-message');
      const resendLink = document.getElementById('landing-confirm-resend-link');
      if (resendLink.classList.contains('is-disabled')) return;
      msgEl.className = 'landing-auth-message';
      msgEl.textContent = 'Sending a new code...';
      resendLink.classList.add('is-disabled');
      const { error } = await sb.auth.resend({ type: 'signup', email: landingConfirmEmail });
      if (error) {
        msgEl.classList.add('error');
        msgEl.textContent = error.message;
      } else {
        msgEl.textContent = 'New code sent.';
      }
      resendLink.classList.remove('is-disabled');
    };

    window.openForgotPasswordFromLanding = function() {
      openForgotPasswordModal(document.getElementById('landing-email').value.trim());
    };

    function confirmLandingSignIn(email) {
      const panel = document.getElementById('landing-upload-panel');
      if (!panel || normalModeConfirmed) return;
      normalModeConfirmed = true;
      unlockLandingUpload();

      const emailInput = document.getElementById('landing-email');
      if (emailInput && !emailInput.value.trim()) emailInput.value = email;

      showLandingConnected(`Connected. Signed in as ${email}.`);
    }

    function showLandingConnected(text) {
      const msgEl = document.getElementById('landing-auth-message');
      if (msgEl) {
        msgEl.classList.remove('error');
        msgEl.classList.add('success');
        msgEl.textContent = `✓ ${text}`;
      }

      const emailInput = document.getElementById('landing-email');
      const passwordInput = document.getElementById('landing-password');
      const submitBtn = document.getElementById('landing-auth-submit-btn');
      if (emailInput) emailInput.disabled = true;
      if (passwordInput) passwordInput.disabled = true;
      if (submitBtn) submitBtn.disabled = true;
    }

    function unlockLandingUpload() {
      const label = document.getElementById('landing-upload-label');
      label.classList.remove('is-locked');
      label.classList.remove('is-pending');
      document.getElementById('landing-upload-sub').textContent = 'Ready. Drop in any CSV to get started.';
      document.getElementById('landing-upload-panel').classList.add('unlocked');
    }

    // ---- Forgot password: request a reset link by email ----
    // The link is Supabase's own recovery flow (sb.auth.resetPasswordForEmail)
    // — clicking it fires the PASSWORD_RECOVERY auth event above, which opens
    // openPasswordRecoveryReset() straight to the "set new password" step.
    // Nothing custom to store or invalidate here.

    window.openForgotPasswordModal = function(prefillEmail) {
      document.getElementById('forgot-password-modal').hidden = false;
      document.getElementById('forgot-step-request').hidden = false;
      document.getElementById('forgot-step-reset').hidden = true;
      document.getElementById('forgot-request-message').textContent = '';
      document.getElementById('forgot-request-message').classList.remove('error', 'success');
      document.getElementById('forgot-reset-message').textContent = '';
      document.getElementById('forgot-reset-message').classList.remove('error', 'success');
      document.getElementById('forgot-new-password').value = '';
      const emailField = document.getElementById('forgot-email');
      emailField.value = prefillEmail || '';
      emailField.disabled = false;
    };

    // Reached via the PASSWORD_RECOVERY auth event, i.e. the user clicked
    // the link in the reset email — that click already authenticated a
    // recovery session, so this opens straight to "set new password"
    // instead of leaving the user stuck "signed in" with no way to
    // actually change anything.
    function openPasswordRecoveryReset() {
      document.getElementById('forgot-password-modal').hidden = false;
      document.getElementById('forgot-step-request').hidden = true;
      document.getElementById('forgot-step-reset').hidden = false;
      document.getElementById('forgot-new-password').value = '';
      document.getElementById('forgot-reset-message').textContent = '';
      document.getElementById('forgot-reset-message').classList.remove('error', 'success');
      // Clean the recovery tokens out of the URL bar — Supabase's client
      // already consumed them, no reason to leave them visible/bookmarkable.
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState({}, '', clean);
    }

    window.closeForgotPasswordModal = function() {
      document.getElementById('forgot-password-modal').hidden = true;
    };

    window.submitForgotPasswordRequest = async function() {
      const email = document.getElementById('forgot-email').value.trim();
      const msgEl = document.getElementById('forgot-request-message');
      msgEl.classList.remove('error');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msgEl.textContent = 'Enter a valid email first.';
        msgEl.classList.add('error');
        return;
      }

      msgEl.textContent = 'Sending link...';
      const { error } = await sb.auth.resetPasswordForEmail(email);
      if (error) {
        msgEl.textContent = error.message;
        msgEl.classList.add('error');
        return;
      }

      document.getElementById('forgot-email').disabled = true;
      msgEl.classList.add('success');
      msgEl.textContent = 'Check your email for a password reset link.';
    };

    // Only ever reached via openPasswordRecoveryReset — clicking the email
    // link already authenticated a recovery session, so this just sets the
    // new password directly on it.
    window.submitForgotPasswordReset = async function() {
      const newPassword = document.getElementById('forgot-new-password').value;
      const msgEl = document.getElementById('forgot-reset-message');
      msgEl.classList.remove('error');

      if (newPassword.length < 8) {
        msgEl.textContent = 'Password must be at least 8 characters.';
        msgEl.classList.add('error');
        return;
      }

      const { error: updateError } = await sb.auth.updateUser({ password: newPassword });
      if (updateError) {
        msgEl.textContent = updateError.message;
        msgEl.classList.add('error');
        return;
      }

      msgEl.classList.add('success');
      msgEl.textContent = 'Password updated. You are signed in.';
      setTimeout(closeForgotPasswordModal, 1500);
    };

    window.signOutUser = async function() {
      if (!sb) return;
      await sb.auth.signOut();
      document.getElementById('auth-panel').hidden = true;
      closeSettingsPanel();
      // Sign out is only reachable from Settings, which can be opened from
      // either the app or the Dashboard — hide both and land back on the
      // hero page instead of leaving a signed-out header over stale data.
      document.getElementById('app-view').hidden = true;
      document.getElementById('dashboard-view').hidden = true;
      document.getElementById('landing-view').hidden = false;
      // Re-check now that landing-view is actually visible again — the
      // SIGNED_OUT auth-state-change callback (which also calls this) can
      // fire before these hidden flags flip, so it may have checked too
      // early and left the button live on a Lite Mode landing page.
      updateSignInButtonAvailability();

      // The header/view swap above only hides stale data, it doesn't
      // discard it — on a shared device the previous account's CSVs and
      // chat history would still be sitting in memory. Reset the same way
      // loading a fresh workspace already does (see loadCloudWorkspace).
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

      selectLandingMode('lite');
    };

    // Serializes a live table's current rows back into CSV text, so saving
    // doesn't depend on still having the original uploaded File object
    // around (renamed tables, or tables added well after the first upload,
    // don't have one) — it always reflects exactly what's in `db` right now.
