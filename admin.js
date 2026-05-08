(function() {
  'use strict';

  // Admin gate: relies on auth.jwt().app_metadata.role === 'admin'
  // (set server-side; not editable by users). Mirrors the RLS check
  // in private.is_admin().

  // ── Toast helper ──
  function showToast(message, type) {
    var existing = document.querySelector('.nbi-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'nbi-toast nbi-toast-' + (type || 'success');
    toast.textContent = message;
    document.body.appendChild(toast);
    void toast.offsetHeight;
    toast.classList.add('show');
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 400);
    }, 3000);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Wait for Supabase client ──
  var sb = null;
  var clients = [];
  var tasks = [];
  var requests = [];
  var disputes = [];
  var employees = [];
  var taskSteps = [];
  var stepProofs = [];
  var employeeMetrics = [];
  var servicePipelines = [];
  var recurringSchedules = [];
  var activeDisputeFilter = 'all';
  var activeEmpFilter = 'all';
  var activeRecurringFilter = 'all';
  var currentDisputeId = null;
  var currentEmployeeId = null;

  function getInitials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (!parts[0]) return '?';
    var first = parts[0].charAt(0);
    var second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + second).toUpperCase();
  }

  function waitForSupabase(cb) {
    if (window.supabaseClient) { sb = window.supabaseClient; cb(); }
    else setTimeout(function() { waitForSupabase(cb); }, 50);
  }

  waitForSupabase(function() {
    // Auth check — must have a Supabase session AND admin role in JWT.
    // localStorage fallback is intentionally gone: an admin session must
    // exist in Supabase auth, otherwise RLS denies every query anyway.
    sb.auth.getSession().then(function(result) {
      var s = result.data && result.data.session;
      if (!s || !s.user) {
        window.location.href = 'login.html';
        return;
      }
      var meta = s.user.app_metadata || {};
      if (meta.role !== 'admin') {
        window.location.href = 'login.html';
        return;
      }
      loadDashboard();
    });
  });

  // ── Greeting ──
  var hour = new Date().getHours();
  var greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('admGreeting').textContent = greet + ' \uD83D\uDC4B Here\'s your overview';
  var now = new Date();
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('admDate').textContent =
    days[now.getDay()] + ', ' + String(now.getDate()).padStart(2,'0') + ' ' + months[now.getMonth()] + ' ' + now.getFullYear();

  var appointments = [];

  // ── Load all data ──
  function loadDashboard() {
    Promise.all([
      sb.from('clients').select('*').order('created_at', { ascending: false }),
      sb.from('tasks').select('*, clients(name, email, city, country)').order('deadline', { ascending: true }),
      sb.from('requests').select('*').order('created_at', { ascending: false }),
      sb.from('appointments').select('*').order('created_at', { ascending: false }),
      sb.from('disputes').select('*').order('created_at', { ascending: false }),
      sb.from('employees').select('*').order('created_at', { ascending: false }),
      sb.from('task_steps').select('*').order('created_at', { ascending: true }),
      sb.from('step_proofs').select('*').order('round', { ascending: true }),
      sb.from('employee_metrics').select('*').order('performance_score', { ascending: false }),
      sb.from('service_pipelines').select('*').order('pipeline_key', { ascending: true }),
      sb.from('recurring_schedules').select('*').order('next_due_at', { ascending: true })
    ]).then(function(results) {
      if (results[0].error) console.error('Clients fetch error:', results[0].error);
      if (results[1].error) console.error('Tasks fetch error:', results[1].error);
      if (results[2].error) console.error('Requests fetch error:', results[2].error);
      if (results[3].error) console.error('Appointments fetch error:', results[3].error);
      if (results[4].error) console.error('Disputes fetch error:', results[4].error);
      if (results[5].error) console.error('Employees fetch error:', results[5].error);
      if (results[6] && results[6].error) console.error('Task steps fetch error:', results[6].error);
      if (results[7] && results[7].error) console.error('Step proofs fetch error:', results[7].error);
      if (results[8] && results[8].error) console.error('Employee metrics fetch error:', results[8].error);
      if (results[9] && results[9].error) console.error('Service pipelines fetch error:', results[9].error);
      if (results[10] && results[10].error) console.error('Recurring schedules fetch error:', results[10].error);

      clients = results[0].data || [];
      tasks = results[1].data || [];
      requests = results[2].data || [];
      appointments = results[3].data || [];
      disputes = results[4].data || [];
      employees = results[5].data || [];
      taskSteps = (results[6] && results[6].data) || [];
      stepProofs = (results[7] && results[7].data) || [];
      employeeMetrics = (results[8] && results[8].data) || [];
      servicePipelines = (results[9] && results[9].data) || [];
      recurringSchedules = (results[10] && results[10].data) || [];

      console.log('Dashboard loaded:', { clients: clients.length, tasks: tasks.length, requests: requests.length, appointments: appointments.length, disputes: disputes.length, employees: employees.length, taskSteps: taskSteps.length, stepProofs: stepProofs.length });
      renderStats();
      renderOperationsBoard();
      populateOpsFilters();
      renderTaskTable();
      renderClientsByService();
      renderPendingByCategory();
      renderRequests();
      renderAppointments();
      renderBadges();
      renderDisputes();
      renderEmployeesTable();
      renderScoreCards();
      renderLeaderboard();
      renderEscalations();
      renderProofQueue();
    });
  }

  // ── Stats ──
  function renderStats() {
    var activeCount = clients.filter(function(c) { return c.status === 'Active'; }).length;
    var pendingTasks = tasks.filter(function(t) { return t.status === 'Pending' || t.status === 'In Progress'; }).length;
    var completedTasks = tasks.filter(function(t) { return t.status === 'Completed'; }).length;
    var openRequests = requests.filter(function(r) { return r.status === 'New' || r.status === 'In Review'; }).length;

    document.getElementById('statClients').textContent = clients.length;
    document.getElementById('statClientsSub').textContent = '+' + activeCount + ' this month';
    document.getElementById('statPending').textContent = pendingTasks;
    document.getElementById('statPendingSub').textContent = pendingTasks > 0 ? 'Needs attention' : 'All clear';
    document.getElementById('statCompleted').textContent = completedTasks;
    document.getElementById('statCompletedSub').textContent = '+' + completedTasks + ' this month';
    document.getElementById('statRequests').textContent = openRequests;
    document.getElementById('statRequestsSub').textContent = openRequests > 0 ? 'Awaiting review' : 'All handled';
  }

  // ── Badges ──
  function renderBadges() {
    document.getElementById('badgeClients').textContent = clients.length;
    var pendingTasks = tasks.filter(function(t) { return t.status !== 'Completed'; }).length;
    document.getElementById('badgeTasks').textContent = pendingTasks;
    var openReqs = requests.filter(function(r) { return r.status === 'New' || r.status === 'In Review'; }).length;
    document.getElementById('badgeRequests').textContent = openReqs;
    var newAppts = appointments.filter(function(a) { return a.status === 'New'; }).length;
    document.getElementById('badgeAppts').textContent = newAppts;
    document.getElementById('badgeEmployees').textContent = employees.length;
    var pendingEmps = employees.filter(function(e) { return e.status === 'pending'; }).length;
    document.getElementById('badgeEmployeesPending').textContent = pendingEmps;
    var openDisputes = disputes.filter(function(d) {
      return ['New', 'In Review', 'Waiting for Customer'].indexOf(d.status) !== -1;
    }).length;
    document.getElementById('badgeDisputes').textContent = openDisputes;

    var escCount = disputes.filter(function(d) {
      return d.source === 'step_escalation' && d.status !== 'Resolved';
    }).length;
    var escBadge = document.getElementById('badgeEscalations');
    if (escBadge) escBadge.textContent = escCount;

    var recBadge = document.getElementById('badgeRecurring');
    if (recBadge) {
      var activeRec = recurringSchedules.filter(function(r) { return r.active; }).length;
      recBadge.textContent = activeRec;
    }
  }

  // ── Task Table ──
  function statusClass(s) {
    return s.toLowerCase().replace(/\s+/g, '-');
  }

  function progressColor(status) {
    if (status === 'In Progress') return 'green';
    if (status === 'Pending') return 'orange';
    if (status === 'In Review') return 'blue';
    return 'muted';
  }

  function formatDate(d) {
    if (!d) return '—';
    var dt = new Date(d);
    return months[dt.getMonth()] + ' ' + String(dt.getDate()).padStart(2, '0');
  }

  var activeTaskFilter = 'all';

  function renderTaskTable(filter) {
    filter = filter || 'all';
    activeTaskFilter = filter;
    var tbody = document.getElementById('taskTableBody');
    var filtered = tasks;
    if (filter === 'pending') {
      filtered = tasks.filter(function(t) { return t.status !== 'Completed'; });
    } else if (filter === 'completed') {
      filtered = tasks.filter(function(t) { return t.status === 'Completed'; });
    }
    if (filtered.length === 0) {
      var msg = filter === 'all' ? 'No tasks yet' : 'No ' + filter + ' tasks';
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">' + msg + '</td></tr>';
      return;
    }
    var html = '';
    filtered.forEach(function(t) {
      var client = t.clients || {};
      var clientName = client.name || t.description || '—';
      var clientLoc = [client.city, client.country].filter(Boolean).join(', ');
      var assigneeHtml = '—';
      if (t.assigned_employee_email) {
        var emp = employees.find(function(e) { return e.email === t.assigned_employee_email; });
        var empName = emp ? emp.name : t.assigned_employee_email;
        assigneeHtml = '<div class="adm-assignee-cell"><span class="adm-assignee-name">' + escapeHtml(empName) + '</span>' +
          (emp && emp.city ? '<span class="adm-client-loc">' + escapeHtml(emp.city) + '</span>' : '') + '</div>';
      }
      html +=
        '<tr class="adm-task-row" data-task-id="' + t.id + '" style="cursor:pointer;" title="Click to edit">' +
          '<td><div class="adm-client-cell"><span class="adm-client-name">' + clientName + '</span><span class="adm-client-loc">' + clientLoc + '</span></div></td>' +
          '<td>' + (t.service || '—') + '</td>' +
          '<td>' + assigneeHtml + '</td>' +
          '<td><span class="adm-status-badge ' + statusClass(t.status) + '">' + t.status + '</span></td>' +
          '<td><div class="adm-progress-bar"><div class="adm-progress-fill ' + progressColor(t.status) + '" style="width:' + (t.progress || 0) + '%;"></div></div><span class="adm-progress-pct">' + (t.progress || 0) + '%</span></td>' +
          '<td class="adm-deadline">' + formatDate(t.deadline) + '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;

    // Attach click handlers
    document.querySelectorAll('.adm-task-row').forEach(function(row) {
      row.addEventListener('click', function() {
        openTaskEdit(this.getAttribute('data-task-id'));
      });
    });
  }

  // ── Clients by Service ──
  var AVATAR_COLORS = ['green', 'orange', 'blue', 'red', 'muted'];

  function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
  }

  // Always include standard service categories
  var STANDARD_SERVICES = ['Property', 'Tax Filing', 'Banking', 'Aadhaar/OCI', 'Legal'];

  function getServiceCategories() {
    var cats = ['All'];
    STANDARD_SERVICES.forEach(function(s) { cats.push(s); });
    clients.forEach(function(c) {
      (c.services || []).forEach(function(s) {
        if (cats.indexOf(s) === -1) cats.push(s);
      });
    });
    return cats;
  }

  function renderClientsByService(filter) {
    filter = filter || 'All';
    var SERVICE_CATEGORIES = getServiceCategories();

    // Tabs
    var tabsHtml = '';
    SERVICE_CATEGORIES.forEach(function(cat) {
      tabsHtml += '<button class="adm-filter-tab' + (cat === filter ? ' active' : '') + '" data-filter="' + cat + '">' + cat + '</button>';
    });
    document.getElementById('filterTabs').innerHTML = tabsHtml;

    // Attach tab clicks
    document.querySelectorAll('.adm-filter-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        renderClientsByService(this.getAttribute('data-filter'));
      });
    });

    // Filter clients
    var filtered = clients;
    if (filter !== 'All') {
      filtered = clients.filter(function(c) {
        return c.services && c.services.indexOf(filter) !== -1;
      });
    }

    var listHtml = '';
    filtered.forEach(function(c, i) {
      var color = AVATAR_COLORS[i % AVATAR_COLORS.length];
      var services = c.services || [];
      var stClass = statusClass(c.status || 'Pending');
      var location = [c.city, c.country].filter(Boolean).join(', ');

      // Build inline service + location subtitle
      var subtitleParts = [];
      if (location) subtitleParts.push(location);
      if (services.length > 0) subtitleParts.push(services.join(' + '));
      var subtitle = subtitleParts.join(' · ') || 'No services yet';

      listHtml +=
        '<div class="adm-client-row" data-client-id="' + c.id + '" style="cursor:pointer;" title="Click for details">' +
          '<div class="adm-avatar ' + color + '">' + getInitials(c.name) + '</div>' +
          '<div class="adm-client-info">' +
            '<strong>' + (c.name || 'Unknown') + '</strong>' +
            '<span>' + subtitle + '</span>' +
          '</div>' +
          '<div class="adm-client-status ' + stClass + '">' + (c.status || 'Pending') + '</div>' +
        '</div>';
    });

    if (filtered.length === 0) {
      listHtml = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.88rem;">No clients in this category</div>';
    }
    document.getElementById('clientList').innerHTML = listHtml;

    // Attach click handlers for client detail
    document.querySelectorAll('.adm-client-row[data-client-id]').forEach(function(row) {
      row.addEventListener('click', function() {
        openClientDetail(this.getAttribute('data-client-id'));
      });
    });
  }

  // ── Pending by Category ──
  function renderPendingByCategory() {
    var counts = {};
    var notes = {};
    tasks.forEach(function(t) {
      if (t.status === 'Completed') return;
      var svc = t.service.replace(/\s*(Legal|Reg\.)/, ' & $1').split(' ')[0];
      // Normalize
      if (t.service.indexOf('Property') !== -1 || t.service.indexOf('Legal') !== -1) svc = 'Property & Legal';
      else if (t.service.indexOf('Tax') !== -1) svc = 'Tax Filing';
      else if (t.service.indexOf('Bank') !== -1) svc = 'Bank & Finance';
      else if (t.service.indexOf('Aadhaar') !== -1) svc = 'Aadhaar / OCI';
      else svc = t.service;

      counts[svc] = (counts[svc] || 0) + 1;
    });

    // Context notes
    notes['Property & Legal'] = 'Docs missing for clients';
    notes['Tax Filing'] = 'Due this week';
    notes['Bank & Finance'] = 'Awaiting KYC upload';
    notes['Aadhaar / OCI'] = 'Govt. portal processing';

    var html = '';
    Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).forEach(function(cat) {
      html +=
        '<div class="adm-pending-item">' +
          '<div class="adm-pending-num">' + counts[cat] + '</div>' +
          '<div class="adm-pending-info">' +
            '<strong>' + cat + '</strong>' +
            '<span>' + (notes[cat] || '') + '</span>' +
          '</div>' +
        '</div>';
    });

    if (Object.keys(counts).length === 0) {
      html = '<div style="color:var(--text-muted);font-size:0.88rem;">All caught up!</div>';
    }
    document.getElementById('pendingByCategory').innerHTML = html;
  }

  // ── Custom Requests ──
  function renderRequests() {
    var html = '';
    requests.forEach(function(r) {
      var stClass = statusClass(r.status);
      var actionsHtml = '';
      var amountDisplay = '';

      if (r.status === 'New') {
        actionsHtml =
          '<div class="adm-request-actions">' +
            '<button class="adm-req-btn adm-req-accept" data-id="' + r.id + '">Review &amp; Quote</button>' +
            '<button class="adm-req-btn adm-req-decline" data-id="' + r.id + '">Decline</button>' +
          '</div>';
      } else if (r.status === 'Quoted') {
        amountDisplay = '\u20B9' + (r.quoted_amount || 0).toLocaleString('en-IN');
        var responseNote = r.customer_response
          ? ' \u00B7 Customer ' + r.customer_response
          : ' \u00B7 Awaiting customer response';
        actionsHtml = '<span style="font-size:0.75rem;color:var(--text-muted);">' + responseNote + '</span>';
      } else if (r.status === 'Accepted') {
        amountDisplay = '\u20B9' + (r.quoted_amount || r.amount || 0).toLocaleString('en-IN');
        actionsHtml = '<span class="adm-status-badge accepted" style="font-size:0.72rem;">Accepted</span>';
      } else if (r.status === 'Declined') {
        actionsHtml = '<span class="adm-status-badge declined" style="font-size:0.72rem;">Declined</span>';
      } else {
        actionsHtml = '<span class="adm-status-badge ' + stClass + '" style="font-size:0.72rem;">' + r.status + '</span>';
      }

      if (!amountDisplay && r.amount) {
        amountDisplay = '\u20B9' + r.amount.toLocaleString('en-IN');
      }

      html +=
        '<div class="adm-request-card">' +
          '<div class="adm-request-head">' +
            '<span class="adm-status-badge ' + stClass + '" style="font-size:0.7rem;">' + r.status + '</span>' +
            '<strong>' + r.client_name + '</strong>' +
            (amountDisplay ? '<span class="adm-request-amount">' + amountDisplay + '</span>' : '') +
          '</div>' +
          '<div class="adm-request-desc">' + (r.description || '') + '</div>' +
          '<div class="adm-request-foot">' +
            '<span class="adm-request-date">Received: ' + formatDate(r.received_at) + '</span>' +
            actionsHtml +
          '</div>' +
        '</div>';
    });

    if (requests.length === 0) {
      html = '<div style="color:var(--text-muted);font-size:0.88rem;padding:16px 0;">No requests yet</div>';
    }
    document.getElementById('requestsList').innerHTML = html;

    // Attach Review & Quote handler
    document.querySelectorAll('.adm-req-accept').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        openQuoteModal(id);
      });
    });
    // Attach Decline handler
    document.querySelectorAll('.adm-req-decline').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        sb.from('requests').update({ status: 'Declined' }).eq('id', id).then(function(result) {
          if (result.error) { showToast('Failed to decline', 'error'); return; }
          showToast('Request declined', 'info');
          loadDashboard();
        });
      });
    });
  }

  // ── Quotation Modal Logic ──
  var quoteModalEl = document.getElementById('quoteModal');
  var currentQuoteId = null;

  function createLineItemRow(desc, amt) {
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center;';
    row.innerHTML =
      '<input type="text" class="q-desc" placeholder="Description (e.g. Document fee)" value="' + (desc || '') + '" style="flex:2;padding:9px 12px;border:1.5px solid #d4d2c8;border-radius:10px;font-family:DM Sans,sans-serif;font-size:0.84rem;background:var(--bg-cream);outline:none;">' +
      '<input type="number" class="q-amt" placeholder="Amount" value="' + (amt || '') + '" style="flex:1;padding:9px 12px;border:1.5px solid #d4d2c8;border-radius:10px;font-family:DM Sans,sans-serif;font-size:0.84rem;background:var(--bg-cream);outline:none;min-width:90px;">' +
      '<button type="button" style="background:none;border:none;color:#dc3545;cursor:pointer;font-size:1.1rem;padding:4px;" onclick="this.parentElement.remove();updateQuoteTotal();">\u00D7</button>';
    row.querySelectorAll('.q-amt').forEach(function(inp) {
      inp.addEventListener('input', updateQuoteTotal);
    });
    return row;
  }

  window.updateQuoteTotal = function() {
    var total = 0;
    document.querySelectorAll('#qLineItems .q-amt').forEach(function(inp) {
      total += parseInt(inp.value) || 0;
    });
    document.getElementById('qTotal').textContent = '\u20B9' + total.toLocaleString('en-IN');
  };

  function openQuoteModal(requestId) {
    currentQuoteId = requestId;
    var req = requests.find(function(r) { return r.id === requestId; });
    if (!req) return;

    document.getElementById('qClientName').textContent = req.client_name + (req.customer_email ? ' (' + req.customer_email + ')' : '');
    document.getElementById('qDescription').textContent = req.description || '';

    // Reset line items
    var container = document.getElementById('qLineItems');
    container.innerHTML = '';
    container.appendChild(createLineItemRow('', ''));
    document.getElementById('qTotal').textContent = '\u20B90';

    // Mark as In Review
    sb.from('requests').update({ status: 'In Review' }).eq('id', requestId).then(function() {});

    quoteModalEl.style.display = 'flex';
    void quoteModalEl.offsetHeight;
    quoteModalEl.classList.add('show');
  }

  function closeQuoteModal() {
    quoteModalEl.classList.remove('show');
    setTimeout(function() { quoteModalEl.style.display = 'none'; }, 300);
    currentQuoteId = null;
  }

  document.getElementById('qAddItem').addEventListener('click', function() {
    document.getElementById('qLineItems').appendChild(createLineItemRow('', ''));
  });

  document.getElementById('qCancel').addEventListener('click', closeQuoteModal);
  quoteModalEl.addEventListener('click', function(e) { if (e.target === quoteModalEl) closeQuoteModal(); });

  document.getElementById('qSubmit').addEventListener('click', function() {
    if (!currentQuoteId) return;

    var items = [];
    var total = 0;
    document.querySelectorAll('#qLineItems > div').forEach(function(row) {
      var desc = row.querySelector('.q-desc').value.trim();
      var amt = parseInt(row.querySelector('.q-amt').value) || 0;
      if (desc && amt > 0) {
        items.push({ description: desc, amount: amt });
        total += amt;
      }
    });

    if (items.length === 0) {
      showToast('Add at least one line item with a price', 'error');
      return;
    }

    sb.from('requests').update({
      status: 'Quoted',
      quoted_amount: total,
      quote_items: items,
      quoted_at: new Date().toISOString()
    }).eq('id', currentQuoteId).then(function(result) {
      if (result.error) {
        showToast('Failed to send quotation: ' + result.error.message, 'error');
        return;
      }
      showToast('Quotation sent to customer', 'success');
      closeQuoteModal();
      loadDashboard();
    });
  });

  // ── Call Appointments ──
  function renderAppointments() {
    var html = '';
    appointments.forEach(function(a) {
      var stClass = statusClass(a.status);
      var actionsHtml = '';
      if (a.status === 'New') {
        actionsHtml =
          '<div class="adm-request-actions">' +
            '<button class="adm-req-btn adm-req-accept appt-done" data-id="' + a.id + '">Mark Contacted</button>' +
          '</div>';
      } else {
        actionsHtml = '<span class="adm-status-badge ' + stClass + '" style="font-size:0.72rem;">' + a.status + '</span>';
      }

      html +=
        '<div class="adm-request-card">' +
          '<div class="adm-request-head">' +
            '<span class="adm-status-badge ' + stClass + '" style="font-size:0.7rem;">' + a.status + '</span>' +
            '<strong>' + a.name + '</strong>' +
          '</div>' +
          '<div class="adm-request-desc">' +
            (a.email ? a.email + '<br>' : '') +
            (a.phone ? a.phone + '<br>' : '') +
            (a.message || '') +
          '</div>' +
          '<div class="adm-request-foot">' +
            '<span class="adm-request-date">' + formatDate(a.created_at) + '</span>' +
            actionsHtml +
          '</div>' +
        '</div>';
    });

    if (appointments.length === 0) {
      html = '<div style="color:var(--text-muted);font-size:0.88rem;padding:16px 0;">No appointments yet</div>';
    }
    document.getElementById('appointmentsList').innerHTML = html;

    document.querySelectorAll('.appt-done').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        sb.from('appointments').update({ status: 'Contacted' }).eq('id', id).then(function(result) {
          if (result.error) { showToast('Failed to update', 'error'); return; }
          showToast('Marked as contacted', 'success');
          loadDashboard();
        });
      });
    });
  }

  // ── Add Client Modal ──
  var modal = document.getElementById('addClientModal');

  function openAddClient() {
    modal.style.display = 'flex';
    void modal.offsetHeight;
    modal.classList.add('show');
  }
  function closeAddClient() {
    modal.classList.remove('show');
    setTimeout(function() { modal.style.display = 'none'; }, 300);
  }

  document.getElementById('btnAddClient').addEventListener('click', openAddClient);
  document.getElementById('navAddClient').addEventListener('click', openAddClient);
  document.getElementById('acCancel').addEventListener('click', closeAddClient);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeAddClient(); });

  document.getElementById('acSubmit').addEventListener('click', function() {
    var name = document.getElementById('acName').value.trim();
    var email = document.getElementById('acEmail').value.trim();
    var city = document.getElementById('acCity').value.trim();
    var country = document.getElementById('acCountry').value.trim();
    var status = document.getElementById('acStatus').value;

    if (!name) { showToast('Please enter a name', 'error'); return; }

    var services = [];
    document.querySelectorAll('.adm-form-checks input:checked').forEach(function(cb) {
      services.push(cb.value);
    });

    sb.from('clients').insert([{
      name: name, email: email, city: city, country: country,
      services: services, status: status
    }]).select().then(function(result) {
      if (result.error) {
        showToast('Failed to add client: ' + result.error.message, 'error');
        console.error('Insert error:', result.error);
        return;
      }
      showToast('Client added successfully', 'success');
      closeAddClient();
      // Reset form
      document.getElementById('acName').value = '';
      document.getElementById('acEmail').value = '';
      document.getElementById('acCity').value = '';
      document.getElementById('acCountry').value = '';
      document.querySelectorAll('.adm-form-checks input:checked').forEach(function(cb) { cb.checked = false; });
      loadDashboard();
    }).catch(function(err) {
      showToast('Error: ' + err.message, 'error');
      console.error('Insert exception:', err);
    });
  });

  // ── Service Pipelines (matching customer dashboard) ──
  var SERVICE_PIPELINES = {
    home: {
      steps: ['Onboarding & PoA', 'Property Inspection', 'Tenant Acquisition', 'Lease & Registration', 'Rent Collection'],
      descriptions: [
        'Collecting property documents. Power of Attorney execution initiated.',
        'Physical inspection underway. Condition report & society NOC being obtained.',
        'Property listed. Screening tenants — ID verification, background check.',
        'Drafting rental agreement on stamp paper. Sub-Registrar registration scheduled.',
        'First rent collected. TDS compliance handled. Monthly reports begun.'
      ]
    },
    vehicle: {
      steps: ['Document Verification', 'Insurance Assessment', 'Owner Approval', 'Policy Issuance', 'Ongoing Monitoring'],
      descriptions: [
        'Collecting RC, previous insurance, PUC. Verifying ownership chain.',
        'Gathering quotes from 3+ insurers. Comparing coverage options.',
        'Insurance comparison sheet ready. Awaiting owner approval.',
        'KYC completed, payment processed. Digital policy issued.',
        'Calendar reminders set for renewals. Periodic checks scheduled.'
      ]
    },
    parental: {
      steps: ['Health Profile Setup', 'Coordinator Assigned', 'Initial Check-up', 'Ongoing Care Active'],
      descriptions: [
        'Building digital health vault — medical history, medications, insurance.',
        'Dedicated local coordinator assigned. Emergency contacts verified.',
        'Doctor visit scheduled. Vitals recorded, baseline health report created.',
        'Regular check-ups scheduled. Medicine tracking active. 24/7 helpline live.'
      ]
    },
    legal: {
      steps: ['Document Collection', 'Review & Computation', 'Filing & Submission', 'Verification & Closure'],
      descriptions: [
        'Gathering PAN, Passport, bank statements, Form 16/26AS.',
        'Verifying residential status. Selecting ITR form. Computing tax liability.',
        'E-filing on incometax.gov.in in progress. E-verification initiated.',
        'CPC processed return. ITR-V received. Refund processed if applicable.'
      ]
    }
  };

  // Map service name strings to pipeline keys
  function getPipelineKey(serviceName) {
    if (!serviceName) return null;
    var s = serviceName.toLowerCase();
    if (s.indexOf('home') !== -1 || s.indexOf('property') !== -1) return 'home';
    if (s.indexOf('vehicle') !== -1) return 'vehicle';
    if (s.indexOf('parental') !== -1 || s.indexOf('care') !== -1) return 'parental';
    if (s.indexOf('legal') !== -1 || s.indexOf('tax') !== -1 || s.indexOf('document') !== -1) return 'legal';
    return null;
  }

  // ── Task Edit Modal ──
  var teModal = document.getElementById('taskEditModal');
  var currentTaskId = null;
  var currentPipelineStep = -1;

  function serviceToSkillKey(service) {
    var s = (service || '').toLowerCase();
    if (!s) return null;
    if (s.indexOf('tenant') !== -1) return 'Tenant';
    if (s.indexOf('inspect') !== -1) return 'Inspection';
    if (s.indexOf('tax') !== -1) return 'Tax';
    if (s.indexOf('bank') !== -1) return 'Banking';
    if (s.indexOf('legal') !== -1 || s.indexOf('document') !== -1) return 'Legal';
    if (s.indexOf('parental') !== -1 || s.indexOf('care') !== -1) return 'Care';
    if (s.indexOf('vehicle') !== -1) return 'Vehicle';
    if (s.indexOf('home') !== -1 || s.indexOf('property') !== -1 || s.indexOf('rent') !== -1 || s.indexOf('maint') !== -1 || s.indexOf('utility') !== -1 || s.indexOf('lease') !== -1) return 'Property';
    return null;
  }

  function populateAssigneeDropdown(task) {
    var sel = document.getElementById('teAssignee');
    if (!sel) return;
    var approved = employees.filter(function(e) { return e.status === 'approved'; });
    var needed = serviceToSkillKey(task && task.service);
    approved.sort(function(a, b) {
      if (!needed) return (a.name || '').localeCompare(b.name || '');
      var aM = (a.skills || []).indexOf(needed) !== -1 ? 0 : 1;
      var bM = (b.skills || []).indexOf(needed) !== -1 ? 0 : 1;
      if (aM !== bM) return aM - bM;
      return (a.name || '').localeCompare(b.name || '');
    });
    var html = '<option value="">— Unassigned —</option>';
    approved.forEach(function(e) {
      var matches = needed && (e.skills || []).indexOf(needed) !== -1 ? ' ✓' : '';
      html += '<option value="' + escapeHtml(e.email) + '">' + escapeHtml(e.name) + matches + ' · ' + escapeHtml(e.city || '') + '</option>';
    });
    sel.innerHTML = html;
    sel.value = (task && task.assigned_employee_email) || '';
  }

  function renderPipeline(pipelineKey, currentStep) {
    var container = document.getElementById('tePipeline');
    var pipelineGroup = document.getElementById('tePipelineGroup');

    if (!pipelineKey || !SERVICE_PIPELINES[pipelineKey]) {
      pipelineGroup.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    pipelineGroup.style.display = '';
    var pipeline = SERVICE_PIPELINES[pipelineKey];
    var html = '';

    pipeline.steps.forEach(function(step, si) {
      var stepClass = 'te-pipe-step';
      if (si < currentStep) stepClass += ' done';
      else if (si === currentStep) stepClass += ' active';

      var checkIcon = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5 6 5 8.5 9.5 3.5"/></svg>';
      var dotIcon = '<span class="te-pipe-num">' + (si + 1) + '</span>';

      html += '<div class="' + stepClass + '" data-step="' + si + '">' +
        '<div class="te-pipe-indicator">' + (si < currentStep ? checkIcon : dotIcon) + '</div>' +
        '<div class="te-pipe-content">' +
          '<div class="te-pipe-label">' + step + '</div>' +
          '<div class="te-pipe-desc">' + pipeline.descriptions[si] + '</div>' +
        '</div>' +
      '</div>';
    });

    container.innerHTML = html;

    // Attach click handlers to each step
    container.querySelectorAll('.te-pipe-step').forEach(function(el) {
      el.addEventListener('click', function() {
        var stepIdx = parseInt(this.getAttribute('data-step'));
        selectPipelineStep(pipelineKey, stepIdx);
      });
    });
  }

  function selectPipelineStep(pipelineKey, stepIdx) {
    var pipeline = SERVICE_PIPELINES[pipelineKey];
    if (!pipeline) return;

    currentPipelineStep = stepIdx;
    var totalSteps = pipeline.steps.length;
    var progress = Math.round(((stepIdx + 1) / totalSteps) * 100);

    // Auto-set progress
    document.getElementById('teProgress').value = progress;
    document.getElementById('teProgressLabel').textContent = progress + '%';

    // Auto-set status
    var statusEl = document.getElementById('teStatus');
    if (stepIdx === 0 && progress <= 20) {
      statusEl.value = 'Pending';
    } else if (stepIdx >= totalSteps - 1) {
      statusEl.value = 'Completed';
    } else {
      statusEl.value = 'In Progress';
    }

    // Re-render pipeline visual
    renderPipeline(pipelineKey, stepIdx);
  }

  // ── Task-update state ──
  var teInitialStatus = '';
  var teInitialProgress = 0;
  var teSelectedPhotos = [];
  var TE_MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  function openTaskEdit(taskId) {
    var t = tasks.find(function(x) { return x.id === taskId; });
    if (!t) return;
    currentTaskId = taskId;
    var client = t.clients || {};
    document.getElementById('teService').textContent = t.service || '—';
    document.getElementById('teDescription').textContent = t.description || '';
    document.getElementById('teClient').textContent = client.name ? 'Client: ' + client.name : '';
    document.getElementById('teStatus').value = t.status;
    document.getElementById('teProgress').value = t.progress || 0;
    document.getElementById('teProgressLabel').textContent = (t.progress || 0) + '%';
    document.getElementById('teDeadline').value = t.deadline || '';

    // Populate Assigned-to dropdown with approved employees (matching skills first)
    populateAssigneeDropdown(t);

    // Reset update form
    teInitialStatus = t.status || '';
    teInitialProgress = t.progress || 0;
    teSelectedPhotos = [];
    document.getElementById('teUpdateNote').value = '';
    document.getElementById('teUpdatePhotos').value = '';
    document.getElementById('teUpdatePhotoPreviews').innerHTML = '';
    document.getElementById('teUpdatePhotosHint').textContent = 'No photos selected';

    loadTaskTimeline(taskId);

    // Render pipeline stepper
    var pipelineKey = getPipelineKey(t.service);
    if (pipelineKey && SERVICE_PIPELINES[pipelineKey]) {
      var pipeline = SERVICE_PIPELINES[pipelineKey];
      var totalSteps = pipeline.steps.length;
      // Derive current step from saved current_step or from progress %
      var step = typeof t.current_step === 'number' ? t.current_step :
                 Math.min(Math.floor(((t.progress || 0) / 100) * totalSteps), totalSteps - 1);
      if (t.progress >= 100) step = totalSteps - 1;
      currentPipelineStep = step;
      renderPipeline(pipelineKey, step);
    } else {
      currentPipelineStep = -1;
      renderPipeline(null, -1);
    }

    teModal.style.display = 'flex';
    void teModal.offsetHeight;
    teModal.classList.add('show');
  }

  function closeTaskEdit() {
    teModal.classList.remove('show');
    setTimeout(function() { teModal.style.display = 'none'; }, 300);
    currentTaskId = null;
    currentPipelineStep = -1;
  }

  document.getElementById('teProgress').addEventListener('input', function() {
    document.getElementById('teProgressLabel').textContent = this.value + '%';
    // Sync pipeline visual with manual slider change
    var t = tasks.find(function(x) { return x.id === currentTaskId; });
    if (t) {
      var pKey = getPipelineKey(t.service);
      if (pKey && SERVICE_PIPELINES[pKey]) {
        var total = SERVICE_PIPELINES[pKey].steps.length;
        var val = parseInt(this.value);
        var step = val >= 100 ? total - 1 : Math.min(Math.floor((val / 100) * total), total - 1);
        currentPipelineStep = step;
        renderPipeline(pKey, step);
      }
    }
  });

  document.getElementById('teStatus').addEventListener('change', function() {
    if (this.value === 'Completed') {
      document.getElementById('teProgress').value = 100;
      document.getElementById('teProgressLabel').textContent = '100%';
      // Move pipeline to last step
      var t = tasks.find(function(x) { return x.id === currentTaskId; });
      if (t) {
        var pKey = getPipelineKey(t.service);
        if (pKey && SERVICE_PIPELINES[pKey]) {
          currentPipelineStep = SERVICE_PIPELINES[pKey].steps.length - 1;
          renderPipeline(pKey, currentPipelineStep);
        }
      }
    }
  });

  document.getElementById('teCancel').addEventListener('click', closeTaskEdit);
  teModal.addEventListener('click', function(e) { if (e.target === teModal) closeTaskEdit(); });

  // ── Load and render timeline ──
  function loadTaskTimeline(taskId) {
    var wrap = document.getElementById('teTimeline');
    wrap.innerHTML = '<div class="te-timeline-empty">Loading…</div>';
    sb.from('task_updates').select('*').eq('task_id', taskId).order('created_at', { ascending: false }).then(function(r) {
      if (r.error) {
        wrap.innerHTML = '<div class="te-timeline-empty">Could not load updates (' + (r.error.message || 'unknown error') + ')</div>';
        return;
      }
      renderTaskTimeline(r.data || []);
    });
  }

  function renderTaskTimeline(items) {
    var wrap = document.getElementById('teTimeline');
    if (!items.length) {
      wrap.innerHTML = '<div class="te-timeline-empty">No updates posted yet. Post the first one below to keep the client informed.</div>';
      return;
    }
    var html = '';
    items.forEach(function(it) {
      var when = new Date(it.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      var photos = Array.isArray(it.photos) ? it.photos : [];
      var photoHtml = '';
      if (photos.length) {
        photoHtml = '<div class="te-timeline-photos">' + photos.map(function(p) {
          return '<span class="te-timeline-photo-chip" title="' + (p.file_name || '') + '">' +
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
            (p.file_name || 'photo') + '</span>';
        }).join('') + '</div>';
      }
      var statusLine = '';
      if (it.status_to || typeof it.progress_to === 'number') {
        var parts = [];
        if (it.status_to) parts.push('status → ' + it.status_to);
        if (typeof it.progress_to === 'number') parts.push('progress → ' + it.progress_to + '%');
        statusLine = '<div class="te-timeline-statusline">' + parts.join(' · ') + '</div>';
      }
      var ackLine = '';
      if (it.ack_kind === 'acknowledged') {
        var ackWhen = it.acknowledged_at ? new Date(it.acknowledged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        ackLine = '<div class="te-timeline-ack ack">Client acknowledged' + (ackWhen ? ' · ' + ackWhen : '') + '</div>';
      } else if (it.ack_kind === 'concern') {
        var cWhen = it.acknowledged_at ? new Date(it.acknowledged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        ackLine = '<div class="te-timeline-ack concern">Client raised a concern' + (cWhen ? ' · ' + cWhen : '') + '</div>';
      } else {
        ackLine = '<div class="te-timeline-ack pending">Awaiting client review</div>';
      }
      html +=
        '<div class="te-timeline-item">' +
          '<div class="te-timeline-dot"></div>' +
          '<div class="te-timeline-body">' +
            '<div class="te-timeline-meta">' + escapeHtml(it.author_name || it.author_email || 'Admin') + ' · ' + when + '</div>' +
            '<div class="te-timeline-note">' + escapeHtml(it.note || '') + '</div>' +
            statusLine + photoHtml + ackLine +
          '</div>' +
        '</div>';
    });
    wrap.innerHTML = html;
  }

  // ── Photo selection + preview ──
  document.getElementById('teUpdatePhotos').addEventListener('change', function(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    var valid = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].size > TE_MAX_PHOTO_BYTES) {
        showToast('"' + files[i].name + '" exceeds 5 MB and was skipped', 'error');
        continue;
      }
      valid.push(files[i]);
    }
    teSelectedPhotos = valid;
    var hint = document.getElementById('teUpdatePhotosHint');
    hint.textContent = valid.length ? valid.length + ' photo' + (valid.length === 1 ? '' : 's') + ' ready' : 'No photos selected';
    var previews = document.getElementById('teUpdatePhotoPreviews');
    previews.innerHTML = valid.map(function(f) {
      return '<span class="te-photo-chip">' + escapeHtml(f.name) + ' <em>' + (f.size < 1024 * 1024 ? (f.size / 1024).toFixed(0) + ' KB' : (f.size / (1024 * 1024)).toFixed(1) + ' MB') + '</em></span>';
    }).join('');
  });

  function uploadTaskUpdatePhoto(taskId, file) {
    var safeName = (file.name || 'photo').replace(/[^a-zA-Z0-9.\-_]/g, '-');
    var storagePath = 'tasks/' + taskId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safeName;
    return sb.storage.from('documents').upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    }).then(function(r) {
      if (r.error) throw new Error(r.error.message || 'Upload failed');
      return {
        file_name: file.name,
        mime_type: file.type || '',
        size: file.size,
        storage_path: storagePath
      };
    });
  }

  document.getElementById('teSubmit').addEventListener('click', function() {
    if (!currentTaskId) return;
    var saveBtn = this;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    var newStatus = document.getElementById('teStatus').value;
    var newProgress = parseInt(document.getElementById('teProgress').value) || 0;
    var note = document.getElementById('teUpdateNote').value.trim();
    var statusChanged = newStatus !== teInitialStatus;
    var progressChanged = newProgress !== teInitialProgress;
    var hasUpdate = note.length > 0 || teSelectedPhotos.length > 0 || statusChanged || progressChanged;

    var assigneeVal = document.getElementById('teAssignee').value || null;
    var updates = {
      status: newStatus,
      progress: newProgress,
      deadline: document.getElementById('teDeadline').value || null,
      current_step: currentPipelineStep >= 0 ? currentPipelineStep : null,
      assigned_employee_email: assigneeVal
    };

    function finish(msg, level) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Post Update';
      showToast(msg, level || 'success');
      closeTaskEdit();
      loadDashboard();
    }

    function postUpdateRow() {
      if (!hasUpdate) { finish('Task updated'); return; }
      // Upload photos first
      var uploads = teSelectedPhotos.length
        ? Promise.all(teSelectedPhotos.map(function(f) { return uploadTaskUpdatePhoto(currentTaskId, f); }))
        : Promise.resolve([]);
      uploads.then(function(photos) {
        var localSess = JSON.parse(localStorage.getItem('nri_session') || 'null') || {};
        var authorEmail = localSess.email || 'admin@nri-bridge.in';
        var authorName = localSess.name || 'Admin';
        return sb.from('task_updates').insert({
          task_id: currentTaskId,
          author_email: authorEmail,
          author_name: authorName,
          note: note || (statusChanged ? 'Status changed to ' + newStatus : 'Progress updated to ' + newProgress + '%'),
          status_to: statusChanged ? newStatus : null,
          progress_to: progressChanged ? newProgress : null,
          photos: photos
        });
      }).then(function(r) {
        if (r && r.error) { finish('Task saved but update post failed: ' + r.error.message, 'error'); return; }
        finish('Task updated & client notified');
      }).catch(function(err) {
        finish('Photo upload failed: ' + (err.message || 'unknown'), 'error');
      });
    }

    function doUpdate(payload) {
      sb.from('tasks').update(payload).eq('id', currentTaskId).select().then(function(r) {
        if (r.error) {
          var msg = r.error.message || '';
          if (msg.indexOf('assigned_employee_email') !== -1 && 'assigned_employee_email' in payload) {
            delete payload.assigned_employee_email;
            doUpdate(payload);
            return;
          }
          if (msg.indexOf('current_step') !== -1 && 'current_step' in payload) {
            delete payload.current_step;
            doUpdate(payload);
            return;
          }
          saveBtn.disabled = false; saveBtn.textContent = 'Save & Post Update';
          showToast('Failed to update: ' + msg, 'error');
          return;
        }
        postUpdateRow();
      });
    }
    doUpdate(updates);
  });

  document.getElementById('teDelete').addEventListener('click', function() {
    if (!currentTaskId || !confirm('Delete this task?')) return;
    sb.from('tasks').delete().eq('id', currentTaskId).then(function(r) {
      if (r.error) { showToast('Failed to delete', 'error'); return; }
      showToast('Task deleted', 'info');
      closeTaskEdit();
      loadDashboard();
    });
  });

  // ── Client Detail Modal ──
  var cdModal = document.getElementById('clientDetailModal');
  var currentClientId = null;

  function openClientDetail(clientId) {
    var c = clients.find(function(x) { return x.id === clientId; });
    if (!c) return;
    currentClientId = clientId;
    document.getElementById('cdAvatar').textContent = getInitials(c.name);
    document.getElementById('cdName').textContent = c.name || 'Unknown';
    document.getElementById('cdEmail').textContent = c.email || 'No email';
    document.getElementById('cdStatusBadge').innerHTML = '<span class="adm-status-badge ' + statusClass(c.status || 'Pending') + '" style="font-size:0.78rem;">' + (c.status || 'Pending') + '</span>';
    document.getElementById('cdLocation').textContent = [c.city, c.country].filter(Boolean).join(', ') || '—';
    document.getElementById('cdJoined').textContent = c.created_at ? formatDate(c.created_at) : '—';

    var svcHtml = '';
    (c.services || []).forEach(function(s) {
      svcHtml += '<span class="adm-svc-tag">' + s + '</span>';
    });
    document.getElementById('cdServices').innerHTML = svcHtml || '<span style="font-size:0.82rem;color:var(--text-muted);">No services assigned</span>';

    var clientTasks = tasks.filter(function(t) { return t.client_id === clientId; });
    var tasksHtml = '';
    if (clientTasks.length === 0) {
      tasksHtml = '<div style="font-size:0.82rem;color:var(--text-muted);">No tasks assigned</div>';
    } else {
      clientTasks.forEach(function(t) {
        var empName = '';
        if (t.assigned_employee_email) {
          var emp = employees.find(function(e) { return e.email === t.assigned_employee_email; });
          empName = emp ? emp.name : t.assigned_employee_email;
        }
        tasksHtml +=
          '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eae7dc;">' +
            '<span style="flex:1;font-size:0.84rem;">' + t.service + '</span>' +
            (empName ? '<span style="font-size:0.72rem;color:var(--green-pop);font-weight:600;">' + escapeHtml(empName) + '</span>' : '') +
            '<span class="adm-status-badge ' + statusClass(t.status) + '" style="font-size:0.7rem;">' + t.status + '</span>' +
            '<span style="font-size:0.78rem;color:var(--text-muted);">' + (t.progress || 0) + '%</span>' +
          '</div>';
      });
    }
    document.getElementById('cdTasks').innerHTML = tasksHtml;

    cdModal.style.display = 'flex';
    void cdModal.offsetHeight;
    cdModal.classList.add('show');
  }

  function closeClientDetail() {
    cdModal.classList.remove('show');
    setTimeout(function() { cdModal.style.display = 'none'; }, 300);
    currentClientId = null;
  }

  document.getElementById('cdClose').addEventListener('click', closeClientDetail);
  cdModal.addEventListener('click', function(e) { if (e.target === cdModal) closeClientDetail(); });

  document.getElementById('cdDelete').addEventListener('click', function() {
    if (!currentClientId || !confirm('Delete this client and all their tasks?')) return;
    sb.from('tasks').delete().eq('client_id', currentClientId).then(function() {
      sb.from('clients').delete().eq('id', currentClientId).then(function(r) {
        if (r.error) { showToast('Failed to delete', 'error'); return; }
        showToast('Client deleted', 'info');
        closeClientDetail();
        loadDashboard();
      });
    });
  });

  // ── Employees: table + detail modal + approve/reject/suspend ──
  function renderEmployeesTable() {
    var body = document.getElementById('employeesTableBody');
    if (!body) return;
    document.getElementById('empCountLabel').textContent =
      employees.length + (employees.length === 1 ? ' applicant' : ' applicants');

    var rows = employees.filter(function(e) {
      return activeEmpFilter === 'all' ? true : e.status === activeEmpFilter;
    });
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">No employees in this view.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function(e) {
      var statusClass = 'pending';
      if (e.status === 'approved') statusClass = 'active';
      else if (e.status === 'rejected') statusClass = 'inactive';
      else if (e.status === 'suspended') statusClass = 'pending';
      var skillsHtml = (e.skills || []).slice(0, 3).map(function(s) {
        return '<span class="adm-svc-tag">' + escapeHtml(s) + '</span>';
      }).join('');
      if ((e.skills || []).length > 3) skillsHtml += ' <span style="font-size:0.72rem;color:var(--text-muted);">+' + ((e.skills || []).length - 3) + '</span>';
      html +=
        '<tr data-employee-id="' + e.id + '" style="cursor:pointer;">' +
          '<td><div style="display:flex;align-items:center;gap:10px;"><div class="adm-avatar green" style="width:34px;height:34px;font-size:0.74rem;">' + getInitials(e.name) + '</div><div><div style="font-weight:600;">' + escapeHtml(e.name || '—') + '</div><div style="font-size:0.72rem;color:var(--text-muted);">' + escapeHtml(e.email) + '</div></div></div></td>' +
          '<td style="font-size:0.82rem;">' + escapeHtml(e.phone || '—') + '</td>' +
          '<td style="font-size:0.82rem;">' + escapeHtml(e.city || '—') + (e.pin_code ? ' · ' + escapeHtml(e.pin_code) : '') + '</td>' +
          '<td>' + (skillsHtml || '<span style="color:var(--text-muted);">—</span>') + '</td>' +
          '<td><span class="adm-status-badge ' + statusClass + '">' + (e.status || 'pending') + '</span></td>' +
          '<td style="font-size:0.82rem;color:var(--text-mid);">' + (e.created_at ? formatDate(e.created_at) : '—') + '</td>' +
        '</tr>';
    });
    body.innerHTML = html;
    body.querySelectorAll('tr[data-employee-id]').forEach(function(tr) {
      tr.addEventListener('click', function() { openEmployeeDetail(tr.getAttribute('data-employee-id')); });
    });
  }

  document.querySelectorAll('#empFilters [data-emp-filter]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('#empFilters [data-emp-filter]').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeEmpFilter = btn.getAttribute('data-emp-filter');
      renderEmployeesTable();
    });
  });

  var edModal = document.getElementById('employeeDetailModal');
  function openEmployeeDetail(id) {
    var e = employees.find(function(x) { return x.id === id; });
    if (!e) return;
    currentEmployeeId = id;
    document.getElementById('edAvatar').textContent = getInitials(e.name);
    document.getElementById('edName').textContent = e.name || '—';
    document.getElementById('edEmail').textContent = e.email || '—';
    document.getElementById('edPhone').textContent = e.phone || '—';
    document.getElementById('edArea').textContent = [e.city, e.pin_code].filter(Boolean).join(' · ') || '—';
    document.getElementById('edSubmitted').textContent = e.created_at ? formatDate(e.created_at) : '—';

    var badgeClass = 'pending';
    if (e.status === 'approved') badgeClass = 'active';
    else if (e.status === 'rejected' || e.status === 'suspended') badgeClass = 'inactive';
    document.getElementById('edStatusBadge').innerHTML =
      '<span class="adm-status-badge ' + badgeClass + '" style="font-size:0.78rem;">' + (e.status || 'pending') + '</span>';

    document.getElementById('edSkills').innerHTML = (e.skills || []).length
      ? (e.skills || []).map(function(s) { return '<span class="adm-svc-tag">' + escapeHtml(s) + '</span>'; }).join('')
      : '<span style="color:var(--text-muted);font-size:0.82rem;">No skills listed</span>';

    var docsWrap = document.getElementById('edDocs');
    docsWrap.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);">Loading documents…</div>';
    var docTargets = [
      { label: 'Identity document', path: e.id_doc_path },
      { label: 'Address proof', path: e.address_doc_path }
    ].filter(function(d) { return !!d.path; });

    if (!docTargets.length) {
      docsWrap.innerHTML = '<div style="font-size:0.82rem;color:var(--text-muted);">No documents uploaded.</div>';
    } else {
      docsWrap.innerHTML = '';
      docTargets.forEach(function(d) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-cream);border-radius:10px;';
        row.innerHTML = '<div><div style="font-weight:600;font-size:0.84rem;">' + d.label + '</div><div style="font-size:0.72rem;color:var(--text-muted);">' + escapeHtml(d.path.split('/').pop()) + '</div></div><a href="#" class="adm-link" data-open-doc>Open</a>';
        row.querySelector('[data-open-doc]').addEventListener('click', function(ev) {
          ev.preventDefault();
          sb.storage.from('documents').createSignedUrl(d.path, 3600).then(function(r) {
            if (r && r.data && r.data.signedUrl) window.open(r.data.signedUrl, '_blank');
            else showToast('Could not open document', 'error');
          });
        });
        docsWrap.appendChild(row);
      });
    }

    document.getElementById('edRejectReason').value = e.rejection_reason || '';
    document.getElementById('edRejectWrap').style.display = e.status === 'rejected' ? 'block' : 'none';

    edModal.style.display = 'flex';
    void edModal.offsetHeight;
    edModal.classList.add('show');
  }

  function closeEmployeeDetail() {
    edModal.classList.remove('show');
    setTimeout(function() { edModal.style.display = 'none'; }, 300);
    currentEmployeeId = null;
  }

  document.getElementById('edClose').addEventListener('click', closeEmployeeDetail);
  edModal.addEventListener('click', function(ev) { if (ev.target === edModal) closeEmployeeDetail(); });

  function updateEmployeeStatus(patch, successMsg) {
    if (!currentEmployeeId) return;
    var sess = JSON.parse(localStorage.getItem('nri_session') || 'null') || {};
    if (patch.status === 'approved') {
      patch.approved_at = new Date().toISOString();
      patch.approved_by = sess.email || 'admin';
    }
    sb.from('employees').update(patch).eq('id', currentEmployeeId).then(function(r) {
      if (r.error) { showToast('Failed: ' + r.error.message, 'error'); return; }
      showToast(successMsg || 'Employee updated');
      closeEmployeeDetail();
      loadDashboard();
    });
  }

  document.getElementById('edApprove').addEventListener('click', function() {
    updateEmployeeStatus({ status: 'approved', rejection_reason: null }, 'Employee approved');
  });
  document.getElementById('edReject').addEventListener('click', function() {
    var wrap = document.getElementById('edRejectWrap');
    if (wrap.style.display === 'none') {
      wrap.style.display = 'block';
      showToast('Add a reason, then click Reject again', 'info');
      return;
    }
    var reason = document.getElementById('edRejectReason').value.trim();
    if (!reason) { showToast('Please enter a reason first', 'error'); return; }
    updateEmployeeStatus({ status: 'rejected', rejection_reason: reason }, 'Application rejected');
  });
  document.getElementById('edSuspend').addEventListener('click', function() {
    if (!confirm('Suspend this employee? They will not be able to access the portal until reinstated.')) return;
    updateEmployeeStatus({ status: 'suspended' }, 'Employee suspended');
  });

  // ── Add Employee Modal ──
  var aeModal = document.getElementById('addEmployeeModal');

  function openAddEmployee() {
    aeModal.style.display = 'flex';
    void aeModal.offsetHeight;
    aeModal.classList.add('show');
  }
  function closeAddEmployee() {
    aeModal.classList.remove('show');
    setTimeout(function() { aeModal.style.display = 'none'; }, 300);
  }

  document.getElementById('btnAddEmployee').addEventListener('click', openAddEmployee);
  document.getElementById('navAddEmployee').addEventListener('click', openAddEmployee);
  document.getElementById('aeCancel').addEventListener('click', closeAddEmployee);
  aeModal.addEventListener('click', function(e) { if (e.target === aeModal) closeAddEmployee(); });

  // ── Admin access (promote / revoke) ──
  // Calls public.fn_grant_admin / fn_revoke_admin (admin-only RPCs).
  // The target user must already exist in auth.users (signed up at
  // least once). They must sign out + back in for their JWT to refresh.
  function adminAccessAction(rpcName, verb, pastTense) {
    var input = document.getElementById('adminEmailInput');
    var email = (input.value || '').trim().toLowerCase();
    if (!email || email.indexOf('@') === -1) {
      showToast('Enter a valid email first.', 'error');
      input.focus();
      return;
    }
    if (!confirm(verb + ' ' + email + '?')) return;
    sb.rpc(rpcName, { p_email: email }).then(function(res) {
      if (res.error) {
        showToast(verb + ' failed: ' + res.error.message, 'error');
        return;
      }
      showToast(pastTense + ' ' + email + '. They must sign out + back in.', 'success');
      input.value = '';
    });
  }

  document.getElementById('btnGrantAdmin').addEventListener('click', function() {
    adminAccessAction('fn_grant_admin', 'Promote', 'Promoted');
  });
  document.getElementById('btnRevokeAdmin').addEventListener('click', function() {
    adminAccessAction('fn_revoke_admin', 'Revoke admin from', 'Revoked admin from');
  });

  document.getElementById('aeSubmit').addEventListener('click', function() {
    var name = document.getElementById('aeNameInput').value.trim();
    var email = document.getElementById('aeEmailInput').value.trim();
    var phone = document.getElementById('aePhoneInput').value.trim();
    var city = document.getElementById('aeCityInput').value.trim();
    var pin = document.getElementById('aePinInput').value.trim();

    if (!name) { showToast('Name is required', 'error'); return; }
    if (!email) { showToast('Email is required', 'error'); return; }
    if (!phone) { showToast('Phone is required', 'error'); return; }

    var skills = [];
    document.querySelectorAll('#aeSkillsChecks input:checked').forEach(function(cb) {
      skills.push(cb.value);
    });

    var submitBtn = document.getElementById('aeSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';

    var sess = JSON.parse(localStorage.getItem('nri_session') || 'null') || {};
    var idDocFile = document.getElementById('aeIdDoc').files[0];
    var addrDocFile = document.getElementById('aeAddrDoc').files[0];

    var uploads = [];
    var idDocPath = null;
    var addrDocPath = null;

    if (idDocFile) {
      var ts = Date.now();
      idDocPath = 'employees/' + email + '/id-' + ts + '-' + idDocFile.name;
      uploads.push(sb.storage.from('documents').upload(idDocPath, idDocFile));
    }
    if (addrDocFile) {
      var ts2 = Date.now();
      addrDocPath = 'employees/' + email + '/address-' + ts2 + '-' + addrDocFile.name;
      uploads.push(sb.storage.from('documents').upload(addrDocPath, addrDocFile));
    }

    Promise.all(uploads).then(function() {
      var row = {
        name: name,
        email: email,
        phone: phone,
        city: city || null,
        pin_code: pin || null,
        skills: skills,
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: sess.email || 'admin',
        id_doc_path: idDocPath,
        address_doc_path: addrDocPath
      };

      return sb.from('employees').insert([row]).select();
    }).then(function(result) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Employee';

      if (result.error) {
        if (result.error.message && result.error.message.indexOf('duplicate') !== -1) {
          showToast('An employee with this email already exists', 'error');
        } else {
          showToast('Failed: ' + result.error.message, 'error');
        }
        return;
      }

      showToast('Employee added & approved', 'success');
      closeAddEmployee();

      // Reset form
      document.getElementById('aeNameInput').value = '';
      document.getElementById('aeEmailInput').value = '';
      document.getElementById('aePhoneInput').value = '';
      document.getElementById('aeCityInput').value = '';
      document.getElementById('aePinInput').value = '';
      document.getElementById('aeIdDoc').value = '';
      document.getElementById('aeAddrDoc').value = '';
      document.querySelectorAll('#aeSkillsChecks input:checked').forEach(function(cb) { cb.checked = false; });
      loadDashboard();
    }).catch(function(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Employee';
      showToast('Upload failed: ' + (err.message || 'unknown error'), 'error');
    });
  });

  // ── Export CSV ──
  document.getElementById('btnExport').addEventListener('click', function() {
    if (clients.length === 0) { showToast('No data to export', 'info'); return; }
    var csv = 'Name,Email,City,Country,Services,Status,Joined\n';
    clients.forEach(function(c) {
      csv += '"' + (c.name || '') + '","' + (c.email || '') + '","' + (c.city || '') + '","' + (c.country || '') + '","' + (c.services || []).join('; ') + '","' + (c.status || '') + '","' + (c.created_at ? new Date(c.created_at).toLocaleDateString() : '') + '"\n';
    });
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nri-clients-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    showToast('CSV downloaded', 'success');
  });

  // ── Refresh Button ──
  document.getElementById('btnRefresh').addEventListener('click', function() {
    showToast('Refreshing...', 'info');
    loadDashboard();
  });

  // ── Auto-refresh every 30s ──
  setInterval(function() { loadDashboard(); }, 30000);

  // ── Search ──
  document.getElementById('admSearch').addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    if (!q) { renderTaskTable(activeTaskFilter); renderClientsByService(); return; }

    // Filter tasks
    var tbody = document.getElementById('taskTableBody');
    var matchedTasks = tasks.filter(function(t) {
      var client = t.clients || {};
      var assignedEmp = t.assigned_employee_email ? employees.find(function(e) { return e.email === t.assigned_employee_email; }) : null;
      return (client.name || '').toLowerCase().indexOf(q) !== -1 ||
             (t.service || '').toLowerCase().indexOf(q) !== -1 ||
             (t.description || '').toLowerCase().indexOf(q) !== -1 ||
             (t.status || '').toLowerCase().indexOf(q) !== -1 ||
             (t.assigned_employee_email || '').toLowerCase().indexOf(q) !== -1 ||
             (assignedEmp && (assignedEmp.name || '').toLowerCase().indexOf(q) !== -1);
    });
    if (matchedTasks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">No matching tasks</td></tr>';
    } else {
      var html = '';
      matchedTasks.forEach(function(t) {
        var client = t.clients || {};
        var clientName = client.name || t.description || '—';
        var clientLoc = [client.city, client.country].filter(Boolean).join(', ');
        var assigneeHtml = '—';
        if (t.assigned_employee_email) {
          var emp = employees.find(function(e) { return e.email === t.assigned_employee_email; });
          var empName = emp ? emp.name : t.assigned_employee_email;
          assigneeHtml = '<div class="adm-assignee-cell"><span class="adm-assignee-name">' + escapeHtml(empName) + '</span>' +
            (emp && emp.city ? '<span class="adm-client-loc">' + escapeHtml(emp.city) + '</span>' : '') + '</div>';
        }
        html += '<tr class="adm-task-row" data-task-id="' + t.id + '" style="cursor:pointer;">' +
          '<td><div class="adm-client-cell"><span class="adm-client-name">' + clientName + '</span><span class="adm-client-loc">' + clientLoc + '</span></div></td>' +
          '<td>' + (t.service || '—') + '</td>' +
          '<td>' + assigneeHtml + '</td>' +
          '<td><span class="adm-status-badge ' + statusClass(t.status) + '">' + t.status + '</span></td>' +
          '<td><div class="adm-progress-bar"><div class="adm-progress-fill ' + progressColor(t.status) + '" style="width:' + (t.progress || 0) + '%;"></div></div><span class="adm-progress-pct">' + (t.progress || 0) + '%</span></td>' +
          '<td class="adm-deadline">' + formatDate(t.deadline) + '</td></tr>';
      });
      tbody.innerHTML = html;
      document.querySelectorAll('.adm-task-row').forEach(function(row) {
        row.addEventListener('click', function() { openTaskEdit(this.getAttribute('data-task-id')); });
      });
    }

    // Filter clients
    var matchedClients = clients.filter(function(c) {
      return (c.name || '').toLowerCase().indexOf(q) !== -1 ||
             (c.email || '').toLowerCase().indexOf(q) !== -1 ||
             (c.city || '').toLowerCase().indexOf(q) !== -1 ||
             (c.country || '').toLowerCase().indexOf(q) !== -1 ||
             (c.services || []).join(' ').toLowerCase().indexOf(q) !== -1;
    });
    var listHtml = '';
    matchedClients.forEach(function(c, i) {
      var color = AVATAR_COLORS[i % AVATAR_COLORS.length];
      var subtitle = [c.city, c.country].filter(Boolean).join(', ');
      if (c.services && c.services.length) subtitle += (subtitle ? ' · ' : '') + c.services.join(' + ');
      listHtml += '<div class="adm-client-row" data-client-id="' + c.id + '" style="cursor:pointer;">' +
        '<div class="adm-avatar ' + color + '">' + getInitials(c.name) + '</div>' +
        '<div class="adm-client-info"><strong>' + (c.name || 'Unknown') + '</strong><span>' + (subtitle || 'No details') + '</span></div>' +
        '<div class="adm-client-status ' + statusClass(c.status || 'Pending') + '">' + (c.status || 'Pending') + '</div></div>';
    });
    if (matchedClients.length === 0) listHtml = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.88rem;">No matching clients</div>';
    document.getElementById('clientList').innerHTML = listHtml;
    document.querySelectorAll('.adm-client-row[data-client-id]').forEach(function(row) {
      row.addEventListener('click', function() { openClientDetail(this.getAttribute('data-client-id')); });
    });
  });

  // ── Documents Section ──
  var adminDocs = [];
  var activeDocFilter = 'all';

  var DOC_TYPE_ICONS = {
    pdf: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
  };

  function getDocIcon(fileName) {
    if (!fileName) return DOC_TYPE_ICONS.doc;
    var ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'pdf') return DOC_TYPE_ICONS.pdf;
    if (['jpg','jpeg','png','gif','webp','svg'].indexOf(ext) !== -1) return DOC_TYPE_ICONS.image;
    return DOC_TYPE_ICONS.doc;
  }

  function getDocColorClass(fileName) {
    if (!fileName) return 'doc-type-other';
    var ext = fileName.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'doc-type-pdf';
    if (['jpg','jpeg','png','gif','webp','svg'].indexOf(ext) !== -1) return 'doc-type-image';
    return 'doc-type-other';
  }

  // ── Analytics ─────────────────────────────────────────────────
  function renderAnalytics() {
    var now = new Date();
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var rangeLabel = document.getElementById('analyticsRangeLabel');
    if (rangeLabel) rangeLabel.textContent = 'Updated ' + now.toLocaleString('en-IN', { hour:'numeric', minute:'2-digit', hour12:true });

    var inr = function(n) {
      n = Math.round(n || 0);
      return '\u20B9' + n.toLocaleString('en-IN');
    };

    // KPIs
    var revenue = requests
      .filter(function(r) { return r.status === 'Accepted'; })
      .reduce(function(s, r) { return s + (Number(r.quoted_amount) || Number(r.amount) || 0); }, 0);

    var pipeline = requests
      .filter(function(r) { return r.status === 'Quoted'; })
      .reduce(function(s, r) { return s + (Number(r.quoted_amount) || 0); }, 0);

    var acceptedCount = requests.filter(function(r) { return r.status === 'Accepted'; }).length;
    var quotedCount = requests.filter(function(r) { return r.status === 'Quoted'; }).length;
    var completedTasks = tasks.filter(function(t) { return t.status === 'Completed'; }).length;
    var totalTasks = tasks.length;
    var completionPct = totalTasks ? Math.round(completedTasks / totalTasks * 100) : 0;
    var activeClients = clients.filter(function(c) { return c.status === 'Active'; }).length;

    document.getElementById('anaRevenue').textContent = inr(revenue);
    document.getElementById('anaRevenueSub').textContent = acceptedCount + ' accepted quote' + (acceptedCount === 1 ? '' : 's');
    document.getElementById('anaPipeline').textContent = inr(pipeline);
    document.getElementById('anaPipelineSub').textContent = quotedCount + ' awaiting response';
    document.getElementById('anaCompletion').textContent = completionPct + '%';
    document.getElementById('anaCompletionSub').textContent = completedTasks + ' of ' + totalTasks + ' tasks';
    document.getElementById('anaClients').textContent = activeClients;
    document.getElementById('anaClientsSub').textContent = clients.length + ' total clients';

    // Revenue by month (last 6 months, including current)
    var buckets = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ label: months[d.getMonth()], year: d.getFullYear(), month: d.getMonth(), total: 0 });
    }
    requests.forEach(function(r) {
      if (r.status !== 'Accepted' || !r.created_at) return;
      var dt = new Date(r.created_at);
      for (var j = 0; j < buckets.length; j++) {
        if (dt.getFullYear() === buckets[j].year && dt.getMonth() === buckets[j].month) {
          buckets[j].total += Number(r.quoted_amount) || Number(r.amount) || 0;
          break;
        }
      }
    });
    var maxBucket = Math.max.apply(null, buckets.map(function(b) { return b.total; }).concat([1]));
    var revChart = document.getElementById('anaRevenueChart');
    revChart.innerHTML = buckets.map(function(b) {
      var h = maxBucket ? (b.total / maxBucket * 100) : 0;
      var hasData = b.total > 0;
      return '<div class="adm-bar-col">' +
             '<div class="adm-bar-val">' + (hasData ? inr(b.total) : '') + '</div>' +
             '<div class="adm-bar-track"><div class="adm-bar-fill ' + (hasData ? '' : 'empty') + '" style="height:' + h + '%"></div></div>' +
             '<div class="adm-bar-label">' + b.label + '</div>' +
             '</div>';
    }).join('');

    // Task Status donut
    var pending = tasks.filter(function(t) { return t.status === 'Pending'; }).length;
    var inProgress = tasks.filter(function(t) { return t.status === 'In Progress'; }).length;
    var completedDonut = completedTasks;
    var totalDonut = pending + inProgress + completedDonut;
    var donut = document.getElementById('anaTaskDonut');
    var legend = document.getElementById('anaTaskLegend');
    if (totalDonut === 0) {
      donut.innerHTML = '<circle cx="60" cy="60" r="48" fill="none" stroke="#eae7dc" stroke-width="14"/>' +
                       '<text x="60" y="66" text-anchor="middle" fill="#8b8878" font-size="12" font-family="DM Sans">No tasks</text>';
      legend.innerHTML = '';
    } else {
      var segments = [
        { label: 'Completed', value: completedDonut, color: '#5a7a3d' },
        { label: 'In Progress', value: inProgress, color: '#e8a83a' },
        { label: 'Pending', value: pending, color: '#b8b3a3' }
      ];
      var C = 2 * Math.PI * 48;
      var offset = 0;
      var svgParts = ['<circle cx="60" cy="60" r="48" fill="none" stroke="#f0ede4" stroke-width="14"/>'];
      segments.forEach(function(seg) {
        if (seg.value === 0) return;
        var len = (seg.value / totalDonut) * C;
        svgParts.push('<circle cx="60" cy="60" r="48" fill="none" stroke="' + seg.color + '" stroke-width="14" ' +
                     'stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-offset) + '" ' +
                     'transform="rotate(-90 60 60)" stroke-linecap="butt"/>');
        offset += len;
      });
      svgParts.push('<text x="60" y="56" text-anchor="middle" fill="#2b2a24" font-size="22" font-weight="700" font-family="Playfair Display">' + totalDonut + '</text>');
      svgParts.push('<text x="60" y="73" text-anchor="middle" fill="#8b8878" font-size="10" letter-spacing="0.08em" font-family="DM Sans">TASKS</text>');
      donut.innerHTML = svgParts.join('');
      legend.innerHTML = segments.map(function(seg) {
        var pct = totalDonut ? Math.round(seg.value / totalDonut * 100) : 0;
        return '<div class="adm-legend-row">' +
               '<span class="adm-legend-dot" style="background:' + seg.color + '"></span>' +
               '<span class="adm-legend-label">' + seg.label + '</span>' +
               '<span class="adm-legend-val">' + seg.value + ' <em>(' + pct + '%)</em></span>' +
               '</div>';
      }).join('');
    }

    // Clients by Country
    var countryMap = {};
    clients.forEach(function(c) {
      var key = (c.country || 'Unknown').trim() || 'Unknown';
      countryMap[key] = (countryMap[key] || 0) + 1;
    });
    var countryRows = Object.keys(countryMap).map(function(k) { return { label: k, value: countryMap[k] }; })
      .sort(function(a, b) { return b.value - a.value; })
      .slice(0, 6);
    var countryChart = document.getElementById('anaCountryChart');
    if (countryRows.length === 0) {
      countryChart.innerHTML = '<div class="adm-chart-empty">No clients yet</div>';
    } else {
      var maxC = countryRows[0].value;
      countryChart.innerHTML = countryRows.map(function(r) {
        var w = maxC ? (r.value / maxC * 100) : 0;
        return '<div class="adm-hbar-row">' +
               '<div class="adm-hbar-label">' + r.label + '</div>' +
               '<div class="adm-hbar-track"><div class="adm-hbar-fill country" style="width:' + w + '%"></div></div>' +
               '<div class="adm-hbar-val">' + r.value + '</div>' +
               '</div>';
      }).join('');
    }

    // Service Distribution
    var svcMap = {};
    tasks.forEach(function(t) {
      var key = (t.service_type || 'Unspecified');
      svcMap[key] = (svcMap[key] || 0) + 1;
    });
    var svcRows = Object.keys(svcMap).map(function(k) { return { label: k, value: svcMap[k] }; })
      .sort(function(a, b) { return b.value - a.value; })
      .slice(0, 6);
    var svcChart = document.getElementById('anaServiceChart');
    if (svcRows.length === 0) {
      svcChart.innerHTML = '<div class="adm-chart-empty">No tasks yet</div>';
    } else {
      var maxS = svcRows[0].value;
      svcChart.innerHTML = svcRows.map(function(r) {
        var w = maxS ? (r.value / maxS * 100) : 0;
        return '<div class="adm-hbar-row">' +
               '<div class="adm-hbar-label">' + r.label + '</div>' +
               '<div class="adm-hbar-track"><div class="adm-hbar-fill service" style="width:' + w + '%"></div></div>' +
               '<div class="adm-hbar-val">' + r.value + '</div>' +
               '</div>';
      }).join('');
    }

    // Recent Activity (last 14 days) — counts of new clients + new requests + new appointments per day
    var days = [];
    for (var k = 13; k >= 0; k--) {
      var dd = new Date(now);
      dd.setDate(dd.getDate() - k);
      dd.setHours(0, 0, 0, 0);
      days.push({ date: dd, clients: 0, requests: 0, appointments: 0 });
    }
    function bumpDay(dateStr, field) {
      if (!dateStr) return;
      var dt = new Date(dateStr);
      dt.setHours(0, 0, 0, 0);
      for (var m = 0; m < days.length; m++) {
        if (days[m].date.getTime() === dt.getTime()) { days[m][field]++; return; }
      }
    }
    clients.forEach(function(c) { bumpDay(c.created_at, 'clients'); });
    requests.forEach(function(r) { bumpDay(r.created_at, 'requests'); });
    appointments.forEach(function(a) { bumpDay(a.created_at, 'appointments'); });
    var maxDay = Math.max.apply(null, days.map(function(d) { return d.clients + d.requests + d.appointments; }).concat([1]));
    var activityEl = document.getElementById('anaActivityChart');
    activityEl.innerHTML =
      '<div class="adm-activity-bars">' +
      days.map(function(d) {
        var total = d.clients + d.requests + d.appointments;
        var h = maxDay ? (total / maxDay * 100) : 0;
        var day = d.date.getDate();
        var title = d.date.toLocaleDateString('en-IN', { month:'short', day:'numeric' }) +
                    ' — ' + d.clients + ' client, ' + d.requests + ' request, ' + d.appointments + ' appt';
        return '<div class="adm-act-col" title="' + title + '">' +
               '<div class="adm-act-track"><div class="adm-act-fill" style="height:' + Math.max(h, total ? 4 : 0) + '%"></div></div>' +
               '<div class="adm-act-day">' + day + '</div>' +
               '</div>';
      }).join('') +
      '</div>' +
      '<div class="adm-activity-legend">' +
      '<span><span class="adm-legend-dot" style="background:var(--green-pop)"></span>New activity per day</span>' +
      '<span>Total: ' + (clients.length + requests.length + appointments.length) + ' records</span>' +
      '</div>';
  }

  function loadDocuments() {
    sb.from('documents')
      .select('*')
      .order('uploaded_at', { ascending: false })
      .then(function(result) {
        if (result.error) {
          console.error('Documents fetch error:', result.error);
          document.getElementById('docsGrid').innerHTML =
            '<div style="text-align:center;color:var(--text-muted);padding:40px;">Could not load documents</div>';
          return;
        }
        adminDocs = result.data || [];
        document.getElementById('badgeDocs').textContent = adminDocs.length;
        document.getElementById('docCountLabel').textContent = adminDocs.length + ' document' + (adminDocs.length !== 1 ? 's' : '') + ' uploaded';

        // Build filter tabs
        var serviceTypes = {};
        adminDocs.forEach(function(d) {
          var svc = d.service_type || 'Other';
          serviceTypes[svc] = (serviceTypes[svc] || 0) + 1;
        });
        var filtersHtml = '<button class="adm-filter-tab' + (activeDocFilter === 'all' ? ' active' : '') + '" data-doc-filter="all">All (' + adminDocs.length + ')</button>';
        Object.keys(serviceTypes).forEach(function(svc) {
          filtersHtml += '<button class="adm-filter-tab' + (activeDocFilter === svc ? ' active' : '') + '" data-doc-filter="' + svc + '">' + svc + ' (' + serviceTypes[svc] + ')</button>';
        });
        document.querySelector('.adm-docs-filters').innerHTML = filtersHtml;

        // Attach filter handlers
        document.querySelectorAll('[data-doc-filter]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            document.querySelectorAll('[data-doc-filter]').forEach(function(b) { b.classList.remove('active'); });
            this.classList.add('active');
            activeDocFilter = this.getAttribute('data-doc-filter');
            renderDocsGrid();
          });
        });

        renderDocsGrid();
      });
  }

  function renderDocsGrid() {
    var filtered = activeDocFilter === 'all'
      ? adminDocs
      : adminDocs.filter(function(d) { return (d.service_type || 'Other') === activeDocFilter; });

    var grid = document.getElementById('docsGrid');
    if (filtered.length === 0) {
      grid.innerHTML =
        '<div class="adm-docs-empty">' +
          '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="color:#ccc;margin-bottom:12px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<h4>No documents yet</h4>' +
          '<p>Documents uploaded by clients from their dashboard will appear here.</p>' +
        '</div>';
      return;
    }

    var groups = {};
    filtered.forEach(function(doc, idx) {
      var uploadDate = doc.uploaded_at
        ? new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      var clientEmail = doc.client_email || '—';
      var clientObj = clients.find(function(c) { return c.email === doc.client_email; });
      var clientName = clientObj ? clientObj.name : clientEmail;
      var initials = clientName.split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
      var colorClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];
      var fileExt = (doc.file_name || '').split('.').pop().toUpperCase() || '—';

      // Documents are clickable if they have a storage_path OR file_data (base64)
      var hasViewableContent = doc.storage_path || doc.file_data;
      var viewAttr = 'data-doc-id="' + doc.id + '" data-path="' + (doc.storage_path || '') + '" data-doc-name="' + (doc.doc_name || '') + '" data-file-name="' + (doc.file_name || '') + '" data-client="' + clientName + '" data-service="' + (doc.service_type || '') + '" data-date="' + uploadDate + '"';
      var cardClickable = hasViewableContent ? ' adm-dcard-clickable' : '';

      var htmlCard =
        '<div class="adm-dcard' + cardClickable + '" ' + viewAttr + '>' +
          '<div class="adm-dcard-top">' +
            '<div class="adm-dcard-icon ' + getDocColorClass(doc.file_name) + '">' + getDocIcon(doc.file_name) + '</div>' +
            '<span class="adm-dcard-ext">' + fileExt + '</span>' +
          '</div>' +
          '<div class="adm-dcard-name">' + (doc.doc_name || 'Untitled') + '</div>' +
          '<div class="adm-dcard-file">' + (doc.file_name || '') + '</div>' +
          '<div class="adm-dcard-meta">' +
            '<div class="adm-dcard-details">' +
              '<span class="adm-svc-tag" style="font-size:0.68rem;padding:2px 8px;">' + (doc.service_type || '—') + '</span>' +
              '<span class="adm-dcard-date">' + uploadDate + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';

      if (!groups[clientName]) {
        groups[clientName] = { email: clientEmail, initials: initials, color: colorClass, cards: [] };
      }
      groups[clientName].cards.push(htmlCard);
    });

    var html = '';
    Object.keys(groups).forEach(function(cName) {
      var g = groups[cName];
      html += '<div style="margin-bottom: 32px;">';
      html +=   '<div class="adm-dcard-client" style="margin-bottom: 16px; align-items: center;">';
      html +=     '<div class="adm-avatar-sm ' + g.color + '" style="width: 32px; height: 32px; font-size: 0.8rem;">' + g.initials + '</div>';
      html +=     '<strong style="font-size: 1.05rem; color: var(--text-dark);">' + cName + '</strong>';
      html +=     '<span style="opacity: 0.5; font-size: 0.85rem; margin-left: 8px;">(' + g.email + ')</span>';
      html +=   '</div>';
      html +=   '<div class="adm-docs-grid">';
      html +=     g.cards.join('');
      html +=   '</div>';
      html += '</div>';
    });
    grid.innerHTML = html;

    // Attach click handlers for clickable cards
    grid.querySelectorAll('.adm-dcard-clickable').forEach(function(card) {
      card.addEventListener('click', function() {
        var docId = this.getAttribute('data-doc-id');
        var path = this.getAttribute('data-path');
        var docName = this.getAttribute('data-doc-name') || 'Document';
        var fileName = this.getAttribute('data-file-name') || '';
        var client = this.getAttribute('data-client') || '';
        var service = this.getAttribute('data-service') || '';
        var date = this.getAttribute('data-date') || '';

        // Find the doc object to check for file_data
        var docObj = adminDocs.find(function(d) { return d.id === docId; });

        if (path) {
          // Use Supabase Storage signed URL
          openDocPreview(path, docName, fileName, client, service, date, null);
        } else if (docObj && docObj.file_data) {
          // Use base64 data URL directly
          openDocPreview(null, docName, fileName, client, service, date, docObj.file_data);
        }
      });
    });
  }

  function buildDisputeFilters() {
    var counts = { all: disputes.length };
    disputes.forEach(function(item) {
      var key = item.status || 'New';
      counts[key] = (counts[key] || 0) + 1;
    });

    var filtersHtml = '<button class="adm-filter-tab' + (activeDisputeFilter === 'all' ? ' active' : '') + '" data-dispute-filter="all">All (' + counts.all + ')</button>';
    ['New', 'In Review', 'Waiting for Customer', 'Resolved', 'Rejected'].forEach(function(status) {
      filtersHtml += '<button class="adm-filter-tab' + (activeDisputeFilter === status ? ' active' : '') + '" data-dispute-filter="' + status + '">' + status + ' (' + (counts[status] || 0) + ')</button>';
    });
    document.getElementById('disputeFilters').innerHTML = filtersHtml;
    document.querySelectorAll('#disputeFilters [data-dispute-filter]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        activeDisputeFilter = this.getAttribute('data-dispute-filter');
        renderDisputes();
      });
    });
  }

  function openDisputeAttachment(attachment) {
    if (attachment.file_data) {
      window.open(attachment.file_data, '_blank');
      return;
    }
    if (!attachment.storage_path || !sb || !sb.storage) {
      showToast('Attachment preview unavailable', 'error');
      return;
    }
    sb.storage.from('documents').createSignedUrl(attachment.storage_path, 3600).then(function(result) {
      if (result.error || !result.data || !result.data.signedUrl) {
        showToast('Could not open attachment', 'error');
        return;
      }
      window.open(result.data.signedUrl, '_blank');
    });
  }

  function renderDisputes() {
    buildDisputeFilters();
    var list = activeDisputeFilter === 'all'
      ? disputes
      : disputes.filter(function(item) { return item.status === activeDisputeFilter; });

    document.getElementById('disputeCountLabel').textContent = disputes.length + ' dispute' + (disputes.length === 1 ? '' : 's') + ' logged';
    var grid = document.getElementById('disputesGrid');
    if (!list.length) {
      grid.innerHTML = '<div class="adm-docs-empty"><h4>No disputes in this filter</h4><p>New customer disputes will appear here for triage and resolution.</p></div>';
      return;
    }

    var html = '<div class="adm-disputes-list">';
    list.forEach(function(item) {
      var attachments = Array.isArray(item.attachments) ? item.attachments : [];
      html +=
        '<article class="adm-dispute-card" data-dispute-id="' + item.id + '">' +
          '<div class="adm-dispute-row">' +
            '<div>' +
              '<div class="adm-dispute-kicker">' + escapeHtml(item.service_label) + (item.service_item_label ? ' · ' + escapeHtml(item.service_item_label) : '') + '</div>' +
              '<h3>' + escapeHtml(item.title) + '</h3>' +
            '</div>' +
            '<span class="adm-status-badge ' + statusClass(item.status || 'New') + '">' + escapeHtml(item.status || 'New') + '</span>' +
          '</div>' +
          '<div class="adm-dispute-tags">' +
            '<span>' + escapeHtml(item.client_name) + '</span>' +
            '<span>' + escapeHtml(item.category) + '</span>' +
            '<span>' + escapeHtml(item.priority || 'Medium') + ' Priority</span>' +
            '<span>' + new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span>' +
            '<span>' + attachments.length + ' attachment' + (attachments.length === 1 ? '' : 's') + '</span>' +
          '</div>' +
          '<p>' + escapeHtml(item.description) + '</p>' +
          (item.admin_notes ? '<div class="adm-dispute-note">Admin note: ' + escapeHtml(item.admin_notes) + '</div>' : '') +
        '</article>';
    });
    html += '</div>';
    grid.innerHTML = html;

    grid.querySelectorAll('.adm-dispute-card[data-dispute-id]').forEach(function(card) {
      card.addEventListener('click', function() {
        openDisputeDetail(this.getAttribute('data-dispute-id'));
      });
    });
  }

  var disputeModal = document.getElementById('disputeDetailModal');

  function openDisputeDetail(disputeId) {
    var dispute = disputes.find(function(item) { return item.id === disputeId; });
    if (!dispute) return;
    currentDisputeId = disputeId;

    document.getElementById('admDisputeService').textContent = dispute.service_label + (dispute.service_item_label ? ' · ' + dispute.service_item_label : '');
    document.getElementById('admDisputeTitle').textContent = dispute.title;
    document.getElementById('admDisputeDescription').textContent = dispute.description;
    document.getElementById('admDisputeMeta').innerHTML =
      '<span>' + escapeHtml(dispute.client_name) + ' (' + escapeHtml(dispute.client_email) + ')</span>' +
      '<span>' + escapeHtml(dispute.category) + '</span>' +
      '<span>' + escapeHtml(dispute.priority || 'Medium') + ' Priority</span>' +
      '<span>Raised ' + new Date(dispute.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span>';
    document.getElementById('admDisputeStatus').value = dispute.status || 'New';
    document.getElementById('admDisputeNotes').value = dispute.admin_notes || '';
    document.getElementById('admDisputeStatusBadge').className = 'adm-client-status ' + statusClass(dispute.status || 'New');
    document.getElementById('admDisputeStatusBadge').textContent = dispute.status || 'New';

    var filesWrap = document.getElementById('admDisputeFiles');
    var attachments = Array.isArray(dispute.attachments) ? dispute.attachments : [];
    if (!attachments.length) {
      filesWrap.innerHTML = '<div class="adm-dispute-files-empty">No attachments provided</div>';
    } else {
      var filesHtml = '';
      attachments.forEach(function(file, idx) {
        var sizeLabel = '';
        if (file.size) {
          sizeLabel = file.size < 1024 * 1024
            ? ' <em>' + (file.size / 1024).toFixed(0) + ' KB</em>'
            : ' <em>' + (file.size / (1024 * 1024)).toFixed(1) + ' MB</em>';
        }
        var name = file.file_name || ('Attachment ' + (idx + 1));
        filesHtml +=
          '<button class="adm-dispute-file" type="button" data-file-idx="' + idx + '" title="Click to view">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            escapeHtml(name) + sizeLabel +
          '</button>';
      });
      filesWrap.innerHTML = filesHtml;
      var galleryCtx = {
        clientName: dispute.client_name || dispute.client_email || '',
        service: dispute.service_label || '',
        date: dispute.created_at ? new Date(dispute.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
      };
      filesWrap.querySelectorAll('.adm-dispute-file').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var idx = parseInt(this.getAttribute('data-file-idx'), 10);
          openAttachmentGallery(attachments, idx, galleryCtx);
        });
      });
    }

    disputeModal.style.display = 'flex';
    void disputeModal.offsetHeight;
    disputeModal.classList.add('show');
  }

  function closeDisputeDetail() {
    disputeModal.classList.remove('show');
    setTimeout(function() {
      disputeModal.style.display = 'none';
      currentDisputeId = null;
    }, 220);
  }

  document.getElementById('admDisputeCancel').addEventListener('click', closeDisputeDetail);
  disputeModal.addEventListener('click', function(e) {
    if (e.target === disputeModal) closeDisputeDetail();
  });
  document.getElementById('admDisputeSave').addEventListener('click', function() {
    if (!currentDisputeId) return;
    var nextStatus = document.getElementById('admDisputeStatus').value;
    var notes = document.getElementById('admDisputeNotes').value.trim();
    var payload = {
      status: nextStatus,
      admin_notes: notes,
      updated_at: new Date().toISOString()
    };
    payload.resolved_at = nextStatus === 'Resolved' ? new Date().toISOString() : null;

    sb.from('disputes').update(payload).eq('id', currentDisputeId).then(function(result) {
      if (result.error) {
        showToast('Failed to update dispute', 'error');
        return;
      }
      showToast('Dispute updated', 'success');
      closeDisputeDetail();
      loadDashboard();
    });
  });

  // Documents loaded on-demand when nav item is clicked

  // ── Document Preview Modal ──
  var docModal = document.getElementById('docPreviewModal');
  var docFrame = document.getElementById('docPreviewFrame');
  var docLoading = document.getElementById('docPreviewLoading');
  var docError = document.getElementById('docPreviewError');

  function openDocPreview(storagePath, docName, fileName, clientName, service, date, fileDataUrl) {
    // Set header info
    document.getElementById('docPreviewTitle').textContent = docName;
    document.getElementById('docPreviewClient').textContent = clientName;
    document.getElementById('docPreviewService').textContent = service;
    document.getElementById('docPreviewDate').textContent = date;

    // Reset state
    docFrame.style.display = 'none';
    docFrame.src = '';
    docError.style.display = 'none';
    docLoading.style.display = 'flex';
    var oldImg = document.getElementById('docPreviewImage');
    if (oldImg) oldImg.remove();

    // Show modal
    docModal.style.display = 'flex';
    void docModal.offsetHeight;
    docModal.classList.add('show');

    // Helper to render content once we have a URL
    function renderPreview(url, ext) {
      var isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].indexOf(ext) !== -1;
      var isPdf = ext === 'pdf';
      var isDataUrl = url.indexOf('data:') === 0;

      // Detect image from data URL mime type if ext doesn't help
      if (isDataUrl && !isImage && !isPdf) {
        if (url.indexOf('data:image/') === 0) isImage = true;
        else if (url.indexOf('data:application/pdf') === 0) isPdf = true;
      }

      // Set action links
      document.getElementById('docPreviewNewTab').href = url;
      document.getElementById('docPreviewFallbackLink').href = url;

      // For base64 data URLs, create a download link with proper filename
      if (isDataUrl) {
        var dlLink = document.getElementById('docPreviewDownload');
        dlLink.href = url;
        dlLink.setAttribute('download', fileName || docName || 'document');
      } else {
        document.getElementById('docPreviewDownload').href = url;
      }

      if (isImage) {
        docLoading.style.display = 'none';
        docFrame.style.display = 'none';
        var img = document.createElement('img');
        img.id = 'docPreviewImage';
        img.src = url;
        img.className = 'adm-doc-preview-image';
        img.alt = docName;
        img.onload = function() { docLoading.style.display = 'none'; };
        img.onerror = function() {
          docLoading.style.display = 'none';
          docError.style.display = 'flex';
          img.remove();
        };
        document.getElementById('docPreviewBody').appendChild(img);
      } else if (isPdf) {
        docFrame.src = url;
        docFrame.onload = function() {
          docLoading.style.display = 'none';
          docFrame.style.display = 'block';
        };
        docFrame.onerror = function() {
          docLoading.style.display = 'none';
          docError.style.display = 'flex';
        };
        setTimeout(function() {
          if (docLoading.style.display !== 'none') {
            docLoading.style.display = 'none';
            docFrame.style.display = 'block';
          }
        }, 3000);
      } else {
        // Unsupported format — show error with link
        docLoading.style.display = 'none';
        docError.style.display = 'flex';
      }
    }

    // If we have a base64 data URL, use it directly (no Storage needed)
    if (fileDataUrl) {
      var ext = (fileName || '').split('.').pop().toLowerCase();
      renderPreview(fileDataUrl, ext);
      return;
    }

    // Otherwise get signed URL from Supabase Storage
    sb.storage.from('documents').createSignedUrl(storagePath, 3600).then(function(result) {
      if (result.error || !result.data || !result.data.signedUrl) {
        docLoading.style.display = 'none';
        docError.style.display = 'flex';
        return;
      }
      var ext = (fileName || storagePath).split('.').pop().toLowerCase();
      renderPreview(result.data.signedUrl, ext);
    }).catch(function() {
      docLoading.style.display = 'none';
      docError.style.display = 'flex';
    });
  }

  function closeDocPreview() {
    docModal.classList.remove('show');
    setTimeout(function() {
      docModal.style.display = 'none';
      docFrame.src = '';
      docFrame.style.display = 'none';
      var oldImg = document.getElementById('docPreviewImage');
      if (oldImg) oldImg.remove();
      galleryState = null;
      updateGalleryControls();
    }, 300);
  }

  // ── Gallery mode — multi-attachment viewing with prev/next ──
  var galleryState = null;
  var docPrevBtn = document.getElementById('docPreviewPrev');
  var docNextBtn = document.getElementById('docPreviewNext');
  var docCounter = document.getElementById('docPreviewCounter');

  function updateGalleryControls() {
    var multi = galleryState && galleryState.items && galleryState.items.length > 1;
    docPrevBtn.style.display = multi ? 'flex' : 'none';
    docNextBtn.style.display = multi ? 'flex' : 'none';
    docCounter.style.display = multi ? 'inline-flex' : 'none';
    if (multi) {
      docCounter.textContent = (galleryState.index + 1) + ' / ' + galleryState.items.length;
    }
  }

  function renderGalleryItem() {
    if (!galleryState) return;
    var att = galleryState.items[galleryState.index];
    var ctx = galleryState.ctx || {};
    var name = att.file_name || ('Attachment ' + (galleryState.index + 1));
    // Preserve gallery state across openDocPreview call — it resets docFrame
    // but we re-apply controls after.
    openDocPreview(
      att.storage_path || null,
      name,
      att.file_name || 'attachment',
      ctx.clientName || '',
      ctx.service || '',
      ctx.date || '',
      att.file_data || null
    );
    updateGalleryControls();
  }

  function openAttachmentGallery(attachments, startIdx, ctx) {
    if (!attachments || !attachments.length) return;
    galleryState = {
      items: attachments,
      index: Math.max(0, Math.min(startIdx || 0, attachments.length - 1)),
      ctx: ctx || {}
    };
    renderGalleryItem();
  }

  function galleryStep(delta) {
    if (!galleryState || galleryState.items.length <= 1) return;
    var n = galleryState.items.length;
    galleryState.index = (galleryState.index + delta + n) % n;
    renderGalleryItem();
  }

  docPrevBtn.addEventListener('click', function() { galleryStep(-1); });
  docNextBtn.addEventListener('click', function() { galleryStep(1); });

  // Expose for other code paths (dispute modal wiring)
  window.admOpenAttachmentGallery = openAttachmentGallery;

  document.getElementById('docPreviewClose').addEventListener('click', closeDocPreview);
  docModal.addEventListener('click', function(e) { if (e.target === docModal) closeDocPreview(); });
  document.addEventListener('keydown', function(e) {
    if (!docModal.classList.contains('show')) {
      if (e.key === 'Escape' && disputeModal.classList.contains('show')) closeDisputeDetail();
      return;
    }
    if (e.key === 'Escape') { closeDocPreview(); return; }
    if (e.key === 'ArrowLeft') { galleryStep(-1); }
    else if (e.key === 'ArrowRight') { galleryStep(1); }
  });

  // ── Sidebar navigation — scroll to sections ──
  document.querySelectorAll('.adm-nav-item[data-section]').forEach(function(item) {
    item.addEventListener('click', function() {
      document.querySelectorAll('.adm-nav-item').forEach(function(i) { i.classList.remove('active'); });
      this.classList.add('active');
      var section = this.getAttribute('data-section');

      // Elements that form the default dashboard view
      var defaultSections = [
        document.querySelector('.adm-search-wrap'),
        document.querySelector('.adm-stats'),
        document.getElementById('sectionTasks'),
        document.getElementById('sectionClients')
      ];
      var rightPanel = document.querySelector('.adm-right');
      var docSection = document.getElementById('sectionDocuments');
      var anaSection = document.getElementById('sectionAnalytics');
      var disputeSection = document.getElementById('sectionDisputes');
      var empSection = document.getElementById('sectionEmployees');

      var fullWidthSections = ['documents','disputes','analytics','employees','employeesPending','opsboard','scorecards','leaderboard','escalations','proofqueue','recurring'];
      var opsSection = document.getElementById('sectionOpsboard');
      var scoreSection = document.getElementById('sectionScorecards');
      var leaderSection = document.getElementById('sectionLeaderboard');
      var escSection = document.getElementById('sectionEscalations');
      var proofSection = document.getElementById('sectionProofqueue');
      var recurringSection = document.getElementById('sectionRecurring');

      if (fullWidthSections.indexOf(section) !== -1) {
        defaultSections.forEach(function(el) { if (el) el.style.display = 'none'; });
        if (rightPanel) rightPanel.style.display = 'none';
        if (docSection) docSection.style.display = section === 'documents' ? 'block' : 'none';
        if (disputeSection) disputeSection.style.display = section === 'disputes' ? 'block' : 'none';
        if (anaSection) anaSection.style.display = section === 'analytics' ? 'block' : 'none';
        if (empSection) empSection.style.display = (section === 'employees' || section === 'employeesPending') ? 'block' : 'none';
        if (opsSection) opsSection.style.display = section === 'opsboard' ? 'block' : 'none';
        if (scoreSection) scoreSection.style.display = section === 'scorecards' ? 'block' : 'none';
        if (leaderSection) leaderSection.style.display = section === 'leaderboard' ? 'block' : 'none';
        if (escSection) escSection.style.display = section === 'escalations' ? 'block' : 'none';
        if (proofSection) proofSection.style.display = section === 'proofqueue' ? 'block' : 'none';
        if (recurringSection) recurringSection.style.display = section === 'recurring' ? 'block' : 'none';
        if (section === 'documents') loadDocuments();
        if (section === 'disputes') renderDisputes();
        if (section === 'analytics') renderAnalytics();
        if (section === 'opsboard') renderOperationsBoard();
        if (section === 'scorecards') renderScoreCards();
        if (section === 'leaderboard') renderLeaderboard();
        if (section === 'escalations') renderEscalations();
        if (section === 'proofqueue') renderProofQueue();
        if (section === 'recurring') renderRecurringSchedules();
        if (section === 'employees') { activeEmpFilter = 'all'; document.querySelectorAll('#empFilters [data-emp-filter]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-emp-filter') === 'all'); }); renderEmployeesTable(); }
        if (section === 'employeesPending') { activeEmpFilter = 'pending'; document.querySelectorAll('#empFilters [data-emp-filter]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-emp-filter') === 'pending'); }); renderEmployeesTable(); }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        defaultSections.forEach(function(el) { if (el) el.style.display = ''; });
        if (rightPanel) rightPanel.style.display = '';
        if (docSection) docSection.style.display = 'none';
        if (anaSection) anaSection.style.display = 'none';
        if (disputeSection) disputeSection.style.display = 'none';
        if (empSection) empSection.style.display = 'none';
        if (opsSection) opsSection.style.display = 'none';
        if (scoreSection) scoreSection.style.display = 'none';
        if (leaderSection) leaderSection.style.display = 'none';
        if (escSection) escSection.style.display = 'none';
        if (proofSection) proofSection.style.display = 'none';
        if (recurringSection) recurringSection.style.display = 'none';
      }

      switch (section) {
        case 'dashboard':
          window.scrollTo({ top: 0, behavior: 'smooth' });
          renderTaskTable('all');
          break;
        case 'analytics':
          // Already handled above
          break;
        case 'clients':
        case 'byservice':
          var el = document.getElementById('sectionClients');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'tasks':
          renderTaskTable('all');
          var tasksEl = document.getElementById('sectionTasks');
          if (tasksEl) tasksEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'pending':
          renderTaskTable('pending');
          var pendingTasks = document.getElementById('sectionTasks');
          if (pendingTasks) pendingTasks.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'completed':
          renderTaskTable('completed');
          var completedTasks = document.getElementById('sectionTasks');
          if (completedTasks) completedTasks.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'requests':
          var reqEl = document.getElementById('sectionRequests');
          if (reqEl) reqEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'onetime':
          var oneEl = document.getElementById('sectionOnetime');
          if (oneEl) oneEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'documents':
          // Already handled above
          break;
        case 'disputes':
          // Already handled above
          break;
        default:
          var target = document.getElementById('section' + section.charAt(0).toUpperCase() + section.slice(1));
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ══════════════════════════════════════════
  // OPERATIONS BOARD
  // ══════════════════════════════════════════
  function renderOperationsBoard() {
    var board = document.getElementById('opsBoard');
    if (!board) return;

    // For any task that has no real task_steps, synthesize a single virtual step
    // so the board still surfaces it. This must be per-task: once the
    // pipeline-backfill migration has run, only services that match a
    // pipeline_key get real rows, so a global "if taskSteps is empty" gate
    // would silently drop every unmatched task.
    var taskIdsWithSteps = {};
    taskSteps.forEach(function(s) { if (s.task_id) taskIdsWithSteps[s.task_id] = true; });
    var effectiveSteps = taskSteps.slice();
    tasks.forEach(function(t) {
      if (taskIdsWithSteps[t.id]) return;
      if (t.status === 'Completed') return;
      var virtualStatus = 'pending';
      if (t.status === 'In Progress') virtualStatus = 'in_progress';
      else if (t.status === 'In Review') virtualStatus = 'proof_submitted';
      effectiveSteps.push({
        id: t.id + '_v0',
        task_id: t.id,
        step_index: 0,
        step_name: t.description || t.service || 'Task',
        step_description: t.description || '',
        status: virtualStatus,
        assigned_employee_email: t.assigned_employee_email || null,
        created_at: t.created_at || new Date().toISOString(),
        _virtual: true
      });
    });

    var columns = [
      { key: 'unassigned', label: 'Unassigned', filter: function(s) { return !s.assigned_employee_email && s.status === 'pending'; } },
      { key: 'in_progress', label: 'In Progress', filter: function(s) { return s.status === 'in_progress' || (s.status === 'pending' && !!s.assigned_employee_email); } },
      { key: 'proof_submitted', label: 'Proof Submitted', filter: function(s) { return s.status === 'proof_submitted' || s.status === 'resubmitted'; } },
      { key: 'awaiting', label: 'Awaiting Client', filter: function(s) { return s.status === 'client_accepted'; } },
      { key: 'disputed', label: 'Disputed', filter: function(s) { return s.status === 'client_disputed'; } },
      { key: 'escalated', label: 'Escalated', filter: function(s) { return s.status === 'escalated' || s.status === 'admin_resolved'; }, className: 'escalated' }
    ];

    var filterService = document.getElementById('opsFilterService');
    var filterEmployee = document.getElementById('opsFilterEmployee');
    var filterAge = document.getElementById('opsFilterAge');
    var svcVal = filterService ? filterService.value : '';
    var empVal = filterEmployee ? filterEmployee.value : '';
    var ageVal = filterAge ? filterAge.value : '';

    var filtered = effectiveSteps.filter(function(s) {
      if (s.status === 'completed') return false;
      var task = tasks.find(function(t) { return t.id === s.task_id; });
      if (svcVal && task && task.service !== svcVal) return false;
      if (empVal && s.assigned_employee_email !== empVal) return false;
      if (ageVal === 'overdue') {
        var age = (Date.now() - new Date(s.created_at).getTime()) / 3600000;
        if (age < 72) return false;
      }
      return true;
    });

    var html = '';
    columns.forEach(function(col) {
      var items = filtered.filter(col.filter);
      html += '<div class="ops-column ' + (col.className || '') + '">';
      html += '<div class="ops-column-head">' + col.label + ' <span class="ops-column-count">' + items.length + '</span></div>';
      html += '<div class="ops-cards">';
      items.forEach(function(step) {
        html += buildOpsCard(step);
      });
      if (items.length === 0) {
        html += '<div style="font-size:0.78rem;color:var(--text-muted);text-align:center;padding:20px;">None</div>';
      }
      html += '</div></div>';
    });
    board.innerHTML = html;

    board.querySelectorAll('.ops-card').forEach(function(card) {
      card.addEventListener('click', function() {
        var taskId = card.getAttribute('data-task-id');
        if (taskId && typeof openTaskEdit === 'function') openTaskEdit(taskId);
      });
    });
  }

  function buildOpsCard(step) {
    var task = tasks.find(function(t) { return t.id === step.task_id; });
    var client = task && task.clients ? task.clients : {};
    var emp = step.assigned_employee_email
      ? employees.find(function(e) { return e.email === step.assigned_employee_email; })
      : null;

    var ageMs = Date.now() - new Date(step.created_at).getTime();
    var ageHours = ageMs / 3600000;
    var ageLabel, ageClass;
    if (ageHours < 24) { ageLabel = Math.round(ageHours) + 'h'; ageClass = 'green'; }
    else if (ageHours < 72) { ageLabel = Math.round(ageHours / 24) + 'd'; ageClass = 'orange'; }
    else { ageLabel = Math.round(ageHours / 24) + 'd'; ageClass = 'red'; }

    var totalSteps = task ? (task.total_steps || 1) : 1;
    var dotsHtml = '';
    for (var d = 0; d < totalSteps; d++) {
      var dotClass = 'ops-card-dot';
      if (d < step.step_index) dotClass += ' done';
      else if (d === step.step_index) dotClass += ' active';
      dotsHtml += '<span class="' + dotClass + '"></span>';
    }

    var empHtml = '';
    if (emp) {
      empHtml = '<div class="ops-card-employee"><span class="ops-card-avatar">' + getInitials(emp.name) + '</span><span class="ops-card-emp-name">' + escapeHtml(emp.name) + '</span></div>';
    } else if (!step.assigned_employee_email) {
      empHtml = '<div class="ops-card-unassigned">Unassigned</div>';
    }

    return '<div class="ops-card" data-task-id="' + (step.task_id || '') + '" data-step-id="' + step.id + '">' +
      '<div class="ops-card-client">' + escapeHtml(client.name || 'Unknown') + '</div>' +
      '<div class="ops-card-service">' + escapeHtml(task ? task.service : '') + '</div>' +
      '<div class="ops-card-step">Step ' + (step.step_index + 1) + ': ' + escapeHtml(step.step_name) + '</div>' +
      empHtml +
      '<div class="ops-card-footer">' +
        '<span class="ops-card-age ' + ageClass + '">' + ageLabel + '</span>' +
        '<div class="ops-card-dots">' + dotsHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function populateOpsFilters() {
    var svcSelect = document.getElementById('opsFilterService');
    var empSelect = document.getElementById('opsFilterEmployee');
    if (!svcSelect || !empSelect) return;

    var prevSvc = svcSelect.value;
    var prevEmp = empSelect.value;

    var services = {};
    tasks.forEach(function(t) { if (t.service) services[t.service] = true; });
    svcSelect.innerHTML = '<option value="">All Services</option>';
    Object.keys(services).sort().forEach(function(s) {
      svcSelect.innerHTML += '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>';
    });
    if (prevSvc && services[prevSvc]) svcSelect.value = prevSvc;

    var approvedEmps = employees.filter(function(e) { return e.status === 'approved'; });
    empSelect.innerHTML = '<option value="">All Employees</option>';
    approvedEmps.forEach(function(e) {
      empSelect.innerHTML += '<option value="' + escapeHtml(e.email) + '">' + escapeHtml(e.name) + '</option>';
    });
    if (prevEmp && approvedEmps.some(function(e) { return e.email === prevEmp; })) {
      empSelect.value = prevEmp;
    }

    [svcSelect, empSelect, document.getElementById('opsFilterAge')].forEach(function(sel) {
      if (sel && !sel._opsBound) {
        sel._opsBound = true;
        sel.addEventListener('change', function() { renderOperationsBoard(); });
      }
    });
  }

  // ══════════════════════════════════════════
  // SCORECARDS & LEADERBOARD
  // ══════════════════════════════════════════
  function renderScoreCards() {
    var grid = document.getElementById('scoreCardsGrid');
    if (!grid) return;
    var approved = employees.filter(function(e) { return e.status === 'approved'; });
    if (!approved.length) {
      grid.innerHTML = '<div style="color:var(--text-muted);padding:32px;text-align:center;">No approved employees yet.</div>';
      return;
    }
    var html = '';
    approved.forEach(function(emp) {
      var m = employeeMetrics.find(function(x) { return x.employee_email === emp.email; }) || {};
      var score = Math.round(m.performance_score || 50);
      var flagClass = m.flag === 'top_performer' ? 'flagged-top' : (m.flag === 'underperforming' ? 'flagged-under' : '');
      var flagHtml = '';
      if (m.flag === 'top_performer') flagHtml = '<span class="score-flag top">Top Performer</span>';
      else if (m.flag === 'underperforming') flagHtml = '<span class="score-flag under">Needs Attention</span>';

      var strokeColor = score > 70 ? '#4a6a2e' : (score > 40 ? '#e8a83a' : '#dc3545');
      var circumference = 2 * Math.PI * 20;
      var dashOffset = circumference * (1 - score / 100);

      var activeSteps = m.current_active_steps || 0;
      var maxSteps = 10;
      var workloadPct = Math.min(100, activeSteps / maxSteps * 100);
      var workloadClass = workloadPct < 50 ? 'low' : (workloadPct < 80 ? 'mid' : 'high');

      html += '<div class="score-card ' + flagClass + '">' +
        flagHtml +
        '<div class="score-card-header">' +
          '<div class="adm-avatar green" style="width:40px;height:40px;font-size:0.82rem;">' + getInitials(emp.name) + '</div>' +
          '<div class="score-card-info"><h4>' + escapeHtml(emp.name) + '</h4><span>' + escapeHtml(emp.city || '') + ' · ' + (emp.skills || []).join(', ') + '</span></div>' +
          '<div class="score-ring">' +
            '<svg viewBox="0 0 48 48" width="52" height="52"><circle cx="24" cy="24" r="20" fill="none" stroke="#eae7dc" stroke-width="4"/><circle cx="24" cy="24" r="20" fill="none" stroke="' + strokeColor + '" stroke-width="4" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + dashOffset + '" stroke-linecap="round"/></svg>' +
            '<span class="score-ring-value">' + score + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="score-stats">' +
          '<div class="score-stat"><div class="score-stat-label">Steps Done</div><div class="score-stat-value">' + (m.steps_completed || 0) + '</div></div>' +
          '<div class="score-stat"><div class="score-stat-label">Accept Rate</div><div class="score-stat-value">' + Math.round(m.first_accept_rate || 0) + '%</div></div>' +
          '<div class="score-stat"><div class="score-stat-label">Avg Time</div><div class="score-stat-value">' + (m.avg_step_hours ? Math.round(m.avg_step_hours) + 'h' : '—') + '</div></div>' +
          '<div class="score-stat"><div class="score-stat-label">Disputes</div><div class="score-stat-value">' + Math.round(m.dispute_rate || 0) + '%</div></div>' +
        '</div>' +
        '<div class="score-workload">' +
          '<div class="score-workload-label"><span>Workload</span><span>' + activeSteps + '/' + maxSteps + ' steps</span></div>' +
          '<div class="score-workload-bar"><div class="score-workload-fill ' + workloadClass + '" style="width:' + workloadPct + '%;"></div></div>' +
        '</div>' +
      '</div>';
    });
    grid.innerHTML = html;
  }

  function renderLeaderboard() {
    var wrap = document.getElementById('leaderboardList');
    if (!wrap) return;
    var sorted = employeeMetrics.slice().sort(function(a, b) { return (b.performance_score || 0) - (a.performance_score || 0); });
    if (!sorted.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">No data yet.</div>';
      return;
    }
    var html = '';
    sorted.forEach(function(m, i) {
      var emp = employees.find(function(e) { return e.email === m.employee_email; });
      if (!emp) return;
      var rankClass = i === 0 ? 'gold' : (i === 1 ? 'silver' : (i === 2 ? 'bronze' : 'normal'));
      html += '<div class="leaderboard-row">' +
        '<span class="leaderboard-rank ' + rankClass + '">' + (i + 1) + '</span>' +
        '<div class="adm-avatar green" style="width:32px;height:32px;font-size:0.72rem;">' + getInitials(emp.name) + '</div>' +
        '<div class="leaderboard-info"><div class="leaderboard-name">' + escapeHtml(emp.name) + '</div><div class="leaderboard-meta">' + (m.steps_completed || 0) + ' steps · ' + Math.round(m.first_accept_rate || 0) + '% accept</div></div>' +
        '<div class="leaderboard-score">' + Math.round(m.performance_score || 0) + '</div>' +
      '</div>';
    });
    wrap.innerHTML = html;
  }

  // ══════════════════════════════════════════
  // ESCALATION QUEUE
  // ══════════════════════════════════════════
  function renderEscalations() {
    var wrap = document.getElementById('escalationsList');
    if (!wrap) return;
    var escDisp = disputes.filter(function(d) { return d.source === 'step_escalation' && d.status !== 'Resolved'; });
    var countLabel = document.getElementById('escCountLabel');
    if (countLabel) countLabel.textContent = escDisp.length + ' open';

    if (!escDisp.length) {
      wrap.innerHTML = '<div style="color:var(--text-muted);padding:32px;text-align:center;">No escalations pending.</div>';
      return;
    }
    var html = '';
    escDisp.forEach(function(d) {
      var rounds = Array.isArray(d.proof_snapshot) ? d.proof_snapshot : [];
      var roundsHtml = '';
      rounds.forEach(function(r) {
        roundsHtml += '<div class="esc-proof-round">' +
          '<div class="esc-proof-round-head">Round ' + r.round + '</div>' +
          '<div style="font-size:0.82rem;color:var(--text-dark);">' + escapeHtml(r.note || '') + '</div>' +
          (r.client_response === 'disputed' ? '<div style="font-size:0.78rem;color:#dc3545;margin-top:4px;">Client: ' + escapeHtml(r.client_response_note || 'Disputed') + '</div>' : '') +
        '</div>';
      });

      html += '<div class="esc-card" data-dispute-id="' + d.id + '" data-step-id="' + (d.task_step_id || '') + '">' +
        '<div class="esc-card-header">' +
          '<div><div class="esc-card-title">' + escapeHtml(d.title) + '</div>' +
            '<div class="esc-card-meta">' + escapeHtml(d.client_name) + ' · ' + escapeHtml(d.service_label) + '</div></div>' +
          '<div class="esc-card-rounds">' + rounds.length + ' rounds</div>' +
        '</div>' +
        roundsHtml +
        '<div style="margin-top:10px;"><textarea class="esc-admin-note" placeholder="Admin resolution note..." rows="2" style="width:100%;padding:8px;border:1.5px solid #d4d2c8;border-radius:8px;font-family:inherit;font-size:0.82rem;resize:vertical;"></textarea></div>' +
        '<div class="esc-actions">' +
          '<button class="step-proof-btn accept esc-resolve-btn" data-dispute-id="' + d.id + '" data-step-id="' + (d.task_step_id || '') + '">Accept &amp; Complete Step</button>' +
        '</div>' +
      '</div>';
    });
    wrap.innerHTML = html;

    wrap.querySelectorAll('.esc-resolve-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var disputeId = this.getAttribute('data-dispute-id');
        var stepId = this.getAttribute('data-step-id');
        var noteEl = this.closest('.esc-card').querySelector('.esc-admin-note');
        var note = noteEl ? noteEl.value.trim() : '';
        var sess = JSON.parse(localStorage.getItem('nri_session') || 'null') || {};
        if (!note) { showToast('Please add a resolution note', 'error'); return; }

        sb.rpc('fn_resolve_escalation', {
          p_step_id: stepId,
          p_dispute_id: disputeId,
          p_admin_notes: note,
          p_admin_email: sess.email || 'admin'
        }).then(function(r) {
          if (r.error) { showToast('Failed: ' + r.error.message, 'error'); return; }
          showToast('Escalation resolved', 'success');
          loadDashboard();
        });
      });
    });
  }

  // ══════════════════════════════════════════
  // PROOF QUEUE
  // ══════════════════════════════════════════
  function renderProofQueue() {
    var body = document.getElementById('proofQueueBody');
    if (!body) return;
    var pendingSteps = taskSteps.filter(function(s) {
      return s.status === 'proof_submitted' || s.status === 'resubmitted';
    });
    var countLabel = document.getElementById('proofQueueCount');
    if (countLabel) countLabel.textContent = pendingSteps.length + ' awaiting client review';

    if (!pendingSteps.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">No proofs awaiting review.</td></tr>';
      return;
    }
    var html = '';
    pendingSteps.forEach(function(s) {
      var task = tasks.find(function(t) { return t.id === s.task_id; });
      var client = task && task.clients ? task.clients : {};
      var latestProof = stepProofs.filter(function(p) { return p.task_step_id === s.id; }).sort(function(a, b) { return b.round - a.round; })[0];
      var submittedAt = latestProof ? new Date(latestProof.submitted_at).toLocaleString() : '—';
      html += '<tr>' +
        '<td>' + escapeHtml(client.name || 'Unknown') + '</td>' +
        '<td>' + escapeHtml(task ? task.service : '') + '</td>' +
        '<td>Step ' + (s.step_index + 1) + ': ' + escapeHtml(s.step_name) + '</td>' +
        '<td>' + escapeHtml(s.assigned_employee_email || '') + '</td>' +
        '<td>' + submittedAt + '</td>' +
        '<td><span class="adm-badge ' + s.status + '">' + s.status.replace('_', ' ') + '</span></td>' +
      '</tr>';
    });
    body.innerHTML = html;
  }

  // ══════════════════════════════════════════
  // RECURRING SCHEDULES
  // ══════════════════════════════════════════
  function formatRsDate(d) {
    if (!d) return '—';
    var dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    return months[dt.getMonth()] + ' ' + String(dt.getDate()).padStart(2,'0') + ', ' + dt.getFullYear();
  }

  function rsRelative(d) {
    if (!d) return '';
    var dt = new Date(d).getTime();
    if (!dt) return '';
    var diffMs = dt - Date.now();
    var days = Math.round(diffMs / 86400000);
    if (days === 0) return 'today';
    if (days > 0) return 'in ' + days + 'd';
    return Math.abs(days) + 'd ago';
  }

  function rsClient(id) {
    return clients.find(function(c) { return c.id === id; });
  }

  function rsPipeline(key) {
    return servicePipelines.find(function(p) { return p.pipeline_key === key; });
  }

  function recurringFiltered() {
    var nowMs = Date.now();
    return recurringSchedules.filter(function(r) {
      if (activeRecurringFilter === 'all') return true;
      if (activeRecurringFilter === 'active') return r.active;
      if (activeRecurringFilter === 'paused') return !r.active;
      if (!r.next_due_at) return false;
      var dueMs = new Date(r.next_due_at).getTime();
      if (activeRecurringFilter === 'overdue') return r.active && dueMs <= nowMs;
      if (activeRecurringFilter === 'due_soon') return r.active && dueMs > nowMs && (dueMs - nowMs) <= 7 * 86400000;
      return true;
    });
  }

  function renderRecurringSchedules() {
    var body = document.getElementById('recurringTableBody');
    if (!body) return;
    var rows = recurringFiltered();
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:32px;">No schedules match this filter.</td></tr>';
      return;
    }
    var nowMs = Date.now();
    var html = '';
    rows.forEach(function(r) {
      var client = rsClient(r.client_id) || {};
      var pipeline = rsPipeline(r.pipeline_key) || {};
      var dueMs = r.next_due_at ? new Date(r.next_due_at).getTime() : null;
      var statusBadge = '';
      if (!r.active) {
        statusBadge = '<span class="adm-client-status pending">Paused</span>';
      } else if (dueMs && dueMs <= nowMs) {
        statusBadge = '<span class="adm-client-status in-review">Overdue</span>';
      } else if (dueMs && (dueMs - nowMs) <= 7 * 86400000) {
        statusBadge = '<span class="adm-client-status pending">Due soon</span>';
      } else {
        statusBadge = '<span class="adm-client-status active">Active</span>';
      }
      html += '<tr>' +
        '<td><div style="font-weight:600;">' + escapeHtml(client.name || '—') + '</div>' +
          '<div style="font-size:0.72rem;color:var(--text-muted);">' + escapeHtml(client.email || '') + '</div></td>' +
        '<td>' + escapeHtml(r.service || '') + '</td>' +
        '<td><div style="font-size:0.84rem;">' + escapeHtml(pipeline.display_name || r.pipeline_key) + '</div>' +
          '<div style="font-size:0.7rem;color:var(--text-muted);">' + escapeHtml(r.pipeline_key) + '</div></td>' +
        '<td>' + r.interval_days + 'd</td>' +
        '<td>' + formatRsDate(r.last_fired_at) + '</td>' +
        '<td>' + formatRsDate(r.next_due_at) +
          (dueMs ? '<div style="font-size:0.7rem;color:var(--text-muted);">' + escapeHtml(rsRelative(r.next_due_at)) + '</div>' : '') + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="adm-btn-export" data-rs-run="' + r.id + '" style="font-size:0.74rem;padding:4px 10px;margin-right:4px;">Run</button>' +
          '<button class="adm-btn-export" data-rs-edit="' + r.id + '" style="font-size:0.74rem;padding:4px 10px;">Edit</button>' +
        '</td>' +
      '</tr>';
    });
    body.innerHTML = html;

    body.querySelectorAll('[data-rs-edit]').forEach(function(btn) {
      btn.addEventListener('click', function() { openRecurringModal(this.getAttribute('data-rs-edit')); });
    });
    body.querySelectorAll('[data-rs-run]').forEach(function(btn) {
      btn.addEventListener('click', function() { runRecurringNow(this.getAttribute('data-rs-run')); });
    });
  }

  function runRecurringNow(scheduleId) {
    if (!scheduleId) return;
    var sched = recurringSchedules.find(function(r) { return r.id === scheduleId; });
    var label = sched ? (sched.service || 'this schedule') : 'this schedule';
    if (!confirm('Fire ' + label + ' now? A new task will be created if no active task exists for this client + pipeline.')) return;
    sb.rpc('fn_fire_recurring_schedule_manual', {
      p_schedule_id: scheduleId,
      p_trigger_type: 'admin_manual'
    }).then(function(r) {
      if (r.error) { showToast('Failed: ' + r.error.message, 'error'); return; }
      if (r.data) {
        showToast('Task created — schedule advanced.', 'success');
      } else {
        showToast('Skipped — check schedule status (paused, missing pipeline, or active task already exists).', 'info');
      }
      loadDashboard();
    });
  }

  // Filter tabs
  document.querySelectorAll('#recurringFilters [data-recurring-filter]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      activeRecurringFilter = this.getAttribute('data-recurring-filter');
      document.querySelectorAll('#recurringFilters [data-recurring-filter]').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-recurring-filter') === activeRecurringFilter);
      });
      renderRecurringSchedules();
    });
  });

  function openRecurringModal(scheduleId) {
    var modal = document.getElementById('recurringModal');
    if (!modal) return;
    var clientSel = document.getElementById('rsClient');
    var serviceSel = document.getElementById('rsService');

    // Populate client dropdown
    var clientOpts = '<option value="">Select client…</option>';
    clients.slice().sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); }).forEach(function(c) {
      clientOpts += '<option value="' + c.id + '">' + escapeHtml(c.name || c.email || '—') + '</option>';
    });
    clientSel.innerHTML = clientOpts;

    // Populate recurring pipelines dropdown
    var svcOpts = '<option value="">Select pipeline…</option>';
    servicePipelines.filter(function(p) { return p.is_recurring; }).forEach(function(p) {
      svcOpts += '<option value="' + escapeHtml(p.pipeline_key) + '">' + escapeHtml(p.display_name) + '</option>';
    });
    serviceSel.innerHTML = svcOpts;

    var sched = scheduleId ? recurringSchedules.find(function(r) { return r.id === scheduleId; }) : null;
    document.getElementById('rsScheduleId').value = sched ? sched.id : '';
    document.getElementById('rsModalTitle').textContent = sched ? 'Edit Recurring Schedule' : 'Add Recurring Schedule';
    clientSel.value = sched ? sched.client_id : '';
    serviceSel.value = sched ? sched.pipeline_key : '';
    document.getElementById('rsIntervalDays').value = sched ? sched.interval_days : 30;
    document.getElementById('rsActive').value = sched ? (sched.active ? 'true' : 'false') : 'true';

    var nextDueInput = document.getElementById('rsNextDue');
    if (sched && sched.next_due_at) {
      var d = new Date(sched.next_due_at);
      var iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      nextDueInput.value = iso;
    } else {
      nextDueInput.value = '';
    }

    var lastRow = document.getElementById('rsLastFiredRow');
    if (sched && sched.last_fired_at) {
      lastRow.style.display = 'block';
      document.getElementById('rsLastFiredVal').textContent = new Date(sched.last_fired_at).toLocaleString();
    } else {
      lastRow.style.display = 'none';
    }

    document.getElementById('rsRunNow').style.display = sched ? 'inline-block' : 'none';
    document.getElementById('rsDelete').style.display = sched ? 'inline-block' : 'none';
    clientSel.disabled = !!sched;
    serviceSel.disabled = !!sched;

    modal.style.display = 'flex';
    void modal.offsetHeight;
    modal.classList.add('show');
  }

  function closeRecurringModal() {
    var m = document.getElementById('recurringModal');
    if (!m) return;
    m.classList.remove('show');
    setTimeout(function() { m.style.display = 'none'; }, 300);
  }

  var btnAdd = document.getElementById('btnAddRecurring');
  if (btnAdd) btnAdd.addEventListener('click', function() { openRecurringModal(null); });

  var rsCancel = document.getElementById('rsCancel');
  if (rsCancel) rsCancel.addEventListener('click', closeRecurringModal);

  var recurringModalEl = document.getElementById('recurringModal');
  if (recurringModalEl) {
    recurringModalEl.addEventListener('click', function(e) {
      if (e.target === recurringModalEl) closeRecurringModal();
    });
  }

  var rsRunNow = document.getElementById('rsRunNow');
  if (rsRunNow) rsRunNow.addEventListener('click', function() {
    var id = document.getElementById('rsScheduleId').value;
    if (id) { closeRecurringModal(); runRecurringNow(id); }
  });

  var rsDelete = document.getElementById('rsDelete');
  if (rsDelete) rsDelete.addEventListener('click', function() {
    var id = document.getElementById('rsScheduleId').value;
    if (!id) return;
    if (!confirm('Delete this recurring schedule? Future tasks will not auto-fire. Existing tasks remain.')) return;
    sb.from('recurring_schedules').delete().eq('id', id).then(function(r) {
      if (r.error) { showToast('Failed: ' + r.error.message, 'error'); return; }
      showToast('Schedule deleted', 'info');
      closeRecurringModal();
      loadDashboard();
    });
  });

  var rsSave = document.getElementById('rsSave');
  if (rsSave) rsSave.addEventListener('click', function() {
    var id = document.getElementById('rsScheduleId').value;
    var clientId = document.getElementById('rsClient').value;
    var pipelineKey = document.getElementById('rsService').value;
    var intervalDays = parseInt(document.getElementById('rsIntervalDays').value, 10);
    var active = document.getElementById('rsActive').value === 'true';
    var nextDueRaw = document.getElementById('rsNextDue').value;

    if (!clientId) { showToast('Pick a client', 'error'); return; }
    if (!pipelineKey) { showToast('Pick a pipeline', 'error'); return; }
    if (!intervalDays || intervalDays < 1) { showToast('Interval must be at least 1 day', 'error'); return; }

    var pipeline = rsPipeline(pipelineKey);
    var serviceLabel = pipeline ? pipeline.display_name : pipelineKey;
    var nextDueIso = nextDueRaw ? new Date(nextDueRaw).toISOString() : null;

    if (id) {
      var patch = { interval_days: intervalDays, active: active };
      if (nextDueIso) patch.next_due_at = nextDueIso;
      sb.from('recurring_schedules').update(patch).eq('id', id).then(function(r) {
        if (r.error) { showToast('Failed: ' + r.error.message, 'error'); return; }
        showToast('Schedule updated', 'success');
        closeRecurringModal();
        loadDashboard();
      });
    } else {
      var sess = JSON.parse(localStorage.getItem('nri_session') || '{}');
      var row = {
        client_id: clientId,
        service: serviceLabel,
        pipeline_key: pipelineKey,
        interval_days: intervalDays,
        active: active,
        created_by: sess.email || null
      };
      if (nextDueIso) row.next_due_at = nextDueIso;
      sb.from('recurring_schedules').insert(row).then(function(r) {
        if (r.error) {
          var msg = r.error.message || '';
          if (msg.indexOf('duplicate') !== -1 || msg.indexOf('unique') !== -1) {
            showToast('A schedule already exists for this client + service.', 'error');
          } else {
            showToast('Failed: ' + msg, 'error');
          }
          return;
        }
        showToast('Schedule created', 'success');
        closeRecurringModal();
        loadDashboard();
      });
    }
  });

  // Expose for Add Client/Employee triggers from sidebar
  window.admReloadDashboard = loadDashboard;

  // ── Mobile Sidebar Toggle ──
  var hamburger = document.getElementById('admHamburger');
  var sidebar = document.getElementById('admSidebar');
  var sidebarOverlay = document.getElementById('admSidebarOverlay');

  function toggleSidebar() {
    var isOpen = sidebar.classList.toggle('open');
    hamburger.classList.toggle('open', isOpen);
    if (isOpen) {
      sidebarOverlay.classList.add('show');
    } else {
      sidebarOverlay.classList.remove('show');
    }
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    hamburger.classList.remove('open');
    sidebarOverlay.classList.remove('show');
  }

  if (hamburger) {
    hamburger.addEventListener('click', toggleSidebar);
  }
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  // Close sidebar when a nav item is clicked (mobile UX)
  document.querySelectorAll('.adm-nav-item').forEach(function(item) {
    item.addEventListener('click', function() {
      if (window.innerWidth <= 768) {
        closeSidebar();
      }
    });
  });

})();
