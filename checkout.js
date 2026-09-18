    // checkout.js — tier gating (canUseFeature/requireFeature) and the
    // Stripe embedded Checkout Form. Loaded by both synth.html (personal
    // Premium) and enterprise.html (org Premium), which share the
    // startEmbeddedCheckout() helper below instead of each hand-rolling
    // their own copy of the initCheckoutFormSdk -> createForm -> mount ->
    // loadActions -> confirm sequence.

    // Every account clears every tier gate in this file. Kept as a single
    // switch (rather than removing the gates themselves) so the tier system
    // can be turned back on later without rebuilding it.
    const ALL_TIERS_UNLOCKED = true;

    // ---- Premium checkout (Stripe) ----
    // Publishable keys are meant to be public, so — same as the Supabase
    // anon key above — this is hardcoded here rather than pulled from a
    // build-time env var: this is a static page with no bundler, so
    // there's no "browser-accessible env var" mechanism to plug into.
    // Get the real value from https://dashboard.stripe.com/test/apikeys.
    const STRIPE_PUBLISHABLE_KEY = 'pk_live_51UE9raRsooZUyqKOw6fAtTrMBdbjzeC8c4pZP2mg7tGxRXfthrT43J6jexAtBZNy293eztbHPtlU8ejXyureXqdW00Iw8YcLPY';

    let stripeClient = null;
    if (!ALL_TIERS_UNLOCKED && STRIPE_PUBLISHABLE_KEY !== 'pk_test_...' && window.Stripe) {
      stripeClient = window.Stripe(STRIPE_PUBLISHABLE_KEY, { betas: ['custom_checkout_payment_form_1'] });
    }

    function checkPremiumCheckoutReturn() {
      const params = new URLSearchParams(window.location.search);
      if (params.get('checkout') !== 'success') return;

      document.getElementById('premium-success-banner').hidden = false;

      params.delete('checkout');
      const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', clean);
    }

    // Lite Mode's pitch is "no account needed to start" — so the nudge to
    // save comes AFTER someone has already run a query and seen the product
    // work, not before. Shown once ever (not once per session) so it reads
    // as a single well-timed suggestion, never a nag.
    window.dismissPremiumSuccessBanner = function() {
      document.getElementById('premium-success-banner').hidden = true;
    };

    // ---- Premium status (profiles.is_premium) ----

    let isPremium = false;

    async function refreshPremiumStatus() {
      if (!sb || !currentUser) return;
      const { data, error } = await sb
        .from('profiles')
        .select('is_premium')
        .eq('id', currentUser.id)
        .maybeSingle();

      if (error) {
        console.error('Failed to load premium status:', error.message);
        return;
      }
      isPremium = !!data?.is_premium;
      updatePremiumUI();
    }

    function updatePremiumUI() {
      // The header used to grow a redundant "Premium ✓" badge once
      // you'd upgraded, duplicating what the Settings popup (behind the
      // email button) already shows. Once premium, just hide it instead.
      document.getElementById('go-premium-btn').hidden = ALL_TIERS_UNLOCKED || isPremium;
      const enterpriseNavBtn = document.getElementById('enterprise-nav-btn');
      if (enterpriseNavBtn) enterpriseNavBtn.hidden = ALL_TIERS_UNLOCKED;
      document.getElementById('dashboard-nav-btn').hidden = !currentUser;
      renderSettingsPremiumRow();
      // Premium status can change mid-session (checkout completes without
      // a reload) — refresh the table-chip bar too, since its "+ Add
      // table" cap/tooltip and rename affordance are tier-gated and would
      // otherwise stay stale until some unrelated re-render happened to
      // touch them.
      renderTableChips();
    }

    // ---- Tier gating (Lite -> Normal -> Premium) ----
    // Single source of truth for "can this account do X" so individual
    // features don't each grow their own ad hoc currentUser/isPremium check.

    const TIER_RANK = { lite: 0, normal: 1, premium: 2 };

    function getUserTier() {
      if (ALL_TIERS_UNLOCKED) return 'premium';
      if (!currentUser) return 'lite';
      return isPremium ? 'premium' : 'normal';
    }

    const FEATURE_MIN_TIER = {
      saveQuery: 'normal',
      dashboard: 'normal',
      multiCsv: 'premium',
      tableRename: 'premium',
      crossTableAI: 'premium',
      largeCsv: 'premium',
      relationshipDetection: 'premium',
    };

    function canUseFeature(featureKey) {
      return TIER_RANK[getUserTier()] >= TIER_RANK[FEATURE_MIN_TIER[featureKey]];
    }

    // Guards a feature: returns true and does nothing if the account's tier
    // already clears it, otherwise opens the right prompt (sign-in for the
    // Lite->Normal boundary, upgrade for the Normal->Premium boundary) and
    // returns false so the caller can bail out.
    function requireFeature(featureKey) {
      if (canUseFeature(featureKey)) return true;
      if (FEATURE_MIN_TIER[featureKey] === 'normal' && getUserTier() === 'lite') {
        openSigninRequiredModal();
      } else {
        openPremiumPanel();
      }
      return false;
    }

    window.openSigninRequiredModal = function() {
      document.getElementById('signin-required-modal').hidden = false;
    };

    window.closeSigninRequiredModal = function() {
      document.getElementById('signin-required-modal').hidden = true;
    };

    window.signInFromRequiredModal = function() {
      document.getElementById('signin-required-modal').hidden = true;
      // Deferred: this click's event is still bubbling up to the document-
      // level "close auth-panel on outside click" listener (see bottom of
      // file). Opening the panel synchronously here means that same click
      // immediately closes it again since e.target is this modal's button,
      // not the panel or its toggle — waiting a tick lets the click finish
      // propagating first.
      setTimeout(toggleAuthPanel, 0);
    };

    window.openCancelPremiumModal = function() {
      document.getElementById('cancel-premium-modal').hidden = false;
    };

    window.closeCancelPremiumModal = function() {
      document.getElementById('cancel-premium-modal').hidden = true;
    };

    window.confirmCancelPremium = async function() {
      if (!sb || !currentUser) return;
      const { error } = await sb
        .from('profiles')
        .update({ is_premium: false, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id);

      document.getElementById('cancel-premium-modal').hidden = true;

      if (error) {
        alert('Failed to cancel premium: ' + error.message);
        return;
      }
      isPremium = false;
      updatePremiumUI();
    };

    // Whether the in-browser workspace (tables + relationships) exactly
    // matches what's last saved to the cloud — drives the "Save to cloud"
    // button's real sync status instead of it always saying the same thing
    // whether or not there's actually anything new to save.
    let workspaceSynced = false;

    // ---- Premium checkout (Stripe embedded Checkout Form) ----

    let premiumCheckoutStarted = false;
    let mountedCheckoutForm = null;

    window.openPremiumPanel = function() {
      if (!currentUser) {
        document.getElementById('premium-signin-modal').hidden = false;
        return;
      }
      if (isPremium) {
        openSettingsPanel();
        return;
      }
      document.getElementById('premium-modal').hidden = false;
      // No guard here anymore — startEmbeddedCheckout() (called by
      // startPremiumCheckout below) owns the "already started" check now,
      // shared with enterprise.html's equivalent flow.
      startPremiumCheckout();
    };

    window.closePremiumPanel = function() {
      document.getElementById('premium-modal').hidden = true;
      // The embedded Stripe form (and its own floating UI, e.g. the Link
      // pill) isn't a real child of #premium-modal's hidden state — Stripe
      // mounts it separately, so hiding the modal alone left it floating
      // on the page. Unmount it and reset so reopening starts clean.
      if (mountedCheckoutForm) {
        try { mountedCheckoutForm.unmount(); } catch (err) { console.error('Failed to unmount checkout form:', err); }
        mountedCheckoutForm = null;
      }
      document.getElementById('checkout-form').innerHTML = '';
      premiumCheckoutStarted = false;
    };

    window.closePremiumSigninModal = function() {
      document.getElementById('premium-signin-modal').hidden = true;
    };

    // Header "Enterprise" button. Org creation now lives entirely on
    // synth-sql.com/enterprise (see archive/enterprise-build-spec.html) — this
    // button's only jobs are: let an existing member sign in or redeem a join
    // code without leaving this page, send an admin/workroom manager to the
    // dashboard page where their tools actually live, and point anyone new
    // at the Enterprise page to create an organization. A workroom manager is
    // still org_members.role === 'member' (see workrooms.sql), which is why
    // org_status's is_manager flag — not role alone — decides that branch.
    window.signInThenGoPremium = function() {
      document.getElementById('premium-signin-modal').hidden = true;
      // Deferred for the same reason as signInFromRequiredModal above — see
      // that comment.
      setTimeout(toggleAuthPanel, 0);
    };

    // Shared by synth.html's personal-Premium checkout and enterprise.html's
    // org-Premium checkout — previously two independent, near-identical
    // copies of this exact initCheckoutFormSdk -> createForm -> mount ->
    // loadActions -> confirm sequence. The one real behavioral difference
    // between them (one guarded against a double-start internally, the
    // other left it to the caller) is resolved by always owning the guard
    // here, via the caller-supplied getGuard/setGuard pair — each page
    // still keeps its own flag variable, only the check-and-set logic is
    // now shared.
    //
    // fetchClientSecret is called once and its PROMISE (not an awaited
    // value) is handed straight to Stripe: initCheckoutFormSdk doesn't
    // reject its own promise when that fetch fails, it reports the failure
    // internally as a "loaderror" instead — the .catch() below is what
    // turns that into user-visible feedback, without changing what value
    // Stripe itself receives.
    async function startEmbeddedCheckout({ stripeClient, fetchClientSecret, containerId, statusEl, appearance, getGuard, setGuard, notConfiguredMessage }) {
      if (getGuard()) return;
      setGuard(true);

      if (!stripeClient) {
        statusEl.classList.add('is-error');
        statusEl.textContent = notConfiguredMessage || 'Checkout isn\'t configured yet.';
        setGuard(false);
        return;
      }

      try {
        const clientSecretPromise = fetchClientSecret();
        clientSecretPromise.catch((err) => {
          statusEl.classList.add('is-error');
          statusEl.textContent = `Couldn't start checkout: ${err.message}`;
          setGuard(false);
        });

        const checkout = await stripeClient.initCheckoutFormSdk({ clientSecret: clientSecretPromise, appearance });
        statusEl.textContent = '';
        statusEl.classList.remove('is-error');

        const form = checkout.createForm({ layout: 'expanded' });
        form.mount(`#${containerId}`);

        const loadActionsResult = await checkout.loadActions();
        if (loadActionsResult.type === 'success') {
          form.on('confirm', async (event) => {
            try {
              await loadActionsResult.actions.confirm({ formConfirmEvent: event });
            } catch (error) {
              console.error('Payment confirmation error:', error);
              statusEl.classList.add('is-error');
              statusEl.textContent = 'Something went wrong confirming payment. Please try again.';
            }
          });
        }
        return form;
      } catch (err) {
        console.error('Stripe checkout error:', err);
        statusEl.classList.add('is-error');
        statusEl.textContent = `Couldn't start checkout: ${err.message}`;
        setGuard(false); // allow retry on next open
      }
    }

    async function startPremiumCheckout() {
      const statusEl = document.getElementById('premium-checkout-status');
      const form = await startEmbeddedCheckout({
        stripeClient,
        // The server verifies this bearer token and uses the account it
        // belongs to — it no longer trusts the userId in the body alone.
        fetchClientSecret: async () => {
          const { data: { session } } = await sb.auth.getSession();
          const response = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session?.access_token || ''}`
            },
            body: JSON.stringify({ userId: currentUser.id }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body?.error?.message || `Checkout session request failed (${response.status})`);
          }
          return (await response.json()).client_secret;
        },
        containerId: 'checkout-form',
        statusEl,
        appearance: {
          theme: 'flat',
          labels: 'auto',
          inputs: 'spaced',
          variables: {
            borderRadius: '4px',
            colorBackground: '#ffffff',
            colorDanger: '#df1b41',
            colorPrimary: '#0570de',
            colorSuccess: '#00c853',
            colorText: '#30313d',
            fontFamily: 'Inter',
            fontSizeBase: '16px',
            spacingUnit: '4px',
          },
        },
        getGuard: () => premiumCheckoutStarted,
        setGuard: (v) => { premiumCheckoutStarted = v; },
        notConfiguredMessage: 'Checkout isn\'t configured yet. Set a real Stripe publishable key (see STRIPE_INTEGRATION_TODO.md).',
      });
      if (form) mountedCheckoutForm = form;
    }

