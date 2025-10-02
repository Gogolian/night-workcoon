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
  // store a safe data-path (each part encoded) so other UI pieces can locate this node
  try { el.dataset.path = (Array.isArray(path) ? path : [path]).map(p => encodeURIComponent(String(p))).join('|'); } catch (e) { el.dataset.path = ''; }

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

      // Inline detail-block variants have been removed — variants are managed via the accordions above.
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

// Find and select a tree node by the encoded data-path (parts joined by '|')
function selectTreeNodeByEncodedPath(encodedPath) {
  if (!encodedPath) return;
  const nodes = document.querySelectorAll('.node');
  let found = null;
  for (const n of nodes) {
    if (n.dataset && n.dataset.path === encodedPath) { found = n; break; }
  }
  if (!found) return;
  // expand parents
  let el = found.parentElement;
  while (el && el.classList) {
    if (el.classList.contains('children')) {
      const parentNode = el.previousSibling; // header sits before children
      if (parentNode && parentNode.classList && parentNode.closest) {
        // remove collapsed class on the parent node wrapper
        const wrapper = el.closest('.node');
        if (wrapper && wrapper.classList.contains('collapsed')) {
          wrapper.classList.remove('collapsed');
          const t = wrapper.querySelector('.toggle'); if (t) t.textContent = '▾';
        }
      }
    }
    el = el.parentElement;
  }
  // scroll into view and trigger header click to populate details
  found.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const hdr = found.querySelector('.node-header');
  if (hdr) hdr.click();
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
    // render accordions for all groups that have variants
    renderVariantAccordions(data);
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

// Discover variant groups: locate nodes whose values are maps of variant records
function buildVariantGroups(data) {
  const groups = [];
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (!child || typeof child !== 'object') continue;
      // detect variant map: child has keys whose values are records (objects with 'response')
      const keys = Object.keys(child);
      if (keys.length > 0 && keys.every(kk => child[kk] && typeof child[kk] === 'object' && child[kk].hasOwnProperty('response'))) {
        // create variant objects and sort by recordedAt desc
        const variants = keys.map(kk => ({ key: kk, rec: child[kk] })).sort((a,b) => {
                const ta = new Date(a.rec.createdAt || a.rec.modifiedAt || a.rec.recordedAt).getTime();
                const tb = new Date(b.rec.createdAt || b.rec.modifiedAt || b.rec.recordedAt).getTime();
                // oldest-first: ascending by createdAt, fallback to modifiedAt/recordedAt
                return (isNaN(ta)?0:ta) - (isNaN(tb)?0:tb);
        });
        groups.push({ path: path.concat([k]), variants });
      } else {
        // recurse deeper
        walk(child, path.concat([k]));
      }
    }
  }
  for (const method of Object.keys(data || {})) {
    walk(data[method], [method]);
  }
  return groups;
}

function renderVariantAccordions(data) {
  const container = document.getElementById('variantAccordions');
  if (!container) return;
  container.innerHTML = '';
  // ensure tooltip exists
  let tooltip = document.getElementById('variantTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div'); tooltip.id = 'variantTooltip'; document.body.appendChild(tooltip);
  }
  const groups = buildVariantGroups(data).filter(g => Array.isArray(g.variants) && g.variants.length > 1);
  for (const g of groups) {
  const partsForTitle = g.path.slice(1).filter(Boolean);
  const titlePath = partsForTitle.length > 1 ? partsForTitle.slice(0, -1).join('/') : partsForTitle.join('/');
    const method = g.path[0];
    const title = `${method} /${titlePath}`;
    const acc = document.createElement('div');
    acc.className = 'accordion';
    const hdr = document.createElement('div'); hdr.className = 'title';
    hdr.textContent = `${title} — ${g.variants.length} variant(s)`;
    const caret = document.createElement('span'); caret.textContent = '▸';
    hdr.appendChild(caret);
    acc.appendChild(hdr);

    const body = document.createElement('div'); body.style.display = 'none'; body.style.marginTop = '8px';

    // sort variants by createdAt ascending (oldest-first), fallback to modifiedAt/recordedAt
    const rows = g.variants.slice().sort((a,b) => {
      const ta = new Date(a.rec.createdAt || a.rec.modifiedAt || a.rec.recordedAt).getTime();
      const tb = new Date(b.rec.createdAt || b.rec.modifiedAt || b.rec.recordedAt).getTime();
      return (isNaN(ta)?0:ta) - (isNaN(tb)?0:tb);
    });

    // Determine current selected (newest) -- now the newest is the last element
  const primary = rows.length ? rows[rows.length - 1].key : null;

    const list = document.createElement('div');
    list.style.display = 'flex'; list.style.flexDirection = 'column';
    const maxShow = 50;
    for (let i = 0; i < Math.min(rows.length, maxShow); i++) {
      const v = rows[i];
  const row = document.createElement('div'); row.className = 'variant-row';
      const left = document.createElement('div'); left.style.display = 'flex'; left.style.alignItems='center';
      const cbWrap = document.createElement('div'); cbWrap.style.width='24px'; cbWrap.style.display='flex'; cbWrap.style.alignItems='center';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'variant-checkbox';
      cb.checked = (v.key === primary);
      cb.dataset.responseKey = v.key;
      cbWrap.appendChild(cb);
      left.appendChild(cbWrap);

      const info = document.createElement('div'); info.style.flex='1';
  const preview = document.createElement('div'); preview.textContent = v.key && v.key.length > 120 ? v.key.slice(0,120)+'…' : v.key;
      preview.style.fontFamily='monospace'; preview.style.whiteSpace='pre-wrap'; preview.style.maxHeight='3.6em'; preview.style.overflow='hidden';
      info.appendChild(preview);
  const meta = document.createElement('div'); meta.style.fontSize='12px'; meta.style.color='#444';
  const ts = v.rec.createdAt || v.rec.modifiedAt || v.rec.recordedAt;
  meta.textContent = `${v.rec.statusCode||'?'} • ${ts?new Date(ts).toLocaleString():''} • ${v.key.length} chars`;
      info.appendChild(meta);
      row.appendChild(left);
      row.appendChild(info);

      cb.addEventListener('change', async (ev) => {
        // ensure only one checked at a time in UI
        const allCbs = list.querySelectorAll('.variant-checkbox');
        allCbs.forEach(x => { if (x !== cb) x.checked = false; });
        // show loaders for all
        allCbs.forEach(x => {
          const p = x.parentElement;
          p.innerHTML = '';
          const loader = document.createElement('div'); loader.className = 'variant-loader';
          p.appendChild(loader);
        });
        // call select-by-path
        const fullPath = Array.isArray(g.path) ? g.path.concat(v.key) : [g.path, v.key];
        try {
          const res = await fetch('/__api/recording/select-by-path', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: fullPath }) });
          if (!res.ok) {
            const txt = await res.text().catch(()=>'(no body)');
            alert('Select failed: ' + txt);
            // restore checkboxes
            allCbs.forEach(x => { const p = x.parentElement; p.innerHTML=''; p.appendChild(x); });
            return;
          }
          // success — refresh to reflect new primary
          await refresh();
        } catch (e) {
          alert('Select failed: ' + e.message);
          allCbs.forEach(x => { const p = x.parentElement; p.innerHTML=''; p.appendChild(x); });
        }
      });

      // hover to show full response tooltip
      row.addEventListener('mouseenter', (e) => {
        tooltip.style.display = 'block';
        tooltip.textContent = v.key;
      });
      row.addEventListener('mousemove', (e) => {
        const x = e.clientX + 12; const y = e.clientY + 12;
        tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
      });
      row.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });

      // when clicking a variant row in the accordion, select and expand the corresponding node in the tree
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // compute the full path array and encode same way nodes did
        const fullPathArray = Array.isArray(g.path) ? g.path.concat(v.key) : [g.path, v.key];
        const encoded = fullPathArray.map(p => encodeURIComponent(String(p))).join('|');
        selectTreeNodeByEncodedPath(encoded);
      });

      list.appendChild(row);
    }

    if (rows.length > maxShow) {
      const more = document.createElement('button'); more.textContent = `Show ${rows.length - maxShow} more`;
      more.addEventListener('click', () => {
        // simple approach: expand full view by re-rendering body with all rows
        body.innerHTML = '';
        for (const v of rows) {
          const r = document.createElement('div'); r.className = 'variant-row';
          const cbw = document.createElement('div'); cbw.style.width='24px'; const c = document.createElement('input'); c.type='checkbox'; c.className='variant-checkbox'; c.checked = (v.key === primary); cbw.appendChild(c);
          r.appendChild(cbw);
          const p = document.createElement('div'); p.style.flex='1'; const pv = document.createElement('div'); pv.textContent = v.key && v.key.length > 120 ? v.key.slice(0,120)+'…' : v.key; p.appendChild(pv);
          r.appendChild(p);
          body.appendChild(r);
        }
      });
      list.appendChild(more);
    }

    body.appendChild(list);
    acc.appendChild(body);

    hdr.addEventListener('click', () => {
      if (body.style.display === 'none') { body.style.display = 'block'; caret.textContent='▾'; } else { body.style.display='none'; caret.textContent='▸'; }
    });

    container.appendChild(acc);
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

// Import contract file handler
const importBtn = document.getElementById('importContract');
// reusable modal helper
function openModal({ title, bodyNode, actions = [] }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot') || document.body;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const modal = document.createElement('div'); modal.className = 'modal';
    if (title) {
      const h = document.createElement('h3'); h.textContent = title; modal.appendChild(h);
    }
    if (bodyNode) modal.appendChild(bodyNode);
    const act = document.createElement('div'); act.className = 'modal-actions';
    for (const a of actions) {
      const b = document.createElement('button'); b.textContent = a.label;
      b.addEventListener('click', async (ev) => {
        try {
          const res = await a.onClick(ev);
          if (a.resolve !== false) {
            document.body.removeChild(overlay);
            resolve(res);
          }
        } catch (e) {
          alert(e && e.message ? e.message : String(e));
        }
      });
      act.appendChild(b);
    }
    modal.appendChild(act);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}

if (importBtn) importBtn.addEventListener('click', async () => {
  // build modal body
  const wrapper = document.createElement('div');
  const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'application/json';
  const hint = document.createElement('div'); hint.style.marginTop = '8px'; hint.style.color = '#555'; hint.textContent = 'Select a contract JSON file (single object or array)';
  wrapper.appendChild(fileInput); wrapper.appendChild(hint);

  const result = await openModal({ title: 'Import Contract', bodyNode: wrapper, actions: [
    { label: 'Import', onClick: async () => {
      if (!fileInput.files || !fileInput.files[0]) throw new Error('Select a file');
      const txt = await fileInput.files[0].text();
      let obj; try { obj = JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON'); }
      const arr = Array.isArray(obj) ? obj : [obj];
      const res = await fetch('/__api/import-contract', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ items: arr }) });
      if (!res.ok) { const t = await res.text().catch(()=>'(no body)'); throw new Error('Import failed: ' + t); }
      await refresh();
      return true;
    }, resolve: true },
    { label: 'Cancel', onClick: () => { /* just close */ }, resolve: true }
  ] });
});

// Add Record button: opens modal for manual record creation
const addBtn = document.getElementById('addRecord');
if (addBtn) addBtn.addEventListener('click', async () => {
  const form = document.createElement('div');
  const methodLabel = document.createElement('label'); methodLabel.textContent = 'Method: '; const methodSel = document.createElement('select'); ['GET','POST','PUT','PATCH','DELETE'].forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; methodSel.appendChild(o); });
  const urlLabel = document.createElement('label'); urlLabel.textContent = 'URL (path + query): '; const urlInput = document.createElement('input'); urlInput.type='text'; urlInput.style.width='100%'; urlInput.placeholder = '/path?query=1';
  const reqLabel = document.createElement('label'); reqLabel.textContent = 'Request body (JSON, optional):'; const reqArea = document.createElement('textarea'); reqArea.style.width='100%'; reqArea.rows=4;
  const respLabel = document.createElement('label'); respLabel.textContent = 'Response body (JSON or text):'; const respArea = document.createElement('textarea'); respArea.style.width='100%'; respArea.rows=8;
  const statusLabel = document.createElement('label'); statusLabel.textContent = 'HTTP Status:'; const statusInput = document.createElement('input'); statusInput.type='number'; statusInput.value = 200; statusInput.style.width='100px';
  const row = document.createElement('div'); row.style.display='flex'; row.style.flexDirection='column'; row.style.gap='6px';
  row.appendChild(methodLabel); row.appendChild(methodSel); row.appendChild(urlLabel); row.appendChild(urlInput);
  row.appendChild(statusLabel); row.appendChild(statusInput);
  row.appendChild(reqLabel); row.appendChild(reqArea); row.appendChild(respLabel); row.appendChild(respArea);

  await openModal({ title: 'Add Record', bodyNode: row, actions: [
    { label: 'Add', onClick: async () => {
      // collect values and POST
      const method = methodSel.value || 'GET';
      const url = urlInput.value || '/';
      const status = parseInt(statusInput.value,10) || 200;
      let reqBody = null;
      const rb = reqArea.value && reqArea.value.trim();
      if (rb) {
        try { reqBody = JSON.parse(rb); } catch (e) { throw new Error('Request body is not valid JSON'); }
      }
      let respBody = respArea.value || '';
      // try to keep JSON if possible
      try { const parsed = JSON.parse(respBody); respBody = parsed; } catch (e) { /* leave as string */ }
      const payload = { method, url, request: reqBody || {}, httpStatus: status, response: respBody };
      const res = await fetch('/__api/add-record', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) { const t = await res.text().catch(()=>'(no body)'); throw new Error('Add failed: ' + t); }
      await refresh();
      return true;
    }, resolve: true },
    { label: 'Cancel', onClick: () => {}, resolve: true }
  ] });
});

// Add HTTP Archive (HAR) import: paste a single HAR entry (or an object from HAR log) and allow editing before import
const addHarBtn = document.getElementById('addHar');
if (addHarBtn) addHarBtn.addEventListener('click', async () => {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex'; wrapper.style.flexDirection = 'column'; wrapper.style.gap = '8px';
  const hint = document.createElement('div'); hint.textContent = 'Paste a single HAR entry (object) or an array/object from a HAR log. The importer will map it to internal records.';
  const area = document.createElement('textarea'); area.rows = 18; area.style.width = '700px'; area.style.fontFamily = 'monospace';
  const previewLabel = document.createElement('div'); previewLabel.textContent = 'Mapped import items (editable JSON array):';
  const preview = document.createElement('textarea'); preview.rows = 10; preview.style.width = '700px'; preview.style.fontFamily = 'monospace';

  wrapper.appendChild(hint); wrapper.appendChild(area); wrapper.appendChild(previewLabel); wrapper.appendChild(preview);

  await openModal({ title: 'Add HTTP Archive', bodyNode: wrapper, actions: [
    { label: 'Parse', onClick: async () => {
      const txt = area.value && area.value.trim();
      if (!txt) throw new Error('Paste some HAR JSON first');
      let obj;
      try { obj = JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON'); }

      // normalize to array of entries
      let entries = [];
      // If it's a full HAR log
      if (obj.log && Array.isArray(obj.log.entries)) entries = obj.log.entries;
      else if (Array.isArray(obj)) entries = obj;
      else if (obj.entries && Array.isArray(obj.entries)) entries = obj.entries;
      else if (obj && typeof obj === 'object' && obj.request && obj.response) entries = [obj];
      else throw new Error('Unrecognized HAR shape; expected entry object or HAR log');

      // Map entries to import items compatible with /__api/import-contract
      const items = entries.map(en => {
        try {
          const req = en.request || {};
          const res = en.response || {};
          const method = (req.method || 'GET').toUpperCase();
          const url = req.url || (req.path ? req.path : '/');
          // build request body object if present
          let requestBody = {};
          if (req.postData && req.postData.text) {
            try { requestBody = JSON.parse(req.postData.text); } catch (e) { requestBody = { raw: req.postData.text }; }
          }
          // build response body
          let responseBody = '';
          if (res.content) {
            if (typeof res.content.text === 'string') {
              // HAR may include encoding info; assume textual
              responseBody = res.content.text;
            } else if (res.content && res.content.size === 0) {
              responseBody = '';
            }
          }
          const status = typeof res.status === 'number' ? res.status : 200;
          return { httpMethod: method, uri: url, request: requestBody, httpStatus: status, response: responseBody };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);

      preview.value = JSON.stringify(items, null, 2);
      return true;
    }, resolve: false },
    { label: 'Import', onClick: async () => {
      const txt = preview.value && preview.value.trim();
      if (!txt) throw new Error('Nothing to import; parse first');
      let arr; try { arr = JSON.parse(txt); } catch (e) { throw new Error('Preview JSON is invalid'); }
      if (!Array.isArray(arr)) throw new Error('Import payload must be an array');
      const res = await fetch('/__api/import-contract', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ items: arr }) });
      if (!res.ok) { const t = await res.text().catch(()=>'(no body)'); throw new Error('Import failed: ' + t); }
      await refresh();
      return true;
    }, resolve: true },
    { label: 'Cancel', onClick: () => {}, resolve: true }
  ]});
});

// Save / Load Environment handlers
const saveEnvBtn = document.getElementById('saveEnv');
if (saveEnvBtn) saveEnvBtn.addEventListener('click', async () => {
  const node = document.createElement('div');
  const label = document.createElement('div'); label.textContent = 'Filename (will be saved under data/ e.g. env_backup.json):';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'env_backup.json'; input.style.width = '100%';
  node.appendChild(label); node.appendChild(input);
  await openModal({ title: 'Save Environment', bodyNode: node, actions: [
    { label: 'Save', onClick: async () => {
      const fn = input.value && input.value.trim(); if (!fn) throw new Error('Enter a filename');
      const res = await fetch('/__api/save-env', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ filename: fn }) });
      if (!res.ok) { const t = await res.text().catch(()=>'(no body)'); throw new Error('Save failed: ' + t); }
      return true;
    }, resolve: true },
    { label: 'Cancel', onClick: () => {}, resolve: true }
  ]});
});

const loadEnvBtn = document.getElementById('loadEnv');
if (loadEnvBtn) loadEnvBtn.addEventListener('click', async () => {
  const node = document.createElement('div');
  const label = document.createElement('div'); label.textContent = 'Select a recorded environment JSON file from your computer to upload and load into memory:';
  const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'application/json';
  node.appendChild(label); node.appendChild(fileInput);
  await openModal({ title: 'Load Environment', bodyNode: node, actions: [
    { label: 'Load', onClick: async () => {
      if (!fileInput.files || !fileInput.files[0]) throw new Error('Select a file');
      const txt = await fileInput.files[0].text();
      let obj; try { obj = JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON'); }
      const res = await fetch('/__api/load-env', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ data: obj }) });
      if (!res.ok) { const t = await res.text().catch(()=>'(no body)'); throw new Error('Load failed: ' + t); }
      await refresh();
      return true;
    }, resolve: true },
    { label: 'Cancel', onClick: () => {}, resolve: true }
  ]});
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
