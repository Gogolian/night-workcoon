async function fetchRecordings() {
  const res = await fetch('/__api/recordings');
  if (!res.ok) throw new Error('Failed to load recordings');
  return await res.json();
}

function renderTree(container, data) {
  container.innerHTML = '';

  function makeNode(key, value, path=key) {
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
    });

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const children = document.createElement('div');
      children.className = 'children';
      for (const k of Object.keys(value)) {
        children.appendChild(makeNode(k, value[k], path + '/' + k));
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
    container.appendChild(makeNode(k, data[k], k));
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
    renderTree(section, data);
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

document.getElementById('refresh').addEventListener('click', refresh);
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

// Initial config load
refreshConfigUI();
