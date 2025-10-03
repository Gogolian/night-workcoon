import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { recordedData } from './state.js';

const selDir = path.join(process.cwd(), 'data', 'selections');
if (!existsSync(selDir)) mkdirSync(selDir, { recursive: true });

function makeKey(arr) {
  const json = JSON.stringify(arr || []);
  // base64url
  return Buffer.from(json).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

export function setSelection(parentPathArray, responseKey) {
  try {
    const k = makeKey(parentPathArray);
    const out = { path: parentPathArray, responseKey };
    writeFileSync(path.join(selDir, k + '.json'), JSON.stringify(out, null, 2));
    return true;
  } catch (e) { return false; }
}

export function getSelection(parentPathArray) {
  try {
    const k = makeKey(parentPathArray);
    const p = path.join(selDir, k + '.json');
    if (!existsSync(p)) return null;
    const txt = readFileSync(p, 'utf8');
    const obj = JSON.parse(txt);
    return obj && obj.responseKey ? obj.responseKey : null;
  } catch (e) { return null; }
}

// Find the selected record object for a request if one exists; returns the record object or null
export function findSelectedRecord(req, requestBody) {
  try {
    const method = req.method.toUpperCase();
    const url = req.url || '';
    const u = new URL(url, 'http://dummy.base');
    const pathParts = u.pathname.split('/').filter(p => p);
    const queryKey = u.search ? u.search.substring(1) : 'no_query';
    const bodyKey = (requestBody && requestBody.toString()) ? requestBody.toString() : 'no_body';

    // build parent path array consistent with api select-by-path: [method, ...pathParts, queryKey, bodyKey]
    const parent = [method, ...pathParts, queryKey, bodyKey];

    const selected = getSelection(parent);
    if (!selected) return null;

    // traverse recordedData to the parent node
    let node = recordedData;
    if (!node[method]) return null;
    node = node[method];
    for (const p of pathParts) {
      if (!node[p]) return null;
      node = node[p];
    }
    if (!node[queryKey]) return null;
    node = node[queryKey];
    if (!node[bodyKey]) return null;
    const map = node[bodyKey];
    if (!map || typeof map !== 'object') return null;
    if (!map.hasOwnProperty(selected)) return null;
    return map[selected];
  } catch (e) { return null; }
}
