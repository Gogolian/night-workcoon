async function fetchRecordings() {
  const res = await fetch('/__api/recordings');
  if (!res.ok) throw new Error('Failed to load recordings');
  return await res.json();
}

function renderTree(container, data) {
  container.innerHTML = '';

  function makeNode(key, value, path=[key]) {
    const el = document.createElement('div');
    el.className = 'node collapsed'; // start collapsed

    const header = document.createElement('div');
    header.className = 'node-header';

    const toggle = document.createElement('span');
    toggle.className = 'toggle';
    toggle.textContent = '▸';
    header.appendChild(toggle);

    const label = document.createElement('span');
    label.className = 'label';
    // Trim long keys in the tree to 30 characters and show full key on hover
    const displayKey = (key && key.length > 30) ? key.slice(0, 30) + '...' : key;
    const keySpan = document.createElement('span');
    keySpan.className = 'short-key';
    keySpan.textContent = displayKey;
    if (displayKey !== key) keySpan.title = key;
    label.appendChild(keySpan);
  header.appendChild(label);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = '';
  header.appendChild(badge);

  // delete button for this node
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.style.marginLeft = '8px';
  delBtn.className = 'node-delete';
  header.appendChild(delBtn);

    el.appendChild(header);

    header.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // expand children preview
      const pretty = JSON.stringify(value, null, 2);
      document.getElementById('detailJson').textContent = pretty;
      const parsedEl = document.getElementById('parsedJson');
      parsedEl.textContent = '';
      // If this is a record object containing a response, attempt to parse it immediately
      try {
        if (value && typeof value === 'object' && value.response && typeof value.response === 'string') {
          const respStr = value.response;
          let parsed = null;
          try {
            parsed = JSON.parse(respStr);
            // If parsed is a string, it was double-encoded; try parse again
            if (typeof parsed === 'string') {
              try {
                parsed = JSON.parse(parsed);
              } catch (e) {
                // leave as string
              }
            }
          } catch (e) {
            // try to unescape possible escaped JSON and parse
            try {
              const unescaped = respStr.replace(/\\"/g, '"');
              parsed = JSON.parse(unescaped);
            } catch (e2) {
              parsed = null;
            }
          }

          if (parsed !== null) {
            parsedEl.textContent = JSON.stringify(parsed, null, 2);
          } else {
            parsedEl.textContent = '(response is not valid JSON)';
          }
        } else {
          parsedEl.textContent = '(no response field to parse)';
        }
      } catch (e) {
        parsedEl.textContent = '(error parsing response)';
      }
      // remove any click handler on detailJson (parsing done automatically)
      document.getElementById('detailJson').onclick = null;

      // store current selection info for saving edits
      try {
        // Path is an array: [method, ...pathParts, queryKey, bodyKey, maybe responseKey]
        if (!Array.isArray(path) || path.length === 0) {
          currentSelection = null;
        } else {
          const method = path[0];
          // If this node itself is a legacy single-record object (has 'response'),
          // then the path ends at the bodyKey. Otherwise, the last element is the response key.
          let queryKey = 'no_query';
          let bodyKey = 'no_body';
          let responseVal = null;
          let pathParts = [];

          if (value && typeof value === 'object' && value.hasOwnProperty('response')) {
            // Need to decide if this is a variant leaf (the last path element is the response key)
            const lastPath = path[path.length - 1];
            const isVariantLeaf = (typeof lastPath === 'string' && lastPath === value.response);
            if (isVariantLeaf) {
              // variant: [method, ...pathParts, queryKey, bodyKey, responseKey]
              if (path.length >= 4) {
                queryKey = path[path.length - 3];
                bodyKey = path[path.length - 2];
                responseVal = path[path.length - 1];
                pathParts = path.slice(1, path.length - 3);
              } else {
                // fallback
                pathParts = path.slice(1, path.length - 1);
                responseVal = path[path.length - 1];
              }
            } else {
              // legacy single-record located at bodyKey: [method, ...pathParts, queryKey, bodyKey]
              if (path.length >= 3) {
                queryKey = path[path.length - 2];
                bodyKey = path[path.length - 1];
                pathParts = path.slice(1, path.length - 2);
              } else if (path.length === 2) {
                queryKey = path[1];
                bodyKey = 'no_body';
                pathParts = [];
              } else {
                pathParts = [];
              }
              responseVal = value.response;
            }
          } else {
            // assume path ends with: ..., queryKey, bodyKey, responseKey
            if (path.length >= 4) {
              queryKey = path[path.length - 3];
              bodyKey = path[path.length - 2];
              responseVal = path[path.length - 1];
              pathParts = path.slice(1, path.length - 3);
            } else if (path.length === 3) {
              // [method, queryKey, bodyKey]
              queryKey = path[1];
              bodyKey = path[2];
              responseVal = (value && value.response) ? value.response : null;
              pathParts = [];
            } else {
              pathParts = [];
            }
          }

          currentSelection = { method, pathParts, queryKey, bodyKey, response: responseVal };
        }
      } catch (e) {
        currentSelection = null;
      }
    });

    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Delete this node and its children?')) return;
      try {
        const res = await fetch('/__api/recording/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path }) });
        if (!res.ok) return alert('Delete failed');
        alert('Deleted');
        refresh();
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    });

      if (value && typeof value === 'object' && !Array.isArray(value)) {
      const children = document.createElement('div');
      children.className = 'children';
      for (const k of Object.keys(value)) {
        const childPath = Array.isArray(path) ? path.concat(k) : [path, k];
        children.appendChild(makeNode(k, value[k], childPath));
      }
      el.appendChild(children);

      // toggle expand/collapse when clicking the toggle caret
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (el.classList.contains('collapsed')) {
          el.classList.remove('collapsed');
          toggle.textContent = '▾';
        } else {
          el.classList.add('collapsed');
          toggle.textContent = '▸';
        }
      });
    } else {
      // leaf nodes: no toggle arrow
      toggle.style.visibility = 'hidden';
    }

  // Populate badge for leaf nodes (arrays or legacy single-record objects)
    try {
      if (Array.isArray(value)) {
        const count = value.length;
        const last = value[count - 1];
        badge.textContent = ` ${count}` + (last && last.recordedAt ? ` • ${new Date(last.recordedAt).toLocaleString()}` : '');
      } else if (value && typeof value === 'object' && value.hasOwnProperty('response')) {
        // legacy single record
        const last = value;
        badge.textContent = ` 1` + (last && last.recordedAt ? ` • ${new Date(last.recordedAt).toLocaleString()}` : '');
      } else {
        badge.textContent = '';
      }
    } catch (e) {
      badge.textContent = '';
    }

    return el;
  }

  for (const k of Object.keys(data)) {
    container.appendChild(makeNode(k, data[k], [k]));
  }
}

// Expand/collapse all helpers
function expandAll() {
  document.querySelectorAll('.node.collapsed').forEach(n => n.classList.remove('collapsed'));
  document.querySelectorAll('.toggle').forEach(t => t.textContent = '▾');
}

function collapseAll() {
  document.querySelectorAll('.node').forEach(n => n.classList.add('collapsed'));
  document.querySelectorAll('.toggle').forEach(t => t.textContent = '▸');
}

const expandBtn = document.getElementById('expandAll');
const collapseBtn = document.getElementById('collapseAll');
if (expandBtn) expandBtn.addEventListener('click', expandAll);
if (collapseBtn) collapseBtn.addEventListener('click', collapseAll);

// Modal functionality removed; badges are non-clickable now.

// attachBadgeHandlers will be called at the end of refresh()

async function refresh() {
  const section = document.getElementById('recordings');
  section.textContent = 'Loading...';
  try {
    const data = await fetchRecordings();
    // Apply status filter if present
    const statusFilterInput = document.getElementById('statusFilter');
    let filtered = data;
    if (statusFilterInput && statusFilterInput.value && statusFilterInput.value.trim()) {
      const allowed = parseStatusFilter(statusFilterInput.value);
      filtered = filterByStatus(data, allowed);
    }
    renderTree(section, filtered);
    // update export link
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.getElementById('export');
    a.href = url;
  // no modal/badge handlers by default
  } catch (e) {
    section.textContent = 'Error loading recordings: ' + e.message;
  }
}

function parseStatusFilter(input) {
  // Accept formats like: "200,201,400-499"
  const parts = input.split(',').map(p => p.trim()).filter(Boolean);
  const set = new Set();
  for (const p of parts) {
    if (p.includes('-')) {
      const [a,b] = p.split('-').map(x => parseInt(x,10)).filter(n => !isNaN(n));
      if (!isNaN(a) && !isNaN(b) && a <= b) {
        for (let i=a;i<=b;i++) set.add(i);
      }
    } else {
      const n = parseInt(p,10);
      if (!isNaN(n)) set.add(n);
    }
  }
  return set;
}

function filterByStatus(data, allowedSet) {
  // Recursively prune the recordedData tree, keeping branches that contain at least one record with status in allowedSet
  function prune(node) {
    if (!node || typeof node !== 'object') return null;
    // If this node looks like a single record
    if (node.hasOwnProperty('response') && node.hasOwnProperty('statusCode')) {
      return allowedSet.has(node.statusCode) ? node : null;
    }
    const out = Array.isArray(node) ? [] : {};
    let kept = false;
    for (const k of Object.keys(node)) {
      const child = node[k];
      const pruned = prune(child);
      if (pruned !== null) {
        out[k] = pruned;
        kept = true;
      }
    }
    return kept ? out : null;
  }
  const pr = prune(data);
  return pr || {};
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('applyStatusFilter').addEventListener('click', refresh);
document.getElementById('clearStatusFilter').addEventListener('click', () => { document.getElementById('statusFilter').value = ''; refresh(); });
const startStopBtn = document.getElementById('startStop');

async function fetchStatus() {
  try {
    const res = await fetch('/__api/status');
    if (!res.ok) return null;
    const j = await res.json();
    return j.acceptingTraffic;
  } catch (e) {
    return null;
  }
}

async function updateStartStopButton() {
  const status = await fetchStatus();
  if (status === null) {
    startStopBtn.textContent = 'Unknown';
    startStopBtn.disabled = true;
    return;
  }
  startStopBtn.disabled = false;
  startStopBtn.textContent = status ? 'Stop' : 'Start';
}

startStopBtn.addEventListener('click', async () => {
  const status = await fetchStatus();
  if (status === null) return alert('Cannot contact server status');
  const endpoint = status ? '/__api/stop' : '/__api/start';
  const res = await fetch(endpoint, { method: 'POST' });
  if (!res.ok) return alert('Failed to change state');
  await updateStartStopButton();
});
document.getElementById('save').addEventListener('click', async () => {
  const res = await fetch('/__api/save', { method: 'POST' });
  if (res.ok) alert('Saved'); else alert('Save failed');
});
document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear all recordings?')) return;
  const res = await fetch('/__api/clear', { method: 'POST' });
  if (res.ok) { alert('Cleared'); refresh(); } else alert('Clear failed');
});

// Initial load
refresh();
updateStartStopButton();

// Poll status every 5 seconds
setInterval(updateStartStopButton, 5000);

// Config: mapping and single mode toggle (Offline <-> Record-only)
async function fetchConfig() {
  const res = await fetch('/__api/config');
  if (!res.ok) throw new Error('Failed to load config');
  return await res.json();
}

async function updateConfig(payload) {
  const res = await fetch('/__api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to update config');
  return await res.json();
}

async function refreshConfigUI() {
  try {
    const cfg = await fetchConfig();
    const port = cfg.port || window.location.port || '8079';
    document.getElementById('mappingText').textContent = `https://localhost:${port} ==> ${cfg.targetUrl}`;
    const modeToggle = document.getElementById('modeToggle');
    const modeLabel = document.getElementById('modeLabel');
    // modeToggle.checked -> Offline, unchecked -> Record-only
    modeToggle.checked = !!cfg.offlineMode;
    if (cfg.offlineMode) modeLabel.textContent = 'Offline';
    else modeLabel.textContent = 'Record-only';
    const skip5xx = document.getElementById('skip5xx');
    if (skip5xx) skip5xx.checked = !!cfg.skip5xx;
  } catch (e) {
    document.getElementById('mappingText').textContent = 'Could not load config';
  }
}

// Single mode toggle handler: checked -> Offline, unchecked -> Record-only
document.getElementById('modeToggle').addEventListener('change', async (ev) => {
  try {
    const isOffline = !!ev.target.checked;
    const payload = { offlineMode: isOffline, recordOnlyMode: !isOffline };
    await updateConfig(payload);
    await refreshConfigUI();
  } catch (e) { alert('Failed to update mode'); }
});

const skip5xxEl = document.getElementById('skip5xx');
if (skip5xxEl) skip5xxEl.addEventListener('change', async (ev) => {
  try {
    await updateConfig({ skip5xx: !!ev.target.checked });
    await refreshConfigUI();
  } catch (e) { alert('Failed to update config'); }
});

// Initial config load
refreshConfigUI();

// Selection tracking variable (method/pathParts/queryKey/bodyKey/response)
let currentSelection = null;

// parsed save/cancel handlers
const parsedSaveBtn = document.getElementById('parsedSave');
const parsedCancelBtn = document.getElementById('parsedCancel');
if (parsedCancelBtn) parsedCancelBtn.addEventListener('click', () => {
  // reload recordings to reset parsed text to source
  refresh();
});

if (parsedSaveBtn) parsedSaveBtn.addEventListener('click', async () => {
  if (!currentSelection || !currentSelection.response) return alert('No selection to save');
  const newText = document.getElementById('parsedJson').value;
  // try to validate JSON
  try {
    const parsed = JSON.parse(newText);
    // send update to server; server will persist
    const payload = { ...currentSelection, newResponse: JSON.stringify(parsed) };
    const res = await fetch('/__api/recording/update', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) return alert('Failed to save');
    alert('Saved');
    refresh();
  } catch (e) {
    return alert('Edited response is not valid JSON');
  }
});
