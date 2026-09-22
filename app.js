    async function initDB() {
      const SQL = await initSqlJs({
        locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.8.0/dist/${file}`
      });
      document.getElementById('status').textContent = 'Ready';
      document.getElementById('status').classList.add('ready');
      return SQL;
    }

    window.addEventListener('DOMContentLoaded', async () => {
      SQL = await initDB();
      initHome();
      initAuth();
      checkPremiumCheckoutReturn();
      checkEnterpriseJoinReturn();
    });

    // ---- Synth Enterprise join links (?join=<token>) ----
    // Mirrors checkPremiumCheckoutReturn's URL-param pattern above, but the
    // outcome isn't known until an authenticated request completes (a
    // Stripe redirect is always "success" by the time it comes back; a
    // join link can fail on an expired token or a domain mismatch), so this
    // stashes the token and resolves it once sign-in state is known —
    // same deferred pattern as pendingSaveQueryDraft/resumePendingSaveQuery
    // further down this file.
    let pendingJoinToken = null;

    function checkEnterpriseJoinReturn() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('join');
      if (!token) return;

      pendingJoinToken = token;
      params.delete('join');
      const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
      window.history.replaceState({}, '', clean);

      // initAuth() (called just before this) doesn't await its own
      // getSession() call, so currentUser isn't reliably set yet here even
      // for an already-signed-in visitor — handleAuthChange's
      // resumePendingJoinLink() call is what actually resolves this in
      // that case. This prompt is only needed for the genuinely-signed-out
      // path.
      if (!currentUser) {
        openSigninRequiredModal();
      }
    }

    function resumePendingJoinLink() {
      const token = pendingJoinToken;
      if (!token) return;
      pendingJoinToken = null;
      redeemJoinToken(token);
    }

    async function redeemJoinToken(token) {
      const banner = document.getElementById('enterprise-join-banner');
      const textEl = document.getElementById('enterprise-join-banner-text');
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/member-actions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'join', token }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body?.error?.message || `Request failed (${response.status})`);
        }
        banner.classList.remove('is-error');
        textEl.textContent = `✓ You've joined ${body.org?.name || 'your organization'} — Premium is now active on your account.`;
        banner.hidden = false;
        refreshPremiumStatus();
      } catch (err) {
        console.error('Failed to redeem join link:', err);
        banner.classList.add('is-error');
        textEl.textContent = `Couldn't join: ${err.message}`;
        banner.hidden = false;
      }
    }

    window.dismissEnterpriseJoinBanner = function() {
      document.getElementById('enterprise-join-banner').hidden = true;
    };

    // ---- Account settings (Settings modal, opened via the email button) ----

    window.openSettingsPanel = function() {
      if (!currentUser) return;
      document.getElementById('settings-email').textContent = currentUser.email;
      const memberSinceEl = document.getElementById('settings-member-since');
      const joined = currentUser.created_at ? new Date(currentUser.created_at) : null;
      memberSinceEl.textContent = joined
        ? `Member since ${joined.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}`
        : '';
      renderSettingsPremiumRow();
      renderSettingsEnterpriseRow();
      document.getElementById('settings-modal').hidden = false;
    };

    window.closeSettingsPanel = function() {
      document.getElementById('settings-modal').hidden = true;
    };

    function renderSettingsPremiumRow() {
      const row = document.getElementById('settings-premium-row');
      if (!row) return;
      row.innerHTML = isPremium
        ? `<span class="workspace-badge">Premium</span>
           <p class="help-text" style="margin:8px 0">Multi-table workspaces, table renaming, cross-table AI queries, relationship detection, and CSVs up to 500,000 rows. It's a one-time purchase, so nothing renews and there's nothing to cancel on Stripe's side.</p>
           <button class="auth-btn" onclick="openCancelPremiumModal()">Cancel Premium</button>`
        : `<p class="help-text" style="margin:0 0 10px">Free plan: single-table workspaces, up to 100,000 rows. Upgrade for multi-table workspaces, table renaming, cross-table AI queries, relationship detection, and CSVs up to 500,000 rows. Early-adopter price while Synth is in beta.</p>
           <button class="auth-btn auth-btn-premium" onclick="closeSettingsPanel(); openPremiumPanel();">Go Premium ($9.99 once)</button>`;
    }

    async function renderSettingsEnterpriseRow() {
      const row = document.getElementById('settings-enterprise-row');
      if (!row) return;
      row.innerHTML = '<p class="help-text" style="margin:0">Loading…</p>';

      let status;
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=org_status', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        status = await response.json();
      } catch (err) {
        console.error('Failed to load Enterprise status:', err);
        row.innerHTML = '<p class="help-text" style="margin:0">Couldn\'t load Enterprise status.</p>';
        return;
      }

      if (!status.role) {
        row.innerHTML = `<p class="help-text" style="margin:0 0 10px">For a school or company: pay once a year for the whole domain, generate a join link, and every verified member gets Premium for free.</p>
           <button class="auth-btn auth-btn-enterprise" onclick="window.open('/enterprise', '_blank')">Set up Synth Enterprise</button>`;
        return;
      }

      if (status.role === 'member') {
        row.innerHTML = `<p class="help-text" style="margin:0 0 10px">Your Premium access comes from your organization (<strong>${escapeHtml(status.org?.domain || '')}</strong>). Contact your admin with any billing questions.</p>
           <div id="enterprise-workrooms-member"></div>`;
        // A workroom manager is still org_members.role === 'member' — the
        // spec deliberately keeps "manager" out of the role column (see
        // SYNTH_ENTERPRISE_SPEC.md §8 decision 1) — so this always tries to
        // render the section; renderWorkroomsSection just leaves it empty
        // if the API returns no workrooms for this caller.
        renderWorkroomsSection('enterprise-workrooms-member', { allowCreate: false });
        return;
      }

      // role === 'admin'
      const org = status.org;
      const renewalDate = org?.current_period_end ? new Date(org.current_period_end).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown';
      const autoRenewOn = !org?.cancel_at_period_end;
      const aiOn = org?.ai_enabled !== false;
      row.innerHTML = `<p class="help-text" style="margin:0 0 6px">Admin of <strong>${escapeHtml(org?.domain || '')}</strong></p>
         <p class="help-text" style="margin:0 0 10px">${autoRenewOn
            ? `Renews <strong>${renewalDate}</strong>. You'll get an email at 3 months, 1 month, and 1 week before renewal.`
            : `Auto-renew is off — access continues through <strong>${renewalDate}</strong>, then your organization's Premium ends and its data is removed.`}</p>
         <button id="enterprise-auto-renew-btn" class="auth-btn" onclick="toggleOrgAutoRenew(${autoRenewOn})">${autoRenewOn ? 'Turn off auto-renew' : 'Turn auto-renew back on'}</button>
         <div id="enterprise-auto-renew-status" class="help-text" style="margin-top:6px"></div>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e0d8">
           <p class="help-text" style="margin:0 0 8px">Anyone with a <strong>${escapeHtml(org?.domain || '')}</strong> email who opens this link gets Premium for free.</p>
           <button class="auth-btn" onclick="createEnterpriseJoinLink()">Get join link</button>
           <div id="enterprise-join-link-output" style="margin-top:8px"></div>
         </div>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e0d8">
           <p class="help-text" style="margin:0 0 8px">AI assistant for members: <strong>${aiOn ? 'On' : 'Off'}</strong></p>
           <button id="enterprise-ai-toggle-btn" class="auth-btn" onclick="toggleOrgAi(${aiOn})">${aiOn ? 'Turn AI off for everyone' : 'Turn AI back on'}</button>
           <div id="enterprise-ai-toggle-status" class="help-text" style="margin-top:6px"></div>
         </div>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e0d8">
           <button class="auth-btn" onclick="openEnterpriseUsageModal()">View member AI usage</button>
         </div>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e0d8">
           <p class="help-text" style="margin:0 0 8px">Workrooms — organize members into classes or teams, each with a manager.</p>
           <div id="enterprise-workrooms-admin"></div>
         </div>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e0d8">
           <p class="help-text" style="margin:0 0 8px">Dataset library — curated multi-table datasets for practicing joins.</p>
           <div id="enterprise-template-list">Loading…</div>
         </div>`;
      renderEnterpriseTemplateList(status.enabledTemplates || []);
      renderWorkroomsSection('enterprise-workrooms-admin', { allowCreate: true });
    }

    async function renderEnterpriseTemplateList(enabledTemplates) {
      const listEl = document.getElementById('enterprise-template-list');
      if (!listEl) return;
      const enabledIds = new Set(enabledTemplates.map((t) => t.id));

      let templates;
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=templates', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
        templates = body.templates;
      } catch (err) {
        listEl.innerHTML = `<p class="help-text" style="margin:0">Couldn't load dataset library: ${escapeHtml(err.message)}</p>`;
        return;
      }

      if (!templates.length) {
        listEl.innerHTML = '<p class="help-text" style="margin:0">No datasets available yet.</p>';
        return;
      }

      listEl.innerHTML = templates.map((t) => {
        const isOn = enabledIds.has(t.id);
        return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
             <span class="help-text" style="margin:0">${escapeHtml(t.name)}</span>
             <button class="auth-btn" onclick="toggleTemplateEnabled('${t.id}', ${isOn})">${isOn ? 'Disable' : 'Enable'}</button>
           </div>`;
      }).join('');
    }

    window.toggleTemplateEnabled = async function(templateId, currentlyOn) {
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/admin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'enable_template', template_id: templateId, enabled: !currentlyOn }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message || `Request failed (${response.status})`);
        }
        await renderSettingsEnterpriseRow();
      } catch (err) {
        console.error('Failed to toggle template:', err);
        alert(`Couldn't update dataset library: ${err.message}`);
      }
    };

    // ---- Workrooms (classes/teams with a manager role) ----
    // Shared between the admin view (sees every workroom in the org, can
    // create new ones) and a manager's own member-settings view (sees only
    // the workroom(s) they manage) — same rendering and roster-edit logic
    // either way, since api/enterprise/workrooms-list.js already scopes
    // which workrooms come back based on the caller's role.

    async function renderWorkroomsSection(containerId, { allowCreate }) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = '<p class="help-text" style="margin:0">Loading…</p>';

      let workrooms;
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=workrooms', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
        workrooms = body.workrooms;
      } catch (err) {
        container.innerHTML = `<p class="help-text" style="margin:0">Couldn't load workrooms: ${escapeHtml(err.message)}</p>`;
        return;
      }

      const createFormHtml = allowCreate ? `
        <div style="margin-bottom:12px">
          <input id="new-workroom-name" type="text" placeholder="Workroom name (e.g. Period 3 Statistics)" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #d8d2c6;border-radius:6px;margin-bottom:6px">
          <select id="new-workroom-manager" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #d8d2c6;border-radius:6px;margin-bottom:6px">
            <option value="">Loading members…</option>
          </select>
          <button class="auth-btn" onclick="createWorkroom()">Create workroom</button>
          <div id="new-workroom-status" class="help-text" style="margin-top:6px"></div>
        </div>` : '';

      const listHtml = workrooms.length
        ? workrooms.map((w) => `
          <div style="margin-bottom:10px;padding:8px;border:1px solid #e5e0d8;border-radius:8px">
            <p class="help-text" style="margin:0 0 4px"><strong>${escapeHtml(w.name)}</strong> — manager: ${escapeHtml(w.manager_email)}</p>
            <div id="workroom-roster-${w.id}">
              ${w.roster.length
                ? w.roster.map((m) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:2px 0">
                    <span>${escapeHtml(m.email)}</span>
                    ${w.manager_id === currentUser?.id ? `<button class="auth-btn" style="padding:2px 8px;font-size:12px" onclick="removeFromWorkroomRoster('${w.id}', '${m.user_id}')">Remove</button>` : ''}
                  </div>`).join('')
                : '<p class="help-text" style="margin:0">No members yet.</p>'}
            </div>
            ${w.manager_id === currentUser?.id ? `
              <div style="margin-top:6px;display:flex;gap:6px">
                <select id="add-roster-select-${w.id}" style="flex:1;padding:4px 6px;font-size:12px;border:1px solid #d8d2c6;border-radius:6px">
                  <option value="">Loading members…</option>
                </select>
                <button class="auth-btn" style="padding:4px 10px;font-size:12px" onclick="addToWorkroomRoster('${w.id}')">Add</button>
              </div>` : ''}
          </div>`).join('')
        : '<p class="help-text" style="margin:0">No workrooms yet.</p>';

      container.innerHTML = createFormHtml + listHtml;

      // Populate every member-picker <select> (the create form's manager
      // picker, plus one add-to-roster picker per workroom this viewer
      // manages) from the same org roster fetch.
      const selectsNeedingMembers = [
        ...(allowCreate ? ['new-workroom-manager'] : []),
        ...workrooms.filter((w) => w.manager_id === currentUser?.id).map((w) => `add-roster-select-${w.id}`),
      ];
      if (!selectsNeedingMembers.length) return;

      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=org_roster', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const body = await response.json();
        const options = (body.members || []).map((m) => `<option value="${m.user_id}">${escapeHtml(m.email)}</option>`).join('');
        for (const selectId of selectsNeedingMembers) {
          const select = document.getElementById(selectId);
          if (select) select.innerHTML = options || '<option value="">No members</option>';
        }
      } catch (err) {
        console.error('Failed to load org roster for picker:', err);
      }
    }

    window.createWorkroom = async function() {
      const nameEl = document.getElementById('new-workroom-name');
      const managerEl = document.getElementById('new-workroom-manager');
      const statusEl = document.getElementById('new-workroom-status');
      const name = nameEl.value.trim();
      const managerUserId = managerEl.value;
      if (!name || !managerUserId) {
        statusEl.textContent = 'Enter a name and pick a manager.';
        return;
      }
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/admin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'create_workroom', name, manager_user_id: managerUserId }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
        await renderWorkroomsSection('enterprise-workrooms-admin', { allowCreate: true });
      } catch (err) {
        console.error('Failed to create workroom:', err);
        statusEl.textContent = `Couldn't create workroom: ${err.message}`;
      }
    };

    window.addToWorkroomRoster = async function(workroomId) {
      const select = document.getElementById(`add-roster-select-${workroomId}`);
      const targetUserId = select?.value;
      if (!targetUserId) return;
      await workroomRosterAction(workroomId, 'add', targetUserId);
    };

    window.removeFromWorkroomRoster = async function(workroomId, targetUserId) {
      await workroomRosterAction(workroomId, 'remove', targetUserId);
    };

    async function workroomRosterAction(workroomId, action, targetUserId) {
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/member-actions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'workroom_roster', workroom_id: workroomId, roster_action: action, user_id: targetUserId }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
        // Re-render whichever section is currently visible — harmless
        // no-op on the container that isn't in the DOM's admin/member branch.
        if (document.getElementById('enterprise-workrooms-admin')) {
          await renderWorkroomsSection('enterprise-workrooms-admin', { allowCreate: true });
        }
        if (document.getElementById('enterprise-workrooms-member')) {
          await renderWorkroomsSection('enterprise-workrooms-member', { allowCreate: false });
        }
      } catch (err) {
        console.error(`Failed to ${action} roster member:`, err);
        alert(`Couldn't update roster: ${err.message}`);
      }
    }

    window.toggleOrgAi = async function(currentlyOn) {
      const btn = document.getElementById('enterprise-ai-toggle-btn');
      const statusEl = document.getElementById('enterprise-ai-toggle-status');
      if (btn) btn.disabled = true;
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/admin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'toggle_ai', enabled: !currentlyOn }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message || `Request failed (${response.status})`);
        }
        await renderSettingsEnterpriseRow();
      } catch (err) {
        console.error('Failed to toggle org AI setting:', err);
        if (statusEl) statusEl.textContent = `Couldn't update: ${err.message}`;
        if (btn) btn.disabled = false;
      }
    };

    window.openEnterpriseUsageModal = async function() {
      document.getElementById('enterprise-usage-modal').hidden = false;
      const body = document.getElementById('enterprise-usage-body');
      body.innerHTML = '<p class="help-text" style="margin:0">Loading…</p>';
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=usage', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result?.error?.message || `Request failed (${response.status})`);
        }
        if (!result.members.length) {
          body.innerHTML = '<p class="help-text" style="margin:0">No members yet.</p>';
          return;
        }
        const rows = result.members.map((m) => `<tr>
             <td>${escapeHtml(m.email)}</td>
             <td>${escapeHtml(m.role)}</td>
             <td style="text-align:right">${m.count_24h}</td>
             <td style="text-align:right">${m.count_7d}</td>
           </tr>`).join('');
        body.innerHTML = `<table class="usage-table" style="width:100%;border-collapse:collapse;font-size:13px">
             <thead><tr><th style="text-align:left">Member</th><th style="text-align:left">Role</th><th style="text-align:right">Last 24h</th><th style="text-align:right">Last 7d</th></tr></thead>
             <tbody>${rows}</tbody>
           </table>`;
      } catch (err) {
        console.error('Failed to load usage:', err);
        body.innerHTML = `<p class="help-text" style="margin:0">Couldn't load usage: ${escapeHtml(err.message)}</p>`;
      }
    };

    window.closeEnterpriseUsageModal = function() {
      document.getElementById('enterprise-usage-modal').hidden = true;
    };

    window.createEnterpriseJoinLink = async function() {
      const outputEl = document.getElementById('enterprise-join-link-output');
      outputEl.innerHTML = '<p class="help-text" style="margin:0">Generating…</p>';
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/admin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'create_join_link' }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body?.error?.message || `Request failed (${response.status})`);
        }
        outputEl.innerHTML = `<input type="text" readonly value="${escapeAttr(body.url)}" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #d8d2c6;border-radius:6px;margin-bottom:6px" onclick="this.select()">
           <button class="auth-btn" onclick="navigator.clipboard.writeText('${escapeHtml(body.url)}').then(() => { const s = document.getElementById('enterprise-join-link-copied'); if (s) { s.hidden = false; setTimeout(() => s.hidden = true, 2000); } })">Copy link</button>
           <span id="enterprise-join-link-copied" class="help-text" hidden style="margin-left:8px">Copied!</span>`;
      } catch (err) {
        console.error('Failed to create join link:', err);
        outputEl.innerHTML = `<p class="help-text" style="margin:0">Couldn't generate a link: ${escapeHtml(err.message)}</p>`;
      }
    };

    window.toggleOrgAutoRenew = async function(currentlyOn) {
      const btn = document.getElementById('enterprise-auto-renew-btn');
      const statusEl = document.getElementById('enterprise-auto-renew-status');
      if (btn) btn.disabled = true;
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/admin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'toggle_auto_renew', enabled: !currentlyOn }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message || `Request failed (${response.status})`);
        }
        await renderSettingsEnterpriseRow();
      } catch (err) {
        console.error('Failed to toggle auto-renew:', err);
        if (statusEl) statusEl.textContent = `Couldn't update auto-renew: ${err.message}`;
        if (btn) btn.disabled = false;
      }
    };

    function markWorkspaceDirty() {
      workspaceSynced = false;
      updateCloudButtons();
    }

    function markWorkspaceSynced() {
      workspaceSynced = true;
      updateCloudButtons();
    }

    function updateCloudButtons() {
      const saveCsvBtn = document.getElementById('save-csv-btn');
      saveCsvBtn.hidden = !(currentUser && tables.length > 0);
      if (!saveCsvBtn.hidden) {
        saveCsvBtn.disabled = false;
        saveCsvBtn.title = '';
        saveCsvBtn.classList.toggle('save-btn-synced', workspaceSynced);
        saveCsvBtn.classList.toggle('save-btn-dirty', !workspaceSynced);
        saveCsvBtn.textContent = workspaceSynced ? 'Synced to Cloud' : 'Click save to save changes to cloud';
      }
      document.getElementById('save-session-btn').hidden = !(currentUser && chatHistory.length > 0);
    }

    // ---- Home view: upload drop zone + saved workspaces ----

    const UPLOAD_EXTENSIONS = /\.(csv|json|ndjson|jsonl)$/i;

    function initHome() {
      setActiveView('home');
      renderDashboard();
      syncChartAccess();

      const home = document.getElementById('home-view');
      const zone = document.getElementById('home-dropzone');
      let dragDepth = 0;

      zone.addEventListener('click', openFilePicker);

      // The whole home view accepts drops (not just the zone), so a file
      // released a few pixels off-target still uploads instead of the
      // browser navigating away to open it.
      home.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        zone.classList.add('is-dragover');
      });
      home.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      home.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) zone.classList.remove('is-dragover');
      });
      home.addEventListener('drop', (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        dragDepth = 0;
        zone.classList.remove('is-dragover');
        uploadFromHome(Array.from(e.dataTransfer.files));
      });

      // ?auth=signin|signup opens the account modal on load (linked from
      // /welcome's header).
      const params = new URLSearchParams(window.location.search);
      const authParam = params.get('auth');
      if (authParam === 'signin' || authParam === 'signup') {
        params.delete('auth');
        const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
        window.history.replaceState({}, '', clean);
        // Deferred until the session check settles: a returning signed-in
        // visitor shouldn't get a sign-in prompt.
        setTimeout(() => { if (!currentUser) openAccountModal(authParam); }, 400);
      }
    }

    function uploadFromHome(files) {
      const accepted = files.filter(f => UPLOAD_EXTENSIONS.test(f.name));
      if (!accepted.length) {
        setHomeUploadMessage('Synth reads .csv, .json, .ndjson, and .jsonl files.', true);
        return;
      }
      setHomeUploadMessage('');
      window.uploadCSV({ target: { files: accepted } });
    }

    function setHomeUploadMessage(text, isError) {
      const el = document.getElementById('home-upload-message');
      el.textContent = text;
      el.classList.toggle('error', !!isError);
    }

    window.openFilePicker = function() {
      const input = document.getElementById('file-upload');
      // Cleared first so picking the same file again (after heading back
      // home) still fires a change event.
      input.value = '';
      setHomeUploadMessage('');
      input.click();
    };

    // Exactly one of home-view / app-view is visible. The header's
    // "Workspaces" button only makes sense from inside the app.
    function setActiveView(view) {
      const onHome = view === 'home';
      document.getElementById('home-view').hidden = !onHome;
      document.getElementById('app-view').hidden = onHome;
      document.getElementById('dashboard-nav-btn').hidden = onHome;
      document.getElementById('home-return-btn').hidden = !(onHome && hasLoadedWorkspace());
    }

    function tableToCSVBlob(tableName) {
      const result = db.exec(`SELECT * FROM "${tableName}"`);
      const escapeCsv = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      if (!result.length) return new Blob([''], { type: 'text/csv' });
      const { columns, values } = result[0];
      const lines = [columns.map(escapeCsv).join(',')];
      values.forEach(row => lines.push(row.map(escapeCsv).join(',')));
      return new Blob([lines.join('\n')], { type: 'text/csv' });
    }

    window.saveCurrentCSV = async function() {
      if (!sb || !currentUser || !tables.length) return;
      const btn = document.getElementById('save-csv-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const workspaceName = currentWorkspaceName || tables[0].fileName || 'Untitled workspace';

        let workspaceId = currentWorkspaceId;
        if (workspaceId) {
          const { error: wsErr } = await sb.from('workspaces')
            .update({ name: workspaceName, updated_at: new Date().toISOString() })
            .eq('id', workspaceId);
          if (wsErr) throw wsErr;
        } else {
          const { data: ws, error: wsErr } = await sb.from('workspaces')
            .insert({ user_id: currentUser.id, name: workspaceName })
            .select().single();
          if (wsErr) throw wsErr;
          workspaceId = ws.id;
        }

        // Replace this workspace's rows/files wholesale rather than diffing
        // — simpler to keep correct, and guarantees a renamed or removed
        // table never leaves an orphaned row or Storage object behind.
        const { error: delDsErr } = await sb.from('datasets').delete().eq('workspace_id', workspaceId);
        if (delDsErr) throw delDsErr;
        await sb.from('workspace_relationships').delete().eq('workspace_id', workspaceId);

        const { data: oldFiles } = await sb.storage.from('csvs').list(`${currentUser.id}/${workspaceId}`);
        if (oldFiles && oldFiles.length) {
          await sb.storage.from('csvs').remove(oldFiles.map(f => `${currentUser.id}/${workspaceId}/${f.name}`));
        }

        for (const t of tables) {
          const blob = tableToCSVBlob(t.name);
          const path = `${currentUser.id}/${workspaceId}/${t.name}.csv`;
          const { error: upErr } = await sb.storage.from('csvs').upload(path, blob, { upsert: true, contentType: 'text/csv' });
          if (upErr) throw upErr;

          const { error: dsErr } = await sb.from('datasets').insert({
            user_id: currentUser.id,
            workspace_id: workspaceId,
            filename: t.fileName,
            table_name: t.name,
            storage_path: path,
            row_count: t.rowCount,
            columns: t.columns,
          });
          if (dsErr) throw dsErr;
        }

        const confirmedRels = relationships.filter(r => r.confirmed);
        if (confirmedRels.length) {
          const { error: relErr } = await sb.from('workspace_relationships').insert(
            confirmedRels.map(r => ({
              workspace_id: workspaceId,
              from_table: r.fromTable,
              from_column: r.fromColumn,
              to_table: r.toTable,
              to_column: r.toColumn,
              confirmed: true,
              cardinality: r.cardinality || null,
            }))
          );
          if (relErr) throw relErr;
        }

        currentWorkspaceId = workspaceId;
        currentWorkspaceName = workspaceName;
        markWorkspaceSynced();
      } catch (err) {
        alert('Failed to save workspace: ' + err.message);
        updateCloudButtons();
      } finally {
        btn.disabled = false;
      }
    };

    window.saveCurrentSession = async function() {
      if (!sb || !currentUser || chatHistory.length === 0) return;
      const btn = document.getElementById('save-session-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        // A session with nothing to reopen isn't useful — make sure the
        // workspace itself is saved first.
        if (!currentWorkspaceId) {
          await window.saveCurrentCSV();
        }
        if (!currentWorkspaceId) throw new Error('Save the workspace first');

        const firstUserMsg = chatHistory.find(m => m.role === 'user');
        const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : 'Untitled session';

        const { data: session, error: sessionError } = await sb
          .from('chat_sessions')
          .insert({ user_id: currentUser.id, workspace_id: currentWorkspaceId, title })
          .select()
          .single();
        if (sessionError) throw sessionError;

        const rows = chatHistory.map(m => ({ session_id: session.id, role: m.role, content: m.content }));
        const { error: messagesError } = await sb.from('chat_messages').insert(rows);
        if (messagesError) throw messagesError;

        btn.textContent = 'Saved ✓';
      } catch (err) {
        alert('Failed to save session: ' + err.message);
        btn.textContent = 'Save session';
      } finally {
        btn.disabled = false;
      }
    };

    window.openCloudPanel = async function() {
      if (!sb || !currentUser) return;
      document.getElementById('cloud-modal').hidden = false;
      const dsList = document.getElementById('cloud-datasets-list');
      const sessList = document.getElementById('cloud-sessions-list');
      dsList.innerHTML = 'Loading...';
      sessList.innerHTML = 'Loading...';

      try {
        const { data: workspaces, error: dsError } = await sb
          .from('workspaces').select('*, datasets(id, row_count)').order('updated_at', { ascending: false });
        if (dsError) throw dsError;
        dsList.innerHTML = (workspaces && workspaces.length)
          ? workspaces.map(w => {
              const tableCount = w.datasets.length;
              const totalRows = w.datasets.reduce((sum, d) => sum + (d.row_count || 0), 0);
              return `
            <div class="cloud-item">
              <span>${escapeHtml(w.name)} <span class="cloud-meta">(${tableCount} table${tableCount === 1 ? '' : 's'}, ${totalRows.toLocaleString()} rows, updated ${new Date(w.updated_at).toLocaleDateString()})</span></span>
              <button class="cloud-load-btn" onclick="loadCloudWorkspace('${w.id}')">Load</button>
            </div>`;
            }).join('')
          : '<div class="empty">No saved workspaces yet.</div>';
      } catch (err) {
        // A failed request used to fall through to the same "no saved
        // workspaces" empty state as a genuinely empty list, hiding real
        // errors (a bad connection, an expired session) behind what looked
        // like an account with nothing saved.
        dsList.innerHTML = `<div class="empty">Couldn't load workspaces: ${escapeHtml(err.message)}</div>`;
      }

      try {
        const { data: sessions, error: sessError } = await sb
          .from('chat_sessions').select('*').order('created_at', { ascending: false });
        if (sessError) throw sessError;
        sessList.innerHTML = (sessions && sessions.length)
          ? sessions.map(s => `
            <div class="cloud-item">
              <span>${escapeHtml(s.title)} <span class="cloud-meta">(${new Date(s.created_at).toLocaleDateString()})</span></span>
              <button class="cloud-load-btn" onclick="loadCloudSession('${s.id}')">Load</button>
            </div>`).join('')
          : '<div class="empty">No saved sessions yet.</div>';
      } catch (err) {
        sessList.innerHTML = `<div class="empty">Couldn't load sessions: ${escapeHtml(err.message)}</div>`;
      }

      // Dataset Library — only shown to org members whose org has enabled
      // at least one template (most users have no org at all, so this stays
      // hidden for them rather than showing an empty section).
      const librarySection = document.getElementById('cloud-library-section');
      const libraryList = document.getElementById('cloud-library-list');
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=org_status', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const status = await response.json();
        const enabledTemplates = response.ok ? (status.enabledTemplates || []) : [];
        if (enabledTemplates.length) {
          librarySection.hidden = false;
          libraryList.innerHTML = enabledTemplates.map((t) => `
            <div class="cloud-item">
              <span>${escapeHtml(t.name)}</span>
              <button class="cloud-load-btn" onclick="loadEnterpriseTemplate('${t.id}', '${escapeHtml(t.name)}')">Load</button>
            </div>`).join('');
        } else {
          librarySection.hidden = true;
        }
      } catch (err) {
        // Non-critical section — fail silently rather than block the two
        // lists above, which is the actual reason someone opened this panel.
        librarySection.hidden = true;
      }
    };

    window.closeCloudPanel = function() {
      document.getElementById('cloud-modal').hidden = true;
    };

    // ---- Dashboard (any signed-in account's home base: every saved workspace, at a glance) ----

    let pendingDeleteWorkspaceId = null;
    let pendingOpenWorkspaceId = null;
    let pendingOpenSessionId = null;

    function timeAgo(dateStr) {
      const diffMs = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d ago`;
      return new Date(dateStr).toLocaleDateString();
    }

    window.openHome = function() {
      setActiveView('home');
      renderDashboard();
    };

    window.returnToWorkspace = function() {
      if (!hasLoadedWorkspace()) return;
      setActiveView('app');
      // A rename on the home view (of the workspace that's currently open)
      // only touches currentWorkspaceName in memory. Refresh so the
      // toolbar's workspace switcher pill picks it up.
      renderTableChips();
    };

    // Called on every auth change. Only re-renders if home is showing;
    // openHome() renders fresh whenever it's reopened anyway.
    window.refreshHomeWorkspaces = function() {
      if (!document.getElementById('home-view').hidden) renderDashboard();
      updateHomeSaveCard();
    };

    function updateHomeSaveCard() {
      const signedIn = !!currentUser;
      document.getElementById('home-save-title').textContent = signedIn
        ? 'Your work saves to your account'
        : 'Sign in to save your work';
      document.getElementById('home-save-body').textContent = signedIn
        ? 'Use Save to cloud in any workspace to keep its files and chat sessions here.'
        : 'Open your files, chats, and queries on any device. An account also turns on the AI tools and charts.';
      document.getElementById('home-save-btn').hidden = signedIn;
      document.getElementById('home-new-workspace-btn').hidden = !signedIn;
    }

    function homeEmptyState({ icon, title, body, actions = '', isError = false }) {
      return `
        <div class="home-empty${isError ? ' is-error' : ''}">
          <div class="home-empty-icon"><i class="ph ${icon}" aria-hidden="true"></i></div>
          <div class="home-empty-title">${title}</div>
          <p class="home-empty-body">${body}</p>
          ${actions ? `<div class="home-empty-actions">${actions}</div>` : ''}
        </div>`;
    }

    async function renderDashboard() {
      const body = document.getElementById('dashboard-body');
      updateHomeSaveCard();

      if (!currentUser || !sb) {
        body.innerHTML = homeEmptyState({
          icon: 'ph-folders',
          title: 'Your saved workspaces live here',
          body: 'Sign in to see your saved files, chat sessions, and queries from any device.',
          actions: `<button type="button" class="home-dark-btn" onclick="openAccountModal('signin')">Sign in</button>
                    <button type="button" class="home-text-link" onclick="openAccountModal('signup')">Create an account</button>`,
        });
        return;
      }

      body.innerHTML = '<div class="ws-skeleton"></div><div class="ws-skeleton"></div>';

      let workspaces, error;
      try {
        ({ data: workspaces, error } = await sb
          .from('workspaces')
          .select('*, datasets(id, table_name, row_count), chat_sessions(id, title, created_at)')
          .order('updated_at', { ascending: false }));
      } catch (err) {
        // A rejected fetch (network failure, blocked request) throws
        // instead of resolving with {error}.
        error = err;
      }

      // Signed out while the request was in flight.
      if (!currentUser) return renderDashboard();

      if (error) {
        body.innerHTML = homeEmptyState({
          icon: 'ph-warning-circle',
          title: "Couldn't load your workspaces",
          body: escapeHtml(error.message || 'Check your connection and try again.'),
          actions: `<button type="button" class="home-dark-btn" onclick="renderDashboard()"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i> Try again</button>`,
          isError: true,
        });
        return;
      }

      if (!workspaces || !workspaces.length) {
        body.innerHTML = homeEmptyState({
          icon: 'ph-folders',
          title: 'No saved workspaces yet',
          body: 'Upload a file, then use Save to cloud inside the workspace to keep it here.',
        });
        return;
      }

      body.innerHTML = workspaces.map(w => {
        const totalRows = w.datasets.reduce((sum, d) => sum + (d.row_count || 0), 0);
        const tableChips = w.datasets.map(d => `<span class="workspace-table-chip">${escapeHtml(d.table_name)}</span>`).join('');
        const sessions = (w.chat_sessions || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const sessionsHtml = sessions.length ? `
          <div class="workspace-sessions">
            <div class="workspace-sessions-label">Saved chats</div>
            ${sessions.map(s => `
              <div class="workspace-session-row">
                <span class="workspace-session-title" title="${escapeAttr(s.title)}">${escapeHtml(s.title)}</span>
                <button onclick="requestOpenSession('${s.id}')">Open</button>
              </div>
            `).join('')}
          </div>` : '';

        return `
          <div class="workspace-card" data-workspace="${w.id}">
            <div class="workspace-card-head">
              <span class="workspace-name" data-workspace-name="${w.id}">${escapeHtml(w.name)}</span>
              <button class="workspace-rename-btn" title="Rename" onclick="startRenameWorkspace('${w.id}')">✎</button>
            </div>
            <div class="workspace-meta">${w.datasets.length} table${w.datasets.length === 1 ? '' : 's'} &middot; ${totalRows.toLocaleString()} rows &middot; updated ${timeAgo(w.updated_at)}</div>
            <div class="workspace-tables">${tableChips}</div>
            ${sessionsHtml}
            <div class="workspace-card-actions">
              <button class="workspace-open-btn" onclick="requestOpenWorkspace('${w.id}')">Open</button>
              <button class="workspace-delete-btn" onclick="openDeleteWorkspaceModal('${w.id}', '${escapeHtml(w.name).replace(/'/g, "\\'")}')">Delete</button>
            </div>
          </div>
        `;
      }).join('');
    }
    window.renderDashboard = renderDashboard;

    window.startRenameWorkspace = function(workspaceId) {
      if (!requireFeature('tableRename')) return;
      const label = document.querySelector(`.workspace-name[data-workspace-name="${CSS.escape(workspaceId)}"]`);
      if (!label) return;
      const original = label.textContent;

      label.contentEditable = 'true';
      label.focus();
      document.execCommand('selectAll', false, null);

      const commit = async () => {
        label.removeAttribute('contenteditable');
        const newName = label.textContent.trim();
        if (!newName || newName === original) { label.textContent = original; return; }
        const { error } = await sb.from('workspaces').update({ name: newName, updated_at: new Date().toISOString() }).eq('id', workspaceId);
        if (error) {
          alert('Failed to rename: ' + error.message);
          label.textContent = original;
          return;
        }
        if (currentWorkspaceId === workspaceId) currentWorkspaceName = newName;
      };

      label.addEventListener('blur', commit, { once: true });
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
        if (e.key === 'Escape') { label.textContent = original; label.blur(); }
      });
    };

    window.openDeleteWorkspaceModal = function(workspaceId, name) {
      pendingDeleteWorkspaceId = workspaceId;
      document.getElementById('delete-workspace-name').textContent = `"${name}"`;
      document.getElementById('delete-workspace-modal').hidden = false;
    };

    window.closeDeleteWorkspaceModal = function() {
      document.getElementById('delete-workspace-modal').hidden = true;
      pendingDeleteWorkspaceId = null;
    };

    window.confirmDeleteWorkspace = async function() {
      const workspaceId = pendingDeleteWorkspaceId;
      if (!workspaceId) return;
      document.getElementById('delete-workspace-modal').hidden = true;

      try {
        // Deleting the workspaces row cascades datasets/relationships/
        // chat_sessions at the DB level, but Storage objects are a
        // separate system entirely and are NOT touched by that cascade —
        // confirmed directly in testing. They have to be removed here,
        // explicitly, or they'd sit in the bucket forever as orphans.
        const prefix = `${currentUser.id}/${workspaceId}`;
        const { data: files } = await sb.storage.from('csvs').list(prefix);
        if (files && files.length) {
          await sb.storage.from('csvs').remove(files.map(f => `${prefix}/${f.name}`));
        }

        const { error } = await sb.from('workspaces').delete().eq('id', workspaceId);
        if (error) throw error;

        if (currentWorkspaceId === workspaceId) {
          currentWorkspaceId = null;
          currentWorkspaceName = null;
        }

        await renderDashboard();
      } catch (err) {
        alert('Failed to delete workspace: ' + err.message);
      } finally {
        pendingDeleteWorkspaceId = null;
      }
    };

    // Opening a different workspace than what's currently loaded replaces
    // it entirely — warn first rather than silently discarding whatever's
    // in the app right now (no fine-grained "has this actually changed
    // since last save" tracking exists yet, so this errs toward always
    // confirming rather than risking a silent loss).
    function hasLoadedWorkspace() {
      return csvLoaded && tables.length > 0;
    }

    window.requestOpenWorkspace = function(workspaceId) {
      if (hasLoadedWorkspace()) {
        pendingOpenWorkspaceId = workspaceId;
        pendingOpenSessionId = null;
        document.getElementById('switch-workspace-modal').hidden = false;
        return;
      }
      window.loadCloudWorkspace(workspaceId);
    };

    window.requestOpenSession = function(sessionId) {
      if (hasLoadedWorkspace()) {
        pendingOpenSessionId = sessionId;
        pendingOpenWorkspaceId = null;
        document.getElementById('switch-workspace-modal').hidden = false;
        return;
      }
      window.loadCloudSession(sessionId);
    };

    window.closeSwitchWorkspaceModal = function() {
      document.getElementById('switch-workspace-modal').hidden = true;
      pendingOpenWorkspaceId = null;
      pendingOpenSessionId = null;
    };

    window.confirmSwitchWorkspace = function() {
      document.getElementById('switch-workspace-modal').hidden = true;
      if (pendingOpenWorkspaceId) window.loadCloudWorkspace(pendingOpenWorkspaceId);
      else if (pendingOpenSessionId) window.loadCloudSession(pendingOpenSessionId);
      pendingOpenWorkspaceId = null;
      pendingOpenSessionId = null;
    };

    window.openHelpPanel = function() {
      document.getElementById('help-modal').hidden = false;
    };

    window.closeHelpPanel = function() {
      document.getElementById('help-modal').hidden = true;
    };

    window.openEnterpriseEntry = async function() {
      if (!currentUser) {
        openEnterpriseAccessModal();
        return;
      }
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=org_status', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        const status = response.ok ? await response.json() : { role: null, is_manager: false };
        lastEnterpriseStatus = status;
        if (status.role === 'admin' || status.is_manager) {
          openEnterpriseAccessModal();
        } else if (status.role) {
          openSettingsPanel();
        } else {
          openEnterpriseAccessModal();
        }
      } catch (err) {
        console.error('Failed to check Enterprise status:', err);
        lastEnterpriseStatus = null;
        openEnterpriseAccessModal();
      }
    };

    // ---- Enterprise access modal: sign in to an org you already belong to,
    // or redeem a join code, entirely on this page. Creating a NEW
    // organization is deliberately not offered here — that only happens on
    // synth-sql.com/enterprise (the "Explore Synth Enterprise" link below),
    // which also holds the admin/manager dashboards this modal has no room
    // for. ----
    let lastEnterpriseStatus = null;
    let enterpriseAccessAuthMode = 'signin';
    // Mirrors pendingConfirmEmail for the header auth panel — set while this
    // modal is waiting on a signup confirmation code.
    let enterpriseConfirmEmail = null;

    window.openEnterpriseAccessModal = function() {
      document.getElementById('enterprise-access-modal').hidden = false;
      renderEnterpriseAccessModal();
    };

    window.closeEnterpriseAccessModal = function() {
      document.getElementById('enterprise-access-modal').hidden = true;
    };

    function renderEnterpriseAccessModal() {
      const body = document.getElementById('enterprise-access-body');

      if (enterpriseConfirmEmail) {
        body.innerHTML = `
          <p class="help-text" style="margin:0 0 12px">We sent a confirmation code to ${escapeHtml(enterpriseConfirmEmail)}. Enter it below to finish creating your account.</p>
          <input type="text" id="ent-confirm-code" class="auth-input auth-input-block" placeholder="Confirmation code" inputmode="numeric" autocomplete="one-time-code">
          <button class="auth-btn auth-btn-primary" style="width:100%;margin-top:10px" id="ent-confirm-submit">Confirm</button>
          <div class="auth-confirm-links">
            <a href="#" id="ent-confirm-resend">Resend code</a>
            <a href="#" id="ent-confirm-back">Use a different email</a>
          </div>
          <div id="ent-confirm-msg" class="auth-message"></div>
        `;
        document.getElementById('ent-confirm-submit').onclick = submitEnterpriseConfirmCode;
        document.getElementById('ent-confirm-resend').onclick = (e) => { e.preventDefault(); resendEnterpriseConfirmCode(); };
        document.getElementById('ent-confirm-back').onclick = (e) => {
          e.preventDefault();
          enterpriseConfirmEmail = null;
          enterpriseAccessAuthMode = 'signup';
          renderEnterpriseAccessModal();
        };
        document.getElementById('ent-confirm-code').focus();
        return;
      }

      if (!currentUser) {
        body.innerHTML = `
          <div class="auth-panel-tabs" style="margin-bottom:12px">
            <button type="button" class="auth-panel-tab ${enterpriseAccessAuthMode === 'signin' ? 'is-active' : ''}" id="ent-tab-signin">Sign in</button>
            <button type="button" class="auth-panel-tab ${enterpriseAccessAuthMode === 'signup' ? 'is-active' : ''}" id="ent-tab-signup">Sign up</button>
          </div>
          <input type="email" id="ent-email" class="auth-input auth-input-block" placeholder="you@example.com" autocomplete="email">
          <input type="password" id="ent-password" class="auth-input auth-input-block" style="margin-top:8px" placeholder="Password" autocomplete="current-password">
          <button class="auth-btn auth-btn-primary" style="width:100%;margin-top:10px" id="ent-auth-submit">Sign in</button>
          <div id="ent-auth-msg" class="auth-message"></div>
          <p class="help-text" style="margin:12px 0 0">Have a join code? Sign in above, then it'll ask for it next.</p>
        `;
        const setMode = (mode) => {
          enterpriseAccessAuthMode = mode;
          document.getElementById('ent-tab-signin').classList.toggle('is-active', mode === 'signin');
          document.getElementById('ent-tab-signup').classList.toggle('is-active', mode === 'signup');
          document.getElementById('ent-auth-submit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
        };
        document.getElementById('ent-tab-signin').onclick = () => setMode('signin');
        document.getElementById('ent-tab-signup').onclick = () => setMode('signup');
        document.getElementById('ent-auth-submit').onclick = submitEnterpriseAccessAuth;
        return;
      }

      if (lastEnterpriseStatus?.role === 'admin' || lastEnterpriseStatus?.is_manager) {
        body.innerHTML = `
          <p class="help-text" style="margin:0 0 14px">Admins and workroom managers manage Synth Enterprise at <strong>synth-sql.com/enterprise</strong>. There's nothing to do here.</p>
          <button class="auth-btn auth-btn-enterprise" style="width:100%" onclick="window.open('/enterprise', '_blank')">Open synth-sql.com/enterprise</button>
        `;
        return;
      }

      if (lastEnterpriseStatus?.role === 'member') {
        body.innerHTML = `<p class="help-text" style="margin:0">You're already part of <strong>${escapeHtml(lastEnterpriseStatus.org?.domain || 'your organization')}</strong>. Premium is active on your account.</p>`;
        return;
      }

      // Signed in, not yet in an org: offer the join-code field.
      body.innerHTML = `
        <p class="help-text" style="margin:0 0 10px">Signed in as ${escapeHtml(currentUser.email)}.</p>
        <input type="text" id="ent-join-token" class="auth-input auth-input-block" placeholder="Paste your join code">
        <button class="auth-btn auth-btn-primary" style="width:100%;margin-top:10px" id="ent-join-submit">Join organization</button>
        <div id="ent-join-msg" class="auth-message"></div>
      `;
      document.getElementById('ent-join-submit').onclick = submitEnterpriseJoinCode;
    }

    async function submitEnterpriseAccessAuth() {
      const email = document.getElementById('ent-email').value.trim();
      const password = document.getElementById('ent-password').value;
      const msgEl = document.getElementById('ent-auth-msg');
      const submitBtn = document.getElementById('ent-auth-submit');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msgEl.textContent = 'Enter a valid email.'; return; }
      if (password.length < 8) { msgEl.textContent = 'Password must be at least 8 characters.'; return; }
      if (submitBtn.disabled) return;

      submitBtn.disabled = true;
      msgEl.textContent = enterpriseAccessAuthMode === 'signin' ? 'Signing in...' : 'Creating account...';
      const { data, error } = enterpriseAccessAuthMode === 'signin'
        ? await sb.auth.signInWithPassword({ email, password })
        : await sb.auth.signUp({ email, password });

      if (error) { msgEl.textContent = error.message; submitBtn.disabled = false; return; }

      if (enterpriseAccessAuthMode === 'signup' && !data.session) {
        enterpriseConfirmEmail = email;
        renderEnterpriseAccessModal();
        return;
      }

      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/status?op=org_status', {
          headers: { 'Authorization': `Bearer ${session?.access_token || ''}` },
        });
        lastEnterpriseStatus = response.ok ? await response.json() : null;
      } catch (err) {
        console.error('Failed to load Enterprise status after sign-in:', err);
        lastEnterpriseStatus = null;
      }
      renderEnterpriseAccessModal();
    }

    async function submitEnterpriseConfirmCode() {
      const token = document.getElementById('ent-confirm-code').value.trim();
      const msgEl = document.getElementById('ent-confirm-msg');
      const submitBtn = document.getElementById('ent-confirm-submit');
      if (!token) { msgEl.textContent = 'Enter the code from your email.'; return; }
      if (submitBtn.disabled) return;

      submitBtn.disabled = true;
      msgEl.textContent = 'Confirming...';
      const { data, error } = await sb.auth.verifyOtp({ email: enterpriseConfirmEmail, token, type: 'signup' });

      if (error) {
        msgEl.textContent = error.message;
        submitBtn.disabled = false;
        return;
      }

      enterpriseConfirmEmail = null;
      // Set currentUser directly from verifyOtp's own return value rather
      // than waiting on onAuthStateChange's listener to fire — that listener
      // does the same assignment, just not necessarily before this
      // synchronous re-render runs, which would otherwise flash the
      // signed-out form for a frame.
      currentUser = data.user || currentUser;
      lastEnterpriseStatus = null;
      renderEnterpriseAccessModal();
    }

    async function resendEnterpriseConfirmCode() {
      const msgEl = document.getElementById('ent-confirm-msg');
      const resendLink = document.getElementById('ent-confirm-resend');
      if (resendLink.classList.contains('is-disabled')) return;
      msgEl.className = 'auth-message';
      msgEl.textContent = 'Sending a new code...';
      resendLink.classList.add('is-disabled');
      const { error } = await sb.auth.resend({ type: 'signup', email: enterpriseConfirmEmail });
      if (error) {
        msgEl.classList.add('is-error');
        msgEl.textContent = error.message;
      } else {
        msgEl.textContent = 'New code sent.';
      }
      resendLink.classList.remove('is-disabled');
    }

    async function submitEnterpriseJoinCode() {
      const token = document.getElementById('ent-join-token').value.trim();
      const msgEl = document.getElementById('ent-join-msg');
      const submitBtn = document.getElementById('ent-join-submit');
      if (!token) { msgEl.textContent = 'Enter a join code.'; return; }
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
      msgEl.textContent = 'Joining...';
      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/member-actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || ''}` },
          body: JSON.stringify({ op: 'join', token }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
        msgEl.classList.remove('is-error');
        msgEl.textContent = `Joined ${body.org?.name || 'your organization'}. Premium is now active.`;
        refreshPremiumStatus();
        setTimeout(closeEnterpriseAccessModal, 1400);
      } catch (err) {
        msgEl.classList.add('is-error');
        msgEl.textContent = err.message;
        submitBtn.disabled = false;
      }
    }

    // ---- Saved queries: per-CSV list, kept in this browser's localStorage ----

    const SAVED_QUERIES_KEY = 'synth_saved_queries_v1';
    let editingQueryId = null;
    let selectedLoadQueryId = null;
    let queryPendingDelete = null;

    function getSavedQueriesStore() {
      try {
        return JSON.parse(localStorage.getItem(SAVED_QUERIES_KEY) || '{}');
      } catch {
        return {};
      }
    }

    function setSavedQueriesStore(store) {
      try {
        localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(store));
        return true;
      } catch (err) {
        console.error('Failed to save query:', err);
        alert('Could not save this query. Your browser may be blocking local storage (e.g. private browsing mode).');
        return false;
      }
    }

    // Saved queries are keyed per-workspace so Save Query still works after
    // loading a workspace from the cloud, where there's no local File
    // object (currentCSVFile is null — see loadCloudWorkspace) but there is
    // a stable currentWorkspaceId. Falls back to the local file's name for
    // a CSV that's never been saved to the cloud.
    function currentCSVKey() {
      if (currentWorkspaceId) return `ws:${currentWorkspaceId}`;
      return currentCSVFile ? currentCSVFile.name : null;
    }

    function getSavedQueriesForCurrentCSV() {
      const key = currentCSVKey();
      if (!key) return [];
      const store = getSavedQueriesStore();
      return store[key] || [];
    }

    window.openSaveQueryModal = function() {
      editingQueryId = null;
      document.getElementById('save-query-modal-title').textContent = 'Save Query';
      document.getElementById('save-query-title-input').value = '';
      document.getElementById('save-query-sql-input').value = document.getElementById('query-input').value;
      document.getElementById('save-query-desc-input').value = '';
      document.getElementById('save-query-desc-count').textContent = '0';
      document.getElementById('save-query-modal').hidden = false;
      document.getElementById('save-query-title-input').focus();
    };

    window.closeSaveQueryModal = function() {
      document.getElementById('save-query-modal').hidden = true;
      editingQueryId = null;
    };

    // Lite Mode can still open and fill out Save Query — it's only gated
    // at the moment of actually saving, so nothing gets thrown away. The
    // in-progress form is captured here and restored by
    // resumePendingSaveQuery() once handleAuthChange sees a session.
    let pendingSaveQueryDraft = null;

    function resumePendingSaveQuery() {
      const draft = pendingSaveQueryDraft;
      if (!draft) return;
      pendingSaveQueryDraft = null;
      document.getElementById('signin-required-modal').hidden = true;
      editingQueryId = draft.editingQueryId;
      document.getElementById('save-query-modal-title').textContent = draft.modalTitle;
      document.getElementById('save-query-title-input').value = draft.title;
      document.getElementById('save-query-sql-input').value = draft.sql;
      document.getElementById('save-query-desc-input').value = draft.description;
      document.getElementById('save-query-desc-count').textContent = String(draft.description.length);
      document.getElementById('save-query-modal').hidden = false;
    }

    window.submitSaveQuery = function() {
      if (!canUseFeature('saveQuery')) {
        pendingSaveQueryDraft = {
          editingQueryId,
          modalTitle: document.getElementById('save-query-modal-title').textContent,
          title: document.getElementById('save-query-title-input').value,
          sql: document.getElementById('save-query-sql-input').value,
          description: document.getElementById('save-query-desc-input').value,
        };
        document.getElementById('save-query-modal').hidden = true;
        openSigninRequiredModal();
        return;
      }

      const key = currentCSVKey();
      if (!key) { alert('Could not save this query — no CSV or workspace is loaded.'); return; }

      const titleInput = document.getElementById('save-query-title-input');
      const sqlInput = document.getElementById('save-query-sql-input');
      const title = titleInput.value.trim();
      const sql = sqlInput.value.trim();
      const description = document.getElementById('save-query-desc-input').value.trim().slice(0, 64);

      if (!title) { titleInput.focus(); return; }
      if (!sql) { sqlInput.focus(); return; }

      const store = getSavedQueriesStore();
      const list = store[key] || [];

      if (editingQueryId) {
        const idx = list.findIndex(q => q.id === editingQueryId);
        if (idx !== -1) list[idx] = { ...list[idx], title, sql, description };
      } else {
        list.push({
          id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title,
          sql,
          description,
          createdAt: new Date().toISOString()
        });
      }

      store[key] = list;
      if (!setSavedQueriesStore(store)) return;
      closeSaveQueryModal();
    };

    window.openLoadQueryModal = function() {
      selectedLoadQueryId = null;
      renderLoadQueryList();
      document.getElementById('load-query-modal').hidden = false;
    };

    window.closeLoadQueryModal = function() {
      document.getElementById('load-query-modal').hidden = true;
      closeAllQueryMenus();
    };

    function renderLoadQueryList() {
      const listEl = document.getElementById('load-query-list');
      const loadBtn = document.getElementById('load-query-confirm-btn');
      const queries = getSavedQueriesForCurrentCSV();

      loadBtn.disabled = true;

      if (!queries.length) {
        listEl.innerHTML = '<div class="empty">No saved queries yet for this file.</div>';
        return;
      }

      listEl.innerHTML = queries.map(q => `
        <div class="query-card" data-id="${q.id}">
          <input type="radio" name="load-query-radio" class="query-card-radio" onchange="selectLoadQuery('${q.id}')">
          <div class="query-card-body">
            <div class="query-card-title">${escapeHtml(q.title)}</div>
            ${q.description ? `<div class="query-card-desc">${escapeHtml(q.description)}</div>` : ''}
          </div>
          <div class="query-card-menu">
            <button class="query-card-menu-btn" onclick="toggleQueryMenu(event, '${q.id}')">⋯</button>
          </div>
        </div>
      `).join('');
    }

    window.selectLoadQuery = function(id) {
      selectedLoadQueryId = id;
      document.getElementById('load-query-confirm-btn').disabled = false;
      document.querySelectorAll('.query-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.id === id);
      });
    };

    window.confirmLoadQuery = function() {
      if (!selectedLoadQueryId) return;
      const q = getSavedQueriesForCurrentCSV().find(x => x.id === selectedLoadQueryId);
      if (!q) return;
      document.getElementById('query-input').value = q.sql;
      resetQueryInputView();
      closeLoadQueryModal();
    };

    // The popup lives once outside the scrollable list (position: fixed,
    // repositioned per click) so it never gets clipped by the list's own
    // overflow-y: auto, the way a popup nested inside each card would.
    let openQueryMenuId = null;

    window.toggleQueryMenu = function(event, id) {
      event.stopPropagation();
      const popup = document.getElementById('query-card-menu-popup');

      if (openQueryMenuId === id) {
        closeAllQueryMenus();
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      popup.style.top = (rect.bottom + 4) + 'px';
      popup.style.right = (window.innerWidth - rect.right) + 'px';
      document.getElementById('query-menu-edit-btn').onclick = () => editSavedQuery(id);
      document.getElementById('query-menu-delete-btn').onclick = () => confirmDeleteQuery(id);
      popup.hidden = false;
      openQueryMenuId = id;
    };

    function closeAllQueryMenus() {
      document.getElementById('query-card-menu-popup').hidden = true;
      openQueryMenuId = null;
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.query-card-menu-btn') && !e.target.closest('#query-card-menu-popup')) {
        closeAllQueryMenus();
      }
    });

    window.editSavedQuery = function(id) {
      closeAllQueryMenus();
      const q = getSavedQueriesForCurrentCSV().find(x => x.id === id);
      if (!q) return;

      editingQueryId = id;
      document.getElementById('save-query-modal-title').textContent = 'Edit Query';
      document.getElementById('save-query-title-input').value = q.title;
      document.getElementById('save-query-sql-input').value = q.sql;
      document.getElementById('save-query-desc-input').value = q.description || '';
      document.getElementById('save-query-desc-count').textContent = (q.description || '').length;

      closeLoadQueryModal();
      document.getElementById('save-query-modal').hidden = false;
    };

    window.confirmDeleteQuery = function(id) {
      closeAllQueryMenus();
      queryPendingDelete = id;
      document.getElementById('delete-query-modal').hidden = false;
    };

    window.closeDeleteQueryModal = function() {
      queryPendingDelete = null;
      document.getElementById('delete-query-modal').hidden = true;
    };

    window.confirmDeleteQuerySubmit = function() {
      if (!queryPendingDelete) return;
      const key = currentCSVKey();
      if (key) {
        const store = getSavedQueriesStore();
        store[key] = (store[key] || []).filter(q => q.id !== queryPendingDelete);
        setSavedQueriesStore(store);
      }
      queryPendingDelete = null;
      document.getElementById('delete-query-modal').hidden = true;
      renderLoadQueryList();
    };

    window.loadCloudWorkspace = async function(workspaceId) {
      const { data: ws, error: wsErr } = await sb.from('workspaces').select('*').eq('id', workspaceId).single();
      if (wsErr) { alert('Failed to load workspace: ' + wsErr.message); return; }

      const { data: dsRows, error: dsErr } = await sb
        .from('datasets').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true });
      if (dsErr) { alert('Failed to load workspace tables: ' + dsErr.message); return; }
      if (!dsRows || !dsRows.length) { alert('This workspace has no tables.'); return; }

      const { data: relRows } = await sb.from('workspace_relationships').select('*').eq('workspace_id', workspaceId);

      closeCloudPanel();
      showLoadingOverlay();

      try {
        db = new SQL.Database();
        tables = [];
        activeTableName = null;

        // Row counts are already known from the saved dataset metadata, so
        // the bar can be sized accurately before any downloading starts.
        // *3: one parse pass, one normalizeThousandsSeparators pass, one insert pass.
        addLoadProgressUnits(dsRows.reduce((sum, d) => sum + (d.row_count || 0), 0) * 3);

        for (const d of dsRows) {
          const { data: blob, error: dlErr } = await sb.storage.from('csvs').download(d.storage_path);
          if (dlErr) throw dlErr;
          const text = await blob.text();
          const { headers, rows } = await parseCSVText(text);

          // Load under the SAVED table_name, not a re-slugified filename —
          // a rename made before saving has to survive the round trip.
          // loadFileAsTable's chunked, yielding insert also means a large
          // saved workspace no longer blocks the tab for one long stretch
          // the way this loop's own hand-rolled insert used to.
          await loadFileAsTable({ name: d.filename }, headers, rows, d.table_name);
        }

        activeTableName = tables[0].name;
        focusedTableNames = new Set([activeTableName]);

        relationships = (relRows || []).map(r => ({
          id: `${r.from_table}.${r.from_column}|${r.to_table}.${r.to_column}`,
          fromTable: r.from_table,
          fromColumn: r.from_column,
          toTable: r.to_table,
          toColumn: r.to_column,
          confirmed: true,
          manual: true,
          cardinality: r.cardinality || null,
        }));
        rejectedRelationshipKeys = new Set();

        currentWorkspaceId = ws.id;
        currentWorkspaceName = ws.name;
        currentCSVFile = null;
        csvLoaded = true;

        const statusEl = document.getElementById('file-info');
        statusEl.textContent = `Workspace "${ws.name}" (${tables.length} table${tables.length === 1 ? '' : 's'})`;
        statusEl.classList.remove('error');
        statusEl.classList.add('loaded');

        document.getElementById('query-input').value = `SELECT * FROM ${activeTableName} LIMIT 100`;

        markWorkspaceSynced();
        renderTableChips();
        recomputeRelationships();
        populateManualFkTableSelects();
        updateAIState();
        renderTableView();

        completeLoadProgress(() => {
          revealApp();
          resetQueryInputView();
        });
      } catch (err) {
        hideLoadingOverlay();
        alert('Failed to load workspace: ' + err.message);
      }
    };

    // Loads a dataset-library template (see api/enterprise/load-template.js)
    // as a brand-new saved workspace. Mirrors loadCloudWorkspace's tail
    // (same in-browser SQLite setup, same final UI calls) and the "save
    // workspace" flow's upload pattern (same sb.storage.from('csvs').upload
    // + sb.from('datasets').insert calls) — a loaded template becomes a
    // completely normal workspace the user owns, indistinguishable from one
    // built by manually uploading these same CSVs.
    window.loadEnterpriseTemplate = async function(templateId, templateName) {
      closeCloudPanel();
      showLoadingOverlay();

      try {
        const { data: { session } } = await sb.auth.getSession();
        const response = await fetch('/api/enterprise/member-actions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token || ''}`,
          },
          body: JSON.stringify({ op: 'load_template', template_id: templateId }),
        });
        const templateData = await response.json();
        if (!response.ok) throw new Error(templateData?.error?.message || `Request failed (${response.status})`);

        const { data: ws, error: wsErr } = await sb.from('workspaces')
          .insert({ user_id: currentUser.id, name: templateData.template.name })
          .select().single();
        if (wsErr) throw wsErr;
        const workspaceId = ws.id;

        db = new SQL.Database();
        tables = [];
        activeTableName = null;

        for (const t of templateData.tables) {
          const fetched = await fetch(t.url);
          if (!fetched.ok) throw new Error(`Couldn't download ${t.table_name} (${fetched.status})`);
          const blob = await fetched.blob();
          const text = await blob.text();
          const { headers, rows } = await parseCSVText(text);

          const columnDefs = headers.map(h => `"${h}" TEXT`).join(', ');
          db.run(`CREATE TABLE "${t.table_name}" (${columnDefs})`);
          const stmt = db.prepare(`INSERT INTO "${t.table_name}" VALUES (${headers.map(() => '?').join(', ')})`);
          rows.forEach(row => {
            if (row.length === headers.length) stmt.run(row);
            else if (row.length < headers.length) stmt.run([...row, ...Array(headers.length - row.length).fill('')]);
            else stmt.run(row.slice(0, headers.length));
          });
          stmt.free();

          tables.push({ name: t.table_name, fileName: `${t.table_name}.csv`, rowCount: rows.length, columns: headers });

          // Persist into the member's own workspace exactly like a manual
          // upload would — this is what makes the loaded template a normal,
          // fully-owned workspace afterward (reloadable, renameable,
          // deletable) instead of something special-cased.
          const path = `${currentUser.id}/${workspaceId}/${t.table_name}.csv`;
          const { error: upErr } = await sb.storage.from('csvs').upload(path, blob, { upsert: true, contentType: 'text/csv' });
          if (upErr) throw upErr;
          // filename (not just storage_path) has to be unique per the
          // pre-existing datasets_user_filename_unique constraint
          // (supabase/migrations/20260910032656_dedupe_datasets_by_filename.sql
          // — unique on (user_id, filename), not scoped per-workspace). Found
          // live: loading the same template a second time always violated
          // it, since every load used the same plain "students.csv" name.
          // Suffixing with this workspace's id keeps the constraint's
          // original purpose (dedupe a literal re-save of the same CSV)
          // intact while guaranteeing a template load never collides with
          // a prior one.
          const { error: dsErr } = await sb.from('datasets').insert({
            user_id: currentUser.id,
            workspace_id: workspaceId,
            filename: `${t.table_name}-${workspaceId}.csv`,
            table_name: t.table_name,
            storage_path: path,
            row_count: rows.length,
            columns: headers,
          });
          if (dsErr) throw dsErr;
        }

        activeTableName = tables[0].name;
        focusedTableNames = new Set([activeTableName]);

        relationships = templateData.relationships.map(r => ({
          id: `${r.from_table}.${r.from_column}|${r.to_table}.${r.to_column}`,
          fromTable: r.from_table,
          fromColumn: r.from_column,
          toTable: r.to_table,
          toColumn: r.to_column,
          confirmed: true,
          manual: true,
          cardinality: null,
        }));
        rejectedRelationshipKeys = new Set();

        if (relationships.length) {
          const { error: relErr } = await sb.from('workspace_relationships').insert(
            relationships.map(r => ({
              workspace_id: workspaceId,
              from_table: r.fromTable,
              from_column: r.fromColumn,
              to_table: r.toTable,
              to_column: r.toColumn,
            }))
          );
          if (relErr) throw relErr;
        }

        currentWorkspaceId = workspaceId;
        currentWorkspaceName = ws.name;
        currentCSVFile = null;
        csvLoaded = true;

        const statusEl = document.getElementById('file-info');
        statusEl.textContent = `Workspace "${ws.name}" (${tables.length} table${tables.length === 1 ? '' : 's'})`;
        statusEl.classList.remove('error');
        statusEl.classList.add('loaded');

        document.getElementById('query-input').value = `SELECT * FROM ${activeTableName} LIMIT 100`;

        markWorkspaceSynced();
        renderTableChips();
        recomputeRelationships();
        populateManualFkTableSelects();
        updateAIState();
        renderTableView();

        completeLoadProgress(() => {
          revealApp();
          resetQueryInputView();
        });
      } catch (err) {
        hideLoadingOverlay();
        alert('Failed to load dataset: ' + err.message);
      }
    };

    window.loadCloudSession = async function(sessionId) {
      const { data: sess, error } = await sb.from('chat_sessions').select('*').eq('id', sessionId).single();
      if (error) { alert('Failed to load session: ' + error.message); return; }
      const { data: messages, error: msgError } = await sb
        .from('chat_messages').select('*').eq('session_id', sessionId).order('created_at', { ascending: true });
      if (msgError) { alert('Failed to load messages: ' + msgError.message); return; }

      // Set this before loading the workspace: loadCloudWorkspace
      // synchronously calls updateAIState() as part of loading, and that
      // reads aiEnabled to decide the toggle's ON/OFF label. Setting it
      // first means that reset lands in the right "ON" state, instead of
      // ON becoming checked but visually mislabeled "OFF".
      aiEnabled = true;
      document.getElementById('ai-toggle').checked = true;
      document.getElementById('chat-input').disabled = false;
      document.getElementById('chat-send').disabled = false;

      // A session's workspace always loads with it now (no confirm prompt),
      // so it gets the same branded loading screen as any other load. That
      // must happen BEFORE we restore this session's chat messages below:
      // loadCloudWorkspace resets the AI panel back to its fresh-greeting
      // state as a side effect of loading, which would wipe out the very
      // messages we're about to restore if we set them first.
      if (sess.workspace_id) {
        await window.loadCloudWorkspace(sess.workspace_id);
      } else {
        closeCloudPanel();
      }

      chatHistory = messages.map(m => ({ role: m.role, content: m.content }));
      const messagesDiv = document.getElementById('chat-messages');
      messagesDiv.innerHTML = chatHistory.map(m =>
        m.role === 'user'
          ? `<div class="chat-message user">${renderUserMessage(m.content)}</div>`
          : `<div class="chat-turn assistant-turn">${renderAssistantMessage(m.content)}</div>`
      ).join('');

      updateCloudButtons();
    };

    function getCurrentColumns(tableName) {
      const name = tableName || activeTableName;
      if (!db || !name) return null;
      try {
        const result = db.exec(`PRAGMA table_info("${name}")`);
        return result[0].values.map(c => c[1]);
      } catch {
        return null;
      }
    }

    function getCurrentRowCount(tableName) {
      const name = tableName || activeTableName;
      if (!db || !name) return null;
      try {
        const result = db.exec(`SELECT COUNT(*) FROM "${name}"`);
        return result[0].values[0][0];
      } catch {
        return null;
      }
    }

    // ---- Upload flow: parse CSV(s) -> show a timed loading transition -> reveal the app ----
    // Starts a brand-new workspace, replacing anything currently loaded.

    window.uploadCSV = async function(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      const statusEl = document.getElementById('file-info');
      showLoadingOverlay();

      try {
        db = new SQL.Database();
        tables = [];
        activeTableName = null;
        columnStatsCache = null;

        const effectiveMax = maxTablesForTier();
        if (files.length > 1 && !canUseFeature('multiCsv')) requireFeature('multiCsv');

        const filesToLoad = files.slice(0, effectiveMax);
        const fileTexts = await sizeLoadProgress(filesToLoad);

        let loaded = [];
        for (const file of filesToLoad) {
          const text = fileTexts.get(file);
          const { headers, rows } = await parseUploadedFile(file.name, text);
          assertRowCapOrThrow(rows.length);
          loaded.push(await loadFileAsTable(file, headers, rows, slugifyTableName(file.name)));
        }

        activeTableName = loaded[0].name;
        focusedTableNames = new Set([activeTableName]);

        if (loaded.length === 1) {
          statusEl.textContent = `${loaded[0].fileName} (${formatFileSize(files[0])}, ${loaded[0].rowCount.toLocaleString()} rows) → table "${loaded[0].name}"`;
          if (files.length > 1 && effectiveMax === 1) {
            statusEl.textContent += ' — only this file was loaded (multiple CSVs per workspace is a Premium feature)';
          }
        } else {
          statusEl.textContent = `${loaded.length} tables loaded`;
        }
        statusEl.classList.remove('error');
        statusEl.classList.add('loaded');

        document.getElementById('query-input').value = `SELECT * FROM ${activeTableName} LIMIT 100`;

        csvLoaded = true;
        currentCSVFile = files[0];
        currentWorkspaceId = null;
        currentWorkspaceName = null;
        markWorkspaceDirty();
        renderTableChips();
        rejectedRelationshipKeys = new Set();
        relationships = [];
        recomputeRelationships();
        populateManualFkTableSelects();
        updateAIState();
        renderTableView();

        completeLoadProgress(() => {
          revealApp();
          document.getElementById('query-input').focus();
          resetQueryInputView();
        });

      } catch (err) {
        hideLoadingOverlay();
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.classList.add('error');
        console.error(err);

        // On an upload from the home view, app-view (and file-info inside
        // it) is still hidden here since revealApp() only runs on success.
        // Without this the error is real but invisible.
        if (document.getElementById('app-view').hidden) {
          setHomeUploadMessage(err.message, true);
        }
      }
    };

    // Adds one or more tables to the *current* workspace, without
    // disturbing tables already loaded.
    window.addTablesCSV = async function(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      if (!db) {
        return window.uploadCSV(event);
      }

      const statusEl = document.getElementById('file-info');

      if (tables.length >= 1 && !requireFeature('multiCsv')) return;

      const effectiveMax = maxTablesForTier();
      const room = effectiveMax - tables.length;
      if (room <= 0) {
        statusEl.textContent = `Error: this workspace already has ${effectiveMax} table${effectiveMax === 1 ? '' : 's'}, the maximum per workspace${canUseFeature('multiCsv') ? '' : ' on your account'}`;
        statusEl.classList.add('error');
        return;
      }

      showLoadingOverlay();
      try {
        const filesToLoad = files.slice(0, room);
        const fileTexts = await sizeLoadProgress(filesToLoad);

        let loaded = [];
        for (const file of filesToLoad) {
          const text = fileTexts.get(file);
          const { headers, rows } = await parseUploadedFile(file.name, text);
          assertRowCapOrThrow(rows.length);
          loaded.push(await loadFileAsTable(file, headers, rows, slugifyTableName(file.name)));
        }

        if (files.length > room) {
          statusEl.textContent = `Added ${loaded.length} table(s), ${files.length - room} skipped (workspace cap is ${effectiveMax} table${effectiveMax === 1 ? '' : 's'})`;
        } else {
          statusEl.textContent = `Added ${loaded.map(t => t.name).join(', ')}`;
        }
        statusEl.classList.remove('error');
        statusEl.classList.add('loaded');

        activeTableName = loaded[loaded.length - 1].name;
        markWorkspaceDirty();
        renderTableChips();
        recomputeRelationships();
        populateManualFkTableSelects();
        updateAIState();
        renderTableView();

        completeLoadProgress(() => {
          document.getElementById('query-input').focus();
        });
      } catch (err) {
        hideLoadingOverlay();
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.classList.add('error');
        console.error(err);
      }
    };

    // ---- Table chip bar + AI focus selector (two views of `activeTableName`) ----

    // Same fallback chain saveCurrentCSV() uses to name a never-saved
    // workspace, reused here so the switcher pill shows something sensible
    // even before the workspace has a real, explicitly-saved name.
    function getWorkspaceDisplayName() {
      return currentWorkspaceName || (tables[0] && tables[0].fileName) || 'Untitled workspace';
    }

    function updateWorkspaceSwitcher() {
      const el = document.getElementById('workspace-switcher');
      const label = document.getElementById('workspace-switcher-label');
      // Visibility is about whether there's a *current* workspace worth
      // naming (signed in + something loaded) — NOT how many tables that
      // workspace happens to have. How many workspaces are actually saved
      // is a separate question, answered at click time in changeWorkspace().
      if (!currentUser || !tables.length) {
        el.hidden = true;
        closeWorkspaceSwitcher();
        return;
      }
      el.hidden = false;
      label.textContent = `${getWorkspaceDisplayName()}, ${tables.length} table${tables.length === 1 ? '' : 's'}`;
    }

    function renderTableChips() {
      const bar = document.getElementById('table-chip-bar');
      const addBtn = document.getElementById('add-table-btn');
      const focusRow = document.getElementById('chat-table-focus-row');

      updateWorkspaceSwitcher();
      updateQuerySchemaPanel();

      if (!tables.length) {
        bar.hidden = true;
        bar.innerHTML = '';
        addBtn.hidden = true;
        focusRow.hidden = true;
        return;
      }

      addBtn.hidden = tables.length >= MAX_TABLES_PER_WORKSPACE;
      addBtn.title = addBtn.hidden
        ? `Workspace cap reached (${MAX_TABLES_PER_WORKSPACE} tables)`
        : (canUseFeature('multiCsv') ? '' : 'Multiple CSVs per workspace is a Premium feature');

      bar.hidden = false;
      bar.innerHTML = tables.map(t => `
        <div class="table-chip${t.name === activeTableName ? ' active' : ''}" data-table="${t.name}" role="group" aria-label="Table: ${escapeAttr(t.name)}${t.name === activeTableName ? ' (selected)' : ''}" tabindex="0" onclick="handleChipClick(event, '${t.name}')" onkeydown="handleChipKeydown(event, '${t.name}')">
          <span class="chip-name" data-table="${t.name}">${escapeHtml(t.name)}</span>
          <span class="chip-rows">${t.rowCount.toLocaleString()}</span>
          <button class="chip-rename" title="Rename table" onclick="startRenameChip(event, '${t.name}')">✎</button>
          ${tables.length > 1 ? `<button class="chip-delete" title="Delete table" onclick="requestDeleteTable(event, '${t.name}')">&times;</button>` : ''}
        </div>
      `).join('');

      focusRow.hidden = tables.length <= 1;
      renderFocusDropdown();
    }

    // ---- SQL editor schema panel: lets you see column names while writing
    // a query without switching to the Table View tab. ----

    function updateQuerySchemaPanel() {
      const panel = document.getElementById('query-schema-panel');
      const summary = document.getElementById('query-schema-summary');
      const body = document.getElementById('query-schema-body');
      if (!panel) return;

      if (!tables.length) {
        panel.hidden = true;
        return;
      }

      panel.hidden = false;
      summary.textContent = tables.length === 1
        ? `Columns (${tables[0].columns.length})`
        : `Columns — ${tables.length} tables`;

      body.innerHTML = tables.map(t => `
        <div class="query-schema-table-name">${escapeHtml(t.name)}</div>
        <div class="query-schema-columns">${t.columns.map(c => `<span class="query-schema-col">${escapeHtml(c)}</span>`).join('')}</div>
      `).join('');
    }

    window.toggleQuerySchemaPanel = function() {
      const toggle = document.getElementById('query-schema-toggle');
      const body = document.getElementById('query-schema-body');
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
    };

    function renderFocusDropdown() {
      const panel = document.getElementById('focus-dropdown-panel');
      const label = document.getElementById('focus-dropdown-label');
      if (!panel || !label) return;

      panel.innerHTML = tables.map(t => `
        <label class="focus-option">
          <input type="checkbox" value="${t.name}" ${focusedTableNames.has(t.name) ? 'checked' : ''} onchange="toggleFocusTable('${t.name}', this.checked)">
          ${escapeHtml(t.name)}
        </label>
      `).join('');

      if (focusedTableNames.size === 0) label.textContent = 'None';
      else if (focusedTableNames.size === tables.length) label.textContent = 'All tables';
      else label.textContent = [...focusedTableNames].join(', ');
    }

    window.toggleFocusTable = function(name, checked) {
      if (checked) focusedTableNames.add(name);
      else focusedTableNames.delete(name);
      renderFocusDropdown();
    };

    window.toggleFocusDropdown = function() {
      const panel = document.getElementById('focus-dropdown-panel');
      const btn = document.getElementById('focus-dropdown-btn');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    };

    // ---- Workspace switcher: the toolbar pill showing "<name>, N tables",
    // whose only real action is jumping to the Dashboard to open a
    // different one. ----

    window.toggleWorkspaceSwitcher = function() {
      const panel = document.getElementById('workspace-switcher-panel');
      const btn = document.getElementById('workspace-switcher-btn');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    };

    function closeWorkspaceSwitcher() {
      const panel = document.getElementById('workspace-switcher-panel');
      const btn = document.getElementById('workspace-switcher-btn');
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }

    window.changeWorkspace = function() {
      closeWorkspaceSwitcher();
      if (!currentUser) { openSigninRequiredModal(); return; }
      openHome();
    };

    window.closeWorkspaceNoticeModal = function() {
      document.getElementById('workspace-notice-modal').hidden = true;
    };

    function showWorkspaceNotice(message) {
      document.getElementById('workspace-notice-body').textContent = message;
      document.getElementById('workspace-notice-modal').hidden = false;
    }

    document.addEventListener('click', (e) => {
      const switcher = document.getElementById('workspace-switcher');
      if (switcher && !switcher.hidden && !switcher.contains(e.target)) {
        closeWorkspaceSwitcher();
      }
    });

    window.handleChipClick = function(event, name) {
      if (event.target.closest('.chip-rename') || event.target.closest('.chip-delete') || event.target.isContentEditable) return;
      setActiveTable(name);
    };

    // The chip itself is a div (role="button"), not a real <button>, since
    // it contains its own nested rename/delete buttons — a <button> can't
    // contain interactive children. Enter/Space only fires this when the
    // chip itself (not a nested control) has keyboard focus, so no target
    // guard is needed here the way handleChipClick above needs one for clicks.
    window.handleChipKeydown = function(event, name) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setActiveTable(name);
    };

    window.setActiveTable = function(name) {
      if (!tables.some(t => t.name === name)) return;
      activeTableName = name;
      document.getElementById('query-input').value = `SELECT * FROM ${name} LIMIT 100`;
      renderTableChips();
      renderTableView();
      resetQueryInputView();
    };

    window.startRenameChip = function(event, name) {
      event.stopPropagation();
      if (!requireFeature('tableRename')) return;
      const bar = document.getElementById('table-chip-bar');
      const label = bar.querySelector(`.chip-name[data-table="${CSS.escape(name)}"]`);
      if (!label) return;

      label.contentEditable = 'true';
      label.focus();
      document.execCommand('selectAll', false, null);

      const commit = () => {
        label.removeAttribute('contenteditable');
        const proposed = slugifyTableName(label.textContent.trim() || name);
        renameTable(name, proposed);
      };

      label.addEventListener('blur', commit, { once: true });
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
        if (e.key === 'Escape') { label.textContent = name; label.blur(); }
      });
    };

    function renameTable(oldName, proposedName) {
      if (proposedName === oldName) { renderTableChips(); return; }

      const collision = tables.some(t => t.name === proposedName && t.name !== oldName);
      const finalName = collision ? uniqueTableName(proposedName) : proposedName;

      db.run(`ALTER TABLE "${oldName}" RENAME TO "${finalName}"`);
      const entry = tables.find(t => t.name === oldName);
      entry.name = finalName;
      if (activeTableName === oldName) activeTableName = finalName;
      if (focusedTableNames.has(oldName)) {
        focusedTableNames.delete(oldName);
        focusedTableNames.add(finalName);
      }

      // Existing relationships (including confirmed ones) reference tables by
      // name — follow the rename so a confirmed FK doesn't silently vanish.
      relationships.forEach(r => {
        if (r.fromTable === oldName) r.fromTable = finalName;
        if (r.toTable === oldName) r.toTable = finalName;
      });
      rejectedRelationshipKeys = new Set(
        [...rejectedRelationshipKeys].map(k => k.split('|').map(part => part.startsWith(oldName + '.') ? finalName + part.slice(oldName.length) : part).join('|'))
      );

      if (collision) {
        const statusEl = document.getElementById('file-info');
        statusEl.textContent = `"${proposedName}" was already taken, renamed to "${finalName}"`;
      }

      renderTableChips();
      updateAIState();
      recomputeRelationships();
      populateManualFkTableSelects();
      markWorkspaceDirty();
      if (activeTableName === finalName) {
        document.getElementById('query-input').value = `SELECT * FROM ${finalName} LIMIT 100`;
        resetQueryInputView();
      }
    }

    // ---- Delete table (chip's X button) ----
    // Only shown when there's more than one table (see renderTableChips),
    // so there's always at least one table left after a delete — no need
    // to handle emptying the workspace back to zero tables here.

    let tablePendingDelete = null;

    window.requestDeleteTable = function(event, name) {
      event.stopPropagation();
      tablePendingDelete = name;
      document.getElementById('delete-table-name').textContent = `"${name}"`;
      document.getElementById('delete-table-modal').hidden = false;
    };

    window.closeDeleteTableModal = function() {
      tablePendingDelete = null;
      document.getElementById('delete-table-modal').hidden = true;
    };

    window.confirmDeleteTableSubmit = function() {
      const name = tablePendingDelete;
      tablePendingDelete = null;
      document.getElementById('delete-table-modal').hidden = true;
      if (!name || !tables.some(t => t.name === name)) return;

      db.run(`DROP TABLE "${name}"`);
      tables = tables.filter(t => t.name !== name);
      focusedTableNames.delete(name);
      if (columnStatsCache && columnStatsCache.tableName === name) columnStatsCache = null;
      relationships = relationships.filter(r => r.fromTable !== name && r.toTable !== name);

      if (activeTableName === name) {
        activeTableName = tables.length ? tables[0].name : null;
        if (activeTableName) {
          document.getElementById('query-input').value = `SELECT * FROM ${activeTableName} LIMIT 100`;
          resetQueryInputView();
        }
      }

      renderTableChips();
      renderTableView();
      recomputeRelationships();
      populateManualFkTableSelects();
      updateAIState();
      markWorkspaceDirty();
    };

    // ---- Heuristic foreign-key matching + ERD (Relationships tab) ----
    // Relationships are metadata only: they inform the AI's system prompt
    // and the ERD view, and are never created as real SQLite FOREIGN KEY
    // constraints, since real-world CSVs commonly have orphaned rows that
    // would break constraint enforcement on import.

    let relationships = [];              // [{ id, fromTable, fromColumn, toTable, toColumn, confirmed, manual, cardinality }]
                                          // cardinality: '1:1' | '1:M' | 'M:M' | '1:0' | '0:M' | null (unset until confirmed)
    let rejectedRelationshipKeys = new Set();

    function relationshipKey(r) {
      return `${r.fromTable}.${r.fromColumn}|${r.toTable}.${r.toColumn}`;
    }

    function singularize(name) {
      if (/ies$/i.test(name)) return name.slice(0, -3) + 'y';
      if (/ses$/i.test(name)) return name.slice(0, -2);
      if (/s$/i.test(name) && !/ss$/i.test(name)) return name.slice(0, -1);
      return name;
    }

    // Suggests A.foo_id -> B.id whenever "foo" matches B's name (singular or
    // literal) and B actually has an "id" column. A narrow, explainable rule
    // rather than a fuzzy matcher — misses things like a self-referential
    // "manager_id" that doesn't name its own table, which is exactly what
    // the manual-add control below is for.
    function inferRelationships() {
      const suggestions = [];
      for (const a of tables) {
        for (const colA of a.columns) {
          if (!/_id$/i.test(colA)) continue;
          const base = colA.slice(0, -3).toLowerCase();
          for (const b of tables) {
            const matches = base === singularize(b.name).toLowerCase() || base === b.name.toLowerCase();
            if (!matches) continue;
            const toCol = b.columns.find(c => c.toLowerCase() === 'id');
            if (!toCol) continue;
            if (a.name === b.name && colA === toCol) continue;
            suggestions.push({ fromTable: a.name, fromColumn: colA, toTable: b.name, toColumn: toCol });
          }
        }
      }
      return suggestions;
    }

    // Re-derives suggestions after any schema change, preserving confirmed/
    // manual relationships and not resurrecting rejected suggestions.
    function recomputeRelationships() {
      const suggested = inferRelationships();
      const existingByKey = new Map(relationships.map(r => [relationshipKey(r), r]));
      const next = [];

      suggested.forEach(s => {
        const k = relationshipKey(s);
        if (rejectedRelationshipKeys.has(k)) return;
        const existing = existingByKey.get(k);
        if (existing) {
          next.push(existing);
          existingByKey.delete(k);
        } else {
          next.push({ id: k, ...s, confirmed: false, manual: false });
        }
      });

      // Keep confirmed/manual relationships the heuristic no longer
      // suggests, as long as both ends still exist (e.g. a manual add, or a
      // confirmed relationship the naming heuristic wouldn't catch).
      existingByKey.forEach(r => {
        if (!(r.confirmed || r.manual)) return;
        const fromOk = tables.some(t => t.name === r.fromTable && t.columns.includes(r.fromColumn));
        const toOk = tables.some(t => t.name === r.toTable && t.columns.includes(r.toColumn));
        if (fromOk && toOk) next.push(r);
      });

      relationships = next;
      renderRelationshipsTabVisibility();
      renderERD();
      renderRelationshipList();
    }

    function renderRelationshipsTabVisibility() {
      // A grandfathered non-premium workspace can still have tables.length
      // >= 2 (multi-CSV is gated going forward, not retroactively — see
      // canUseFeature('multiCsv')), so table count alone isn't a safe
      // gate here: relationship detection is a Premium feature on its own.
      document.getElementById('relationships-tab-btn').hidden = tables.length < 2 || !canUseFeature('relationshipDetection');
    }

    window.confirmRelationship = function(id) {
      const r = relationships.find(x => x.id === id);
      if (!r) return;
      openRelationshipTypeModal(r.fromTable, r.fromColumn, r.toTable, r.toColumn, r.id);
    };

    window.rejectRelationship = function(id) {
      const r = relationships.find(x => x.id === id);
      if (!r) return;
      rejectedRelationshipKeys.add(relationshipKey(r));
      relationships = relationships.filter(x => x.id !== id);
      renderERD();
      renderRelationshipList();
      updateAIState();
      markWorkspaceDirty();
    };

    window.removeRelationship = function(id) {
      const r = relationships.find(x => x.id === id);
      if (!r) return;
      if (!r.manual) rejectedRelationshipKeys.add(relationshipKey(r));
      relationships = relationships.filter(x => x.id !== id);
      renderERD();
      renderRelationshipList();
      updateAIState();
      markWorkspaceDirty();
    };

    window.addManualRelationship = function() {
      const fromTable = document.getElementById('manual-fk-from-table').value;
      const fromColumn = document.getElementById('manual-fk-from-col').value;
      const toTable = document.getElementById('manual-fk-to-table').value;
      const toColumn = document.getElementById('manual-fk-to-col').value;
      if (!fromTable || !fromColumn || !toTable || !toColumn) return;
      openRelationshipTypeModal(fromTable, fromColumn, toTable, toColumn, null);
    };

    // ---- Relationship type popup ----
    // Shared by three entry points: dragging column -> column on the
    // diagram, confirming an auto-suggested relationship, and the manual
    // dropdown form above. Picking a type commits immediately.

    let pendingRelationshipDraft = null; // { fromTable, fromColumn, toTable, toColumn, existingId }

    function openRelationshipTypeModal(fromTable, fromColumn, toTable, toColumn, existingId) {
      pendingRelationshipDraft = { fromTable, fromColumn, toTable, toColumn, existingId };
      document.getElementById('relationship-type-path').textContent =
        `${fromTable}.${fromColumn} → ${toTable}.${toColumn}`;
      document.getElementById('relationship-type-modal').hidden = false;
    }

    window.closeRelationshipTypeModal = function() {
      document.getElementById('relationship-type-modal').hidden = true;
      pendingRelationshipDraft = null;
    };

    window.chooseRelationshipType = function(cardinality) {
      if (!pendingRelationshipDraft) return;
      const { fromTable, fromColumn, toTable, toColumn, existingId } = pendingRelationshipDraft;

      if (existingId) {
        const existing = relationships.find(x => x.id === existingId);
        if (existing) {
          existing.confirmed = true;
          existing.cardinality = cardinality;
        }
      } else {
        const r = { fromTable, fromColumn, toTable, toColumn };
        const k = relationshipKey(r);
        rejectedRelationshipKeys.delete(k);
        const idx = relationships.findIndex(x => relationshipKey(x) === k);
        if (idx >= 0) {
          relationships[idx].confirmed = true;
          relationships[idx].manual = true;
          relationships[idx].cardinality = cardinality;
        } else {
          relationships.push({ id: k, ...r, confirmed: true, manual: true, cardinality });
        }
      }

      document.getElementById('relationship-type-modal').hidden = true;
      pendingRelationshipDraft = null;
      renderERD();
      renderRelationshipList();
      updateAIState();
      markWorkspaceDirty();
    };

    // ---- Drag-to-connect: mousedown on a column row, drag to another,
    // release to open the type popup. Plain mouse events to match the rest
    // of this file (no drag library, no framework).

    let dragState = null; // { fromTable, fromColumn, canvas, colId }

    window.startRelationshipDrag = function(event) {
      event.preventDefault();
      const sourceEl = event.currentTarget;
      const fromTable = sourceEl.dataset.table;
      const fromColumn = sourceEl.dataset.column;
      const canvas = document.getElementById('erd-canvas');
      const colId = (table, col) => `erd-col-${cssEscapeId(table)}-${cssEscapeId(col)}`;
      if (!canvas || !sourceEl) return;

      dragState = { fromTable, fromColumn, canvas, colId };
      sourceEl.classList.add('drag-source');

      document.addEventListener('mousemove', onRelationshipDragMove);
      document.addEventListener('mouseup', onRelationshipDragEnd);
    };

    function hoveredColRow(x, y) {
      const el = document.elementFromPoint(x, y);
      return el ? el.closest('.erd-col-row') : null;
    }

    function onRelationshipDragMove(event) {
      if (!dragState) return;
      updateDragLine(event.clientX, event.clientY);

      const hovered = hoveredColRow(event.clientX, event.clientY);
      document.querySelectorAll('.erd-col-row.drag-hover-target').forEach(el => {
        if (el !== hovered) el.classList.remove('drag-hover-target');
      });
      if (hovered && !hovered.classList.contains('drag-source')) {
        hovered.classList.add('drag-hover-target');
      }
    }

    function onRelationshipDragEnd(event) {
      if (!dragState) return;
      const { fromTable, fromColumn, canvas, colId } = dragState;

      document.removeEventListener('mousemove', onRelationshipDragMove);
      document.removeEventListener('mouseup', onRelationshipDragEnd);
      document.getElementById(colId(fromTable, fromColumn))?.classList.remove('drag-source');
      document.querySelectorAll('.erd-col-row.drag-hover-target').forEach(el => el.classList.remove('drag-hover-target'));
      clearDragLine(canvas);
      dragState = null;

      const target = hoveredColRow(event.clientX, event.clientY);
      if (!target) return;
      const toTable = target.closest('.erd-table-box')?.dataset.table;
      const toColumn = target.dataset.column;
      if (!toTable || !toColumn) return;
      if (toTable === fromTable && toColumn === fromColumn) return; // dropped on itself

      openRelationshipTypeModal(fromTable, fromColumn, toTable, toColumn, null);
    }

    function updateDragLine(clientX, clientY) {
      if (!dragState) return;
      const { fromTable, fromColumn, canvas, colId } = dragState;
      const svg = canvas.querySelector('.erd-svg-overlay');
      const sourceEl = document.getElementById(colId(fromTable, fromColumn));
      if (!svg || !sourceEl) return;

      const canvasRect = canvas.getBoundingClientRect();
      const sr = sourceEl.getBoundingClientRect();
      const x1 = sr.left + sr.width / 2 - canvasRect.left;
      const y1 = sr.top + sr.height / 2 - canvasRect.top;
      const x2 = clientX - canvasRect.left;
      const y2 = clientY - canvasRect.top;

      let line = svg.querySelector('#erd-drag-line');
      if (!line) {
        line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.id = 'erd-drag-line';
        line.setAttribute('stroke', '#ff4f00');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '5 3');
        svg.appendChild(line);
      }
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
    }

    function clearDragLine(canvas) {
      canvas?.querySelector('#erd-drag-line')?.remove();
    }

    window.populateManualFkColumns = function(side) {
      const tableSel = document.getElementById(`manual-fk-${side}-table`);
      const colSel = document.getElementById(`manual-fk-${side}-col`);
      const t = tables.find(x => x.name === tableSel.value);
      colSel.innerHTML = (t ? t.columns : []).map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
    };

    function populateManualFkTableSelects() {
      const opts = tables.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
      ['from', 'to'].forEach(side => {
        const sel = document.getElementById(`manual-fk-${side}-table`);
        const prev = sel.value;
        sel.innerHTML = opts;
        if (tables.some(t => t.name === prev)) sel.value = prev;
        populateManualFkColumns(side);
      });
    }

    function renderRelationshipList() {
      const list = document.getElementById('relationship-list');
      if (!relationships.length) {
        list.innerHTML = '<div class="empty">No relationships yet. Suggestions appear here once you have 2+ tables with matching id columns.</div>';
        return;
      }
      list.innerHTML = relationships.map(r => `
        <div class="relationship-row${r.confirmed ? ' confirmed' : ''}">
          <span class="rel-badge ${r.confirmed ? 'confirmed' : 'suggested'}">${r.confirmed ? 'Confirmed' : 'Suggested'}</span>
          ${r.confirmed && r.cardinality ? `<span class="rel-cardinality">${r.cardinality}</span>` : ''}
          <span class="rel-path">${escapeHtml(r.fromTable)}.${escapeHtml(r.fromColumn)} &rarr; ${escapeHtml(r.toTable)}.${escapeHtml(r.toColumn)}</span>
          <span class="rel-actions">
            ${r.confirmed
              ? `<button class="edit-btn" onclick="confirmRelationship('${r.id}')">Edit</button><button class="reject-btn" onclick="removeRelationship('${r.id}')">Remove</button>`
              : `<button class="confirm-btn" onclick="confirmRelationship('${r.id}')">Confirm</button><button class="reject-btn" onclick="rejectRelationship('${r.id}')">Reject</button>`}
          </span>
        </div>
      `).join('');
    }

    // Draws each table as a box (columns listed inside) and overlays an SVG
    // connecting confirmed (solid, premium blue) vs. suggested (dashed,
    // neutral) relationships between the specific column rows involved.
    function renderERD() {
      const canvas = document.getElementById('erd-canvas');
      if (!canvas) return;

      if (tables.length < 2) {
        canvas.innerHTML = '<div class="empty">Load a second table to see suggested relationships here.</div>';
        return;
      }

      const colId = (table, col) => `erd-col-${cssEscapeId(table)}-${cssEscapeId(col)}`;

      canvas.innerHTML = tables.map(t => `
        <div class="erd-table-box" data-table="${escapeAttr(t.name)}">
          <div class="erd-table-name">${escapeHtml(t.name)}</div>
          ${t.columns.map(c => `<div class="erd-col-row" id="${colId(t.name, c)}" data-table="${escapeAttr(t.name)}" data-column="${escapeAttr(c)}" onmousedown="startRelationshipDrag(event)">${escapeHtml(c)}</div>`).join('')}
        </div>
      `).join('') + '<svg class="erd-svg-overlay"></svg>';

      requestAnimationFrame(() => drawERDLines(canvas, colId));
    }

    function cssEscapeId(s) {
      return s.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function drawERDLines(canvas, colId) {
      const svg = canvas.querySelector('.erd-svg-overlay');
      if (!svg) return;
      const canvasRect = canvas.getBoundingClientRect();
      svg.setAttribute('width', canvas.scrollWidth);
      svg.setAttribute('height', canvas.scrollHeight);

      const lines = relationships.map(r => {
        const fromEl = document.getElementById(colId(r.fromTable, r.fromColumn));
        const toEl = document.getElementById(colId(r.toTable, r.toColumn));
        if (!fromEl || !toEl) return '';

        const fr = fromEl.getBoundingClientRect();
        const tr = toEl.getBoundingClientRect();
        const fromOnLeft = fr.left < tr.left;
        const x1 = (fromOnLeft ? fr.right : fr.left) - canvasRect.left;
        const y1 = fr.top + fr.height / 2 - canvasRect.top;
        const x2 = (fromOnLeft ? tr.left : tr.right) - canvasRect.left;
        const y2 = tr.top + tr.height / 2 - canvasRect.top;

        const stroke = r.confirmed ? '#489fdf' : '#b3ada0';
        const dash = r.confirmed ? '' : 'stroke-dasharray="4 4"';
        const width = r.confirmed ? '2' : '1.5';
        const line = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}" ${dash} />`;

        if (!r.confirmed || !r.cardinality) return line;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const label = `
          <rect x="${mx - 15}" y="${my - 9}" width="30" height="18" rx="4" fill="#dceefb" stroke="#b9dbf5" />
          <text x="${mx}" y="${my + 4}" font-size="10" font-family="'JetBrains Mono', monospace" font-weight="700" text-anchor="middle" fill="#0b4a78">${r.cardinality}</text>
        `;
        return line + label;
      }).join('');

      svg.innerHTML = lines;
    }

    // Confirmed relationships are surfaced to the AI as explicit join
    // hints, on top of (not instead of) the multi-table schema it already
    // reasons over.
    function relationshipHintsText() {
      const confirmed = relationships.filter(r => r.confirmed);
      if (!confirmed.length) return '';
      const lines = confirmed.map(r => `- ${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}${r.cardinality ? ` (${r.cardinality})` : ''}`).join('\n');
      return `\nConfirmed relationships in this workspace (use these joins when relevant):\n${lines}\n`;
    }

    function showLoadingOverlay() {
      const overlay = document.getElementById('loading-overlay');
      const fill = document.getElementById('loading-fill');
      fill.style.transition = 'none';
      fill.style.width = '0%';
      overlay.hidden = false;
      // force reflow so the width reset above is committed before the first update animates
      void fill.offsetWidth;
      fill.style.transition = 'width 150ms linear';
      document.body.classList.add('bg-blur');
      resetLoadProgress();
    }

    function hideLoadingOverlay() {
      document.getElementById('loading-overlay').hidden = true;
      document.body.classList.remove('bg-blur');
    }

    // ---- Loading overlay progress, driven by real work instead of a fixed
    // animation ----
    //
    // A caller sizes the bar upfront with addLoadProgressUnits() (see the
    // pre-scan pass in uploadCSV/addTablesCSV/loadCloudWorkspace) before
    // starting the real parse/insert work, then the chunked loops in
    // csv-parser.js/json-parser.js call advanceLoadProgress() as each chunk
    // actually finishes. The unit is deliberately rough (roughly "one row
    // processed, in whichever phase"), not a byte-exact measure — that's
    // fine because the fill is capped below 100% until completeLoadProgress()
    // is called explicitly, so overestimating the total just means the bar
    // holds a little below full instead of overshooting.
    let loadProgressTotal = 0;
    let loadProgressDone = 0;

    function resetLoadProgress() {
      loadProgressTotal = 0;
      loadProgressDone = 0;
      setLoadingFillPct(0);
    }

    function addLoadProgressUnits(n) {
      loadProgressTotal += n;
    }

    function advanceLoadProgress(n) {
      loadProgressDone += n;
      const pct = loadProgressTotal > 0 ? (loadProgressDone / loadProgressTotal) * 100 : 0;
      setLoadingFillPct(Math.min(99, pct));
    }

    function setLoadingFillPct(pct) {
      const fill = document.getElementById('loading-fill');
      if (fill) fill.style.width = pct + '%';
    }

    // Snaps to 100 and gives the fill a moment to actually paint that last
    // stretch before tearing the overlay down, instead of jumping straight
    // from "in progress" to gone.
    function completeLoadProgress(cb) {
      setLoadingFillPct(100);
      setTimeout(() => {
        hideLoadingOverlay();
        if (cb) cb();
      }, 200);
    }

    // Reads every file's text upfront (cheap — this is I/O, not the CPU-heavy
    // part) so the progress bar's total is fixed before the real parse/insert
    // work starts. Sizing it here, once, instead of letting each file add its
    // own units as it's reached, avoids the bar jumping backward mid-upload
    // when a later file's units get added on top of an already-mostly-done
    // earlier one. Returns a Map of file -> text so callers don't re-read it.
    async function sizeLoadProgress(files) {
      const fileTexts = new Map();
      for (const file of files) {
        const text = await file.text();
        fileTexts.set(file, text);
        const lineCount = Math.max(1, text.split('\n').length);
        // parseJSONText walks its records 3 times (flatten, then union the
        // header keys, then build rows); parseCSVText walks its lines once.
        // Both then pass through normalizeThousandsSeparators (1 more pass)
        // and loadFileAsTable's insert (1 more). Weighting the estimate by
        // phase count keeps JSON and CSV uploads proportional to each other
        // instead of JSON always racing ahead of its real progress.
        const phases = isJSONFile(file.name) ? 5 : 3;
        addLoadProgressUnits(lineCount * phases);
      }
      return fileTexts;
    }

    function revealApp() {
      setActiveView('app');
    }

    // Schema text for every table in the workspace — what the AI's system
    // prompt gets. Validated (see phase-1 brainstorm notes) that giving the
    // model every table's schema, plus a focus-table hint, produces correct
    // cross-table joins without over-restricting it to one table.
    window.runQuery = async function() {
      const query = document.getElementById('query-input').value.trim();
      if (!query) return;

      const resultsEl = document.getElementById('results');
      const errorEl = document.getElementById('error');

      errorEl.textContent = '';
      errorEl.style.display = 'none';
      resultsEl.innerHTML = '<div class="loading">Running query...</div>';
      lastResultsSql = query;

      try {
        const result = db.exec(query);

        // A query that isn't a read (INSERT/UPDATE/DELETE/etc.) changes
        // the data sql.js holds in-browser, which the cloud copy — if
        // any — now no longer matches.
        if (!/^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(query)) { markWorkspaceDirty(); columnStatsCache = null; }

        if (result.length === 0) {
          resultsEl.innerHTML = '<div class="empty">No results</div>';
          viewStates.results.columns = [];
          viewStates.results.rows = [];
          setExportButtonVisible('results', false);
          setResultsRowCountText('');
          if (!document.getElementById('results-chart-panel').hidden) renderResultsChart();
          return;
        }

        renderTable('results', 'results', result);
        maybeShowSaveSessionBanner();
        if (!document.getElementById('results-chart-panel').hidden) renderResultsChart();

      } catch (err) {
        resultsEl.innerHTML = '';
        viewStates.results.columns = [];
        viewStates.results.rows = [];
        setExportButtonVisible('results', false);
        setResultsRowCountText('');
        if (!document.getElementById('results-chart-panel').hidden) renderResultsChart();
        let errorMsg = err.message;

        // Add helpful suggestions for common errors
        if (errorMsg.includes('syntax error')) {
          errorMsg += '\n\n💡 Tip: Check for missing spaces between keywords (e.g., "SELECT column FROM" not "SELECT columnFROM")';
        } else if (errorMsg.includes('no such column')) {
          const columns = getCurrentColumns();
          errorMsg += columns
            ? `\n\n💡 Tip: Column names are case-sensitive. Available columns: ${columns.join(', ')}`
            : '\n\n💡 Tip: Column names are case-sensitive.';
        } else if (errorMsg.includes('no such table')) {
          const names = tables.map(t => t.name).join(', ');
          errorMsg += names
            ? `\n\n💡 Tip: Tables in this workspace: ${names}`
            : '\n\n💡 Tip: Upload a CSV first to create a table.';
        }

        errorEl.textContent = errorMsg;
        errorEl.style.display = 'block';
        errorEl.style.whiteSpace = 'pre-wrap';
      }
    };

    // ---- Drag-to-resize panes: SQL editor <-> Query Results (height), and
    // left pane <-> AI assistant (width). Plain mouse events, matching the
    // drag-to-connect relationships feature. Session-only — not persisted
    // across reloads. Inert below the 1024px breakpoint, where .workspace
    // stacks into a single column (see .pane-resizer-v's [hidden] rule and
    // the matching guard in startPaneDrag).

    let paneDragState = null; // { type: 'h' | 'v', resizerEl, startX/startY, startHeight/startWidth }

    function startPaneDrag(event, type) {
      if (window.innerWidth <= 1024) return;
      event.preventDefault();
      const resizerEl = event.currentTarget;
      resizerEl.classList.add('is-dragging');
      document.body.classList.add(type === 'h' ? 'resizing-row' : 'resizing-col');

      if (type === 'h') {
        const editorSection = document.querySelector('.editor-section');
        paneDragState = { type, resizerEl, startY: event.clientY, startHeight: editorSection.getBoundingClientRect().height };
      } else {
        const leftPane = document.querySelector('.left-pane');
        paneDragState = { type, resizerEl, startX: event.clientX, startWidth: leftPane.getBoundingClientRect().width };
      }

      document.addEventListener('mousemove', onPaneDragMove);
      document.addEventListener('mouseup', onPaneDragEnd);
    }

    function onPaneDragMove(event) {
      if (!paneDragState) return;

      if (paneDragState.type === 'h') {
        const editorSection = document.querySelector('.editor-section');
        const leftPane = document.querySelector('.left-pane');
        const RESIZER_SIZE = 8;
        // Matches the editor section's natural content height at the
        // textarea's own min-height (label row + 120px textarea + the
        // Run/Save/Load Query button row + padding) — going any smaller
        // clips or scroll-hides the buttons instead of shrinking the query
        // textarea, which is exactly the kind of breakage this needed to
        // be tested for.
        const MIN_EDITOR = 264;
        const MIN_RESULTS = 140;

        const dy = event.clientY - paneDragState.startY;
        const leftPaneHeight = leftPane.getBoundingClientRect().height;
        const maxHeight = Math.max(MIN_EDITOR, leftPaneHeight - RESIZER_SIZE - MIN_RESULTS);
        const newHeight = Math.min(Math.max(paneDragState.startHeight + dy, MIN_EDITOR), maxHeight);
        editorSection.style.flex = `0 0 ${newHeight}px`;
      } else {
        const workspace = document.querySelector('.workspace');
        const RESIZER_SIZE = 8;
        // Below this, the AI assistant header (label + Clear Session +
        // the on/off toggle) no longer fits on one line even with
        // flex-wrap, so keep both panes at least this wide.
        const MIN_PANE = 340;

        const dx = event.clientX - paneDragState.startX;
        const workspaceWidth = workspace.getBoundingClientRect().width;
        const maxWidth = Math.max(MIN_PANE, workspaceWidth - RESIZER_SIZE - MIN_PANE);
        const newWidth = Math.min(Math.max(paneDragState.startWidth + dx, MIN_PANE), maxWidth);
        workspace.style.gridTemplateColumns = `${newWidth}px ${RESIZER_SIZE}px 1fr`;
      }
    }

    function onPaneDragEnd() {
      if (!paneDragState) return;
      paneDragState.resizerEl.classList.remove('is-dragging');
      document.body.classList.remove('resizing-row', 'resizing-col');
      paneDragState = null;
      document.removeEventListener('mousemove', onPaneDragMove);
      document.removeEventListener('mouseup', onPaneDragEnd);
    }

    // A resize crossing the 1024px breakpoint (e.g. shrinking the browser
    // window after dragging) must drop these inline overrides — otherwise
    // they'd outrank the mobile stacked-layout CSS, which relies on
    // .workspace having exactly 2 grid items instead of 3.
    function clearPaneOverridesForMobile() {
      if (window.innerWidth > 1024) return;
      const workspace = document.querySelector('.workspace');
      const editorSection = document.querySelector('.editor-section');
      if (workspace) workspace.style.gridTemplateColumns = '';
      if (editorSection) editorSection.style.flex = '';
    }

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    });

    // ---- Dismissing modals: Escape and backdrop click ----
    // Every .modal-overlay only ever closed via its own explicit close
    // button. Escape and clicking outside the card now work everywhere too,
    // routed through each modal's own close function (not just hiding the
    // overlay) so whatever cleanup that function does — resetting
    // editingQueryId, tablePendingDelete, etc. — still runs.
    const MODAL_CLOSE_FN = {
      'premium-modal': 'closePremiumPanel',
      'enterprise-access-modal': 'closeEnterpriseAccessModal',
      'enterprise-usage-modal': 'closeEnterpriseUsageModal',
      'premium-signin-modal': 'closePremiumSigninModal',
      'signin-required-modal': 'closeSigninRequiredModal',
      'account-modal': 'closeAccountModal',
      'workspace-notice-modal': 'closeWorkspaceNoticeModal',
      'settings-modal': 'closeSettingsPanel',
      'cancel-premium-modal': 'closeCancelPremiumModal',
      'cloud-modal': 'closeCloudPanel',
      'help-modal': 'closeHelpPanel',
      'save-query-modal': 'closeSaveQueryModal',
      'chart-fullscreen-modal': 'closeChartFullscreen',
      'load-query-modal': 'closeLoadQueryModal',
      'delete-query-modal': 'closeDeleteQueryModal',
      'delete-table-modal': 'closeDeleteTableModal',
      'relationship-type-modal': 'closeRelationshipTypeModal',
      'delete-workspace-modal': 'closeDeleteWorkspaceModal',
      'switch-workspace-modal': 'closeSwitchWorkspaceModal',
    };

    function closeModalOverlay(overlay) {
      const closeFn = MODAL_CLOSE_FN[overlay.id];
      if (closeFn && typeof window[closeFn] === 'function') window[closeFn]();
      else overlay.hidden = true;
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const openModal = document.querySelector('.modal-overlay:not([hidden])');
      if (openModal) closeModalOverlay(openModal);
    });

    // ---- Modal accessibility: focus trap + aria wiring ----
    // Wired centrally off the `hidden` attribute instead of from each of
    // the ~20 open*/close* function pairs throughout this file, auth.js,
    // and checkout.js — a MutationObserver means none of them needs to
    // remember to call anything, and a modal added later gets this for
    // free just by using the .modal-overlay/.modal markup convention.
    (function setupModalAccessibility() {
      const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const isVisible = (el) => el.offsetParent !== null;

      // A stack, not a single slot: closing an inner modal opened from
      // within an outer one (e.g. a delete confirmation) should hand Tab-
      // trapping back to the outer modal, not drop it entirely.
      const trapStack = [];

      function trapKeydown(e) {
        if (e.key !== 'Tab' || trapStack.length === 0) return;
        const overlay = trapStack[trapStack.length - 1].overlay;
        const focusables = Array.from(overlay.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }

      function activateModal(overlay) {
        trapStack.push({ overlay, trigger: document.activeElement });
        if (trapStack.length === 1) document.addEventListener('keydown', trapKeydown, true);

        const focusables = Array.from(overlay.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
        const target = overlay.querySelector('[autofocus]') || focusables[0];
        if (target) {
          target.focus();
        } else {
          const card = overlay.querySelector('.modal') || overlay;
          if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
          card.focus();
        }
      }

      function deactivateModal(overlay) {
        const i = trapStack.findIndex(t => t.overlay === overlay);
        if (i === -1) return;
        const [{ trigger }] = trapStack.splice(i, 1);
        if (trapStack.length === 0) document.removeEventListener('keydown', trapKeydown, true);
        if (trigger && typeof trigger.focus === 'function' && document.body.contains(trigger)) {
          trigger.focus();
        }
      }

      function wireOverlay(overlay) {
        if (overlay.dataset.a11yWired) return;
        overlay.dataset.a11yWired = 'true';
        if (!overlay.hasAttribute('role')) overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.attributeName !== 'hidden') continue;
            if (overlay.hidden) deactivateModal(overlay);
            else activateModal(overlay);
          }
        }).observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
        if (!overlay.hidden) activateModal(overlay);
      }

      // This script runs in <head>, before the modal markup in <body>
      // exists — same reason the click-delegation listener just below
      // waits for `document` rather than querying elements directly.
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.modal-overlay').forEach(wireOverlay);
      });
    })();

    // Delegated from document (not attached per-element) since this script
    // runs in <head>, before the modal markup in <body> exists yet — a
    // querySelectorAll('.modal-overlay') here would find nothing to attach
    // to. Delegation only needs `document` to exist, which it already does.
    document.addEventListener('click', (e) => {
      if (e.target.classList?.contains('modal-overlay') && !e.target.hidden) {
        closeModalOverlay(e.target);
      }
    });

