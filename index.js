/**
 * Preset Manager — Chat Completion preset browser/editor for SillyTavern.
 *
 * Features:
 *   • List all Chat Completion presets as cards.
 *   • Multi-select + bulk delete (one confirmation, not one-by-one).
 *   • Editor with two tabs — Prompts (always first) and Parameters.
 *   • Prompts: per-prompt fullscreen editor, duplicate, delete, detach toggle.
 *   • Parameters: grouped into collapsible round sections.
 *
 * Built on the proven mobile-friendly modal pattern from My-lorebook-manager,
 * the multi-select pattern from background-manager, and the tab idea from
 * SillyTavern-ChatCompletionTabs.
 */

// Resolve the install path (e.g. "third-party/ST-PresetManager") from this
// module's URL so renderExtensionTemplateAsync() finds manager.html/settings.html
// regardless of the folder the user installed it under.
const EXTENSION_NAME = (() => {
    try {
        const pathname = new URL(import.meta.url).pathname;
        const match = pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        if (match?.[1]) return decodeURIComponent(match[1]);
    } catch (_) { /* ignore */ }
    return 'third-party/ST-PresetManager';
})();
const SETTINGS_KEY = 'STPresetManager';
const API_ID = 'openai'; // Chat Completion

const DEFAULT_SETTINGS = {
    enabled: true,
    confirmDelete: true,
    sort: 'name-asc',
};

const state = {
    isOpen: false,
    presets: [],          // [{ name }]
    selected: new Set(),  // preset names
    search: '',
    sort: 'name-asc',
    editing: null,        // { name, data }  (data = deep clone of preset JSON)
    promptSearch: '',
    dom: {},
};

/* ── Context helpers ──────────────────────────────────────────────────── */

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const c = ctx();
    if (!c.extensionSettings[SETTINGS_KEY]) {
        c.extensionSettings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const s = c.extensionSettings[SETTINGS_KEY];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
    }
    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function presetManager() {
    try {
        return ctx().getPresetManager(API_ID) || null;
    } catch (e) {
        return null;
    }
}

function popup() {
    return ctx().Popup;
}

async function confirmDialog(title, text) {
    try {
        const p = popup();
        if (p?.show?.confirm) return Boolean(await p.show.confirm(title, text || ''));
    } catch (e) { /* fall through */ }
    return window.confirm(text || title);
}

async function inputDialog(title, text, value) {
    try {
        const p = popup();
        if (p?.show?.input) return await p.show.input(title, text || '', value ?? '');
    } catch (e) { /* fall through */ }
    return window.prompt(text || title, value ?? '');
}

function uuid() {
    try {
        if (typeof ctx().uuidv4 === 'function') return ctx().uuidv4();
    } catch (e) { /* ignore */ }
    return window.crypto?.randomUUID?.() || ('prm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
}

/* ── Small utils ──────────────────────────────────────────────────────── */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

function toast(type, msg) {
    try {
        if (window.toastr && toastr[type]) toastr[type](msg, 'Preset Manager');
    } catch (e) { /* ignore */ }
}

/* ── Data loading ─────────────────────────────────────────────────────── */

function loadPresetNames() {
    const pm = presetManager();
    if (!pm || typeof pm.getAllPresets !== 'function') return [];
    let names = [];
    try { names = pm.getAllPresets() || []; } catch (e) { names = []; }
    // De-dupe while preserving order, drop empties.
    const seen = new Set();
    return names.filter((n) => {
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
    });
}

function refresh({ showLoader = false } = {}) {
    if (showLoader) setLoading(true);
    state.presets = loadPresetNames().map((name) => ({ name }));
    // Drop selections that no longer exist.
    const live = new Set(state.presets.map((p) => p.name));
    for (const n of [...state.selected]) if (!live.has(n)) state.selected.delete(n);
    setLoading(false);
    renderList();
}

/* ── List rendering ───────────────────────────────────────────────────── */

function getVisiblePresets() {
    const q = state.search.trim().toLowerCase();
    let list = state.presets;
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    list = [...list].sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return state.sort === 'name-desc' ? -cmp : cmp;
    });
    return list;
}

function setLoading(on) {
    state.dom.loading?.classList.toggle('prm_hidden', !on);
}

function setEmpty(message) {
    if (!state.dom.empty) return;
    state.dom.empty.textContent = message || '';
    state.dom.empty.classList.toggle('prm_hidden', !message);
}

function renderList() {
    const grid = state.dom.grid;
    if (!grid) return;

    const list = getVisiblePresets();
    grid.innerHTML = '';

    if (!state.presets.length) {
        setEmpty('No Chat Completion presets found. (Make sure the API is set to Chat Completion.)');
    } else if (!list.length) {
        setEmpty('No presets match your search.');
    } else {
        setEmpty('');
    }

    const current = currentActivePresetName();

    for (const preset of list) {
        grid.appendChild(createPresetCard(preset, current));
    }

    if (state.dom.summary) {
        const total = state.presets.length;
        const shown = list.length;
        state.dom.summary.textContent = shown === total
            ? `${total} preset${total === 1 ? '' : 's'}`
            : `${shown} / ${total}`;
    }

    updateSelectUI();
}

function currentActivePresetName() {
    try {
        const sel = document.getElementById('settings_preset_openai');
        if (sel && sel.selectedOptions?.length) return sel.selectedOptions[0].text;
    } catch (e) { /* ignore */ }
    return null;
}

function createPresetCard(preset, currentName) {
    const card = document.createElement('article');
    card.className = 'prm_card';
    card.dataset.prmName = preset.name;
    if (state.selected.has(preset.name)) card.classList.add('is-selected');
    if (currentName && preset.name === currentName) card.classList.add('is-current');

    // Checkbox
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'prm_card_check';
    check.dataset.prmCardAction = 'toggle-select';
    check.setAttribute('aria-label', 'Select');
    check.innerHTML = state.selected.has(preset.name)
        ? '<i class="fa-solid fa-square-check"></i>'
        : '<i class="fa-regular fa-square"></i>';

    // Icon + name
    const main = document.createElement('div');
    main.className = 'prm_card_main';
    main.dataset.prmCardAction = 'edit';

    const icon = document.createElement('div');
    icon.className = 'prm_card_icon';
    icon.innerHTML = '<i class="fa-solid fa-sliders"></i>';

    const info = document.createElement('div');
    info.className = 'prm_card_info';

    const title = document.createElement('span');
    title.className = 'prm_card_title';
    title.textContent = preset.name;
    title.title = preset.name;

    const meta = document.createElement('div');
    meta.className = 'prm_card_meta';
    if (currentName && preset.name === currentName) {
        const badge = document.createElement('span');
        badge.className = 'prm_badge is-current';
        badge.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Active</span>';
        meta.appendChild(badge);
    }
    info.append(title, meta);
    main.append(icon, info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'prm_card_actions';

    const editBtn = iconButton('edit', 'Edit', 'fa-pen-to-square');
    const renameBtn = iconButton('rename', 'Rename', 'fa-i-cursor');
    const dupBtn = iconButton('duplicate', 'Duplicate', 'fa-copy');
    const delBtn = iconButton('delete', 'Delete', 'fa-trash-can');
    delBtn.classList.add('prm_card_btn_danger');

    actions.append(editBtn, renameBtn, dupBtn, delBtn);

    card.append(check, main, actions);
    return card;
}

function iconButton(action, label, icon) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu_button menu_button_icon interactable prm_card_btn';
    b.dataset.prmCardAction = action;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    return b;
}

/* ── Selection ────────────────────────────────────────────────────────── */

function toggleSelection(name) {
    if (state.selected.has(name)) state.selected.delete(name);
    else state.selected.add(name);
    updateSelectUI();
}

function clearSelection() {
    state.selected.clear();
    updateSelectUI();
}

function updateSelectUI() {
    const count = state.selected.size;
    state.dom.selectBar?.classList.toggle('prm_hidden', count === 0);
    if (state.dom.selectCount) {
        state.dom.selectCount.textContent = `${count} selected`;
    }
    state.dom.grid?.querySelectorAll('.prm_card').forEach((card) => {
        const name = card.dataset.prmName;
        const sel = state.selected.has(name);
        card.classList.toggle('is-selected', sel);
        const icon = card.querySelector('.prm_card_check i');
        if (icon) icon.className = sel ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
    });
}

function onSelectAll() {
    getVisiblePresets().forEach((p) => state.selected.add(p.name));
    updateSelectUI();
}

/* ── Card actions ─────────────────────────────────────────────────────── */

function onGridClick(event) {
    const actionEl = event.target.closest('[data-prm-card-action]');
    const card = event.target.closest('.prm_card');
    if (!card) return;
    const name = card.dataset.prmName;
    if (!name) return;

    const action = actionEl?.dataset.prmCardAction;

    if (action === 'toggle-select') { toggleSelection(name); return; }
    if (action === 'edit') { openEditor(name); return; }
    if (action === 'rename') { renamePreset(name); return; }
    if (action === 'duplicate') { duplicatePreset(name); return; }
    if (action === 'delete') { deletePreset(name); return; }

    // Click on empty card area toggles selection (handy for multi-select).
    toggleSelection(name);
}

async function deletePreset(name) {
    const s = getSettings();
    if (s.confirmDelete) {
        const ok = await confirmDialog('Delete preset', `Delete preset "${name}"?`);
        if (!ok) return;
    }
    const pm = presetManager();
    if (!pm) return;
    try {
        await pm.deletePreset(name);
        state.selected.delete(name);
        saveSettings();
        toast('success', `Deleted "${name}"`);
    } catch (e) {
        console.error('[PRM] delete failed', e);
        toast('error', `Failed to delete "${name}"`);
    }
    refresh();
}

async function bulkDelete() {
    const names = [...state.selected];
    if (!names.length) return;
    const s = getSettings();
    if (s.confirmDelete) {
        const ok = await confirmDialog(
            `Delete ${names.length} preset${names.length === 1 ? '' : 's'}?`,
            'This cannot be undone.',
        );
        if (!ok) return;
    }
    const pm = presetManager();
    if (!pm) return;

    setLoading(true);
    let deleted = 0;
    for (const name of names) {
        try {
            await pm.deletePreset(name);
            deleted++;
        } catch (e) {
            console.error('[PRM] bulk delete failed for', name, e);
        }
    }
    setLoading(false);
    clearSelection();
    saveSettings();
    refresh();
    if (deleted) toast('success', `Deleted ${deleted} preset${deleted === 1 ? '' : 's'}`);
}

async function renamePreset(name) {
    const newName = await inputDialog('Rename preset', 'New preset name', name);
    if (newName === null || newName === undefined) return;
    const trimmed = String(newName).trim();
    if (!trimmed || trimmed === name) return;

    const pm = presetManager();
    if (!pm) return;
    if (state.presets.some((p) => p.name === trimmed)) {
        toast('warning', `A preset named "${trimmed}" already exists`);
        return;
    }
    try {
        const data = pm.getCompletionPresetByName(name);
        if (!data) { toast('error', 'Could not read preset'); return; }
        const clone = structuredClone(data);
        await pm.savePreset(trimmed, clone, { skipUpdate: true });
        await pm.deletePreset(name);
        if (state.selected.has(name)) { state.selected.delete(name); state.selected.add(trimmed); }
        saveSettings();
        toast('success', `Renamed to "${trimmed}"`);
    } catch (e) {
        console.error('[PRM] rename failed', e);
        toast('error', 'Rename failed');
    }
    refresh();
}

async function duplicatePreset(name) {
    const pm = presetManager();
    if (!pm) return;
    let base = `${name} (copy)`;
    let n = 2;
    const existing = new Set(state.presets.map((p) => p.name));
    while (existing.has(base)) base = `${name} (copy ${n++})`;
    try {
        const data = pm.getCompletionPresetByName(name);
        if (!data) { toast('error', 'Could not read preset'); return; }
        await pm.savePreset(base, structuredClone(data), { skipUpdate: true });
        saveSettings();
        toast('success', `Duplicated as "${base}"`);
    } catch (e) {
        console.error('[PRM] duplicate failed', e);
        toast('error', 'Duplicate failed');
    }
    refresh();
}

/* ══════════════════════════════════════════════════════════════════════
   EDITOR — Prompts tab (always first) + Parameters tab
   ══════════════════════════════════════════════════════════════════════ */

// Parameter groups: which top-level preset keys go where, with friendly labels
// and an input type hint. Keys not listed appear under "Other (advanced)".
const PARAM_GROUPS = [
    {
        id: 'sampling',
        title: 'Sampling',
        icon: 'fa-dice',
        open: true,
        fields: [
            ['temperature', 'Temperature', 'number'],
            ['top_p', 'Top P', 'number'],
            ['top_k', 'Top K', 'number'],
            ['top_a', 'Top A', 'number'],
            ['min_p', 'Min P', 'number'],
            ['typical_p', 'Typical P', 'number'],
        ],
    },
    {
        id: 'penalties',
        title: 'Penalties',
        icon: 'fa-scale-balanced',
        open: false,
        fields: [
            ['frequency_penalty', 'Frequency Penalty', 'number'],
            ['presence_penalty', 'Presence Penalty', 'number'],
            ['repetition_penalty', 'Repetition Penalty', 'number'],
            ['count_penalty', 'Count Penalty', 'number'],
        ],
    },
    {
        id: 'length',
        title: 'Context & Length',
        icon: 'fa-ruler-horizontal',
        open: false,
        fields: [
            ['openai_max_context', 'Max Context', 'number'],
            ['openai_max_tokens', 'Max Response (tokens)', 'number'],
            ['n', 'Number of responses (n)', 'number'],
            ['seed', 'Seed', 'number'],
        ],
    },
    {
        id: 'reasoning',
        title: 'Reasoning & Output',
        icon: 'fa-brain',
        open: false,
        fields: [
            ['reasoning_effort', 'Reasoning Effort', 'text'],
            ['verbosity', 'Verbosity', 'text'],
            ['stream_openai', 'Stream responses', 'checkbox'],
            ['squash_system_messages', 'Squash system messages', 'checkbox'],
            ['function_calling', 'Function calling', 'checkbox'],
            ['enable_web_search', 'Web search', 'checkbox'],
            ['image_inlining', 'Image inlining', 'checkbox'],
        ],
    },
    {
        id: 'utility',
        title: 'Utility Prompts',
        icon: 'fa-pen-nib',
        open: false,
        fields: [
            ['wi_format', 'World Info format', 'textarea'],
            ['scenario_format', 'Scenario format', 'textarea'],
            ['personality_format', 'Personality format', 'textarea'],
            ['new_chat_prompt', 'New chat prompt', 'textarea'],
            ['new_group_chat_prompt', 'New group chat prompt', 'textarea'],
            ['new_example_chat_prompt', 'New example chat prompt', 'textarea'],
            ['continue_nudge_prompt', 'Continue nudge prompt', 'textarea'],
            ['group_nudge_prompt', 'Group nudge prompt', 'textarea'],
            ['impersonation_prompt', 'Impersonation prompt', 'textarea'],
            ['send_if_empty', 'Replace empty message', 'textarea'],
            ['assistant_prefill', 'Assistant prefill', 'textarea'],
            ['assistant_impersonation', 'Assistant impersonation prefill', 'textarea'],
        ],
    },
];

// Keys we deliberately never show as editable params (handled elsewhere or noise).
const PARAM_HIDDEN = new Set([
    'prompts', 'prompt_order', 'extensions',
]);

const PARAM_LABELS = (() => {
    const m = new Map();
    for (const g of PARAM_GROUPS) for (const [key, label] of g.fields) m.set(key, label);
    return m;
})();

const KNOWN_PARAM_KEYS = (() => {
    const s = new Set();
    for (const g of PARAM_GROUPS) for (const [key] of g.fields) s.add(key);
    return s;
})();

function openEditor(name) {
    const pm = presetManager();
    if (!pm) return;
    const data = pm.getCompletionPresetByName(name);
    if (!data) { toast('error', 'Could not read preset'); return; }

    state.editing = { name, data: structuredClone(data) };
    state.promptSearch = '';
    if (state.dom.promptSearch) state.dom.promptSearch.value = '';
    if (state.dom.editorName) state.dom.editorName.textContent = name;

    switchTab('prompts');
    renderPromptsList();
    renderParamsList();

    state.dom.editor.classList.remove('prm_hidden');
}

function closeEditor() {
    state.editing = null;
    state.dom.editor?.classList.add('prm_hidden');
}

function switchTab(tabId) {
    state.dom.tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.prmTab === tabId));
    Object.entries(state.dom.panels).forEach(([id, el]) => {
        el?.classList.toggle('is-active', id === tabId);
    });
    const body = state.dom.editor?.querySelector('.prm_editor_body');
    if (body) body.scrollTop = 0;
}

async function saveEditor() {
    if (!state.editing) return;
    const pm = presetManager();
    if (!pm) return;
    const { name, data } = state.editing;
    const isActive = currentActivePresetName() === name;
    try {
        // For the active preset, let savePreset update the in-memory array + UI
        // (skipUpdate:false) so the live editor reflects our edits. For inactive
        // presets, skipUpdate avoids switching the active preset out from under us.
        await pm.savePreset(name, structuredClone(data), { skipUpdate: !isActive });
        saveSettings();
        toast('success', `Saved "${name}"`);
        closeEditor();
        refresh();
    } catch (e) {
        console.error('[PRM] save failed', e);
        toast('error', 'Save failed');
    }
}

/* ── Prompts tab ──────────────────────────────────────────────────────── */

function getPrompts() {
    const d = state.editing?.data;
    if (!d) return [];
    if (!Array.isArray(d.prompts)) d.prompts = [];
    return d.prompts;
}

function getPromptById(id) {
    return getPrompts().find((p) => p?.identifier === id) || null;
}

function renderPromptsList() {
    const wrap = state.dom.promptsList;
    if (!wrap || !state.editing) return;

    const q = state.promptSearch.trim().toLowerCase();
    const prompts = getPrompts();
    wrap.innerHTML = '';

    const visible = prompts.filter((p) => {
        if (!q) return true;
        return String(p?.name || '').toLowerCase().includes(q)
            || String(p?.identifier || '').toLowerCase().includes(q);
    });

    if (!prompts.length) {
        wrap.innerHTML = '<div class="prm_status">This preset has no prompts.</div>';
        return;
    }
    if (!visible.length) {
        wrap.innerHTML = '<div class="prm_status">No prompts match your search.</div>';
        return;
    }

    for (const p of visible) wrap.appendChild(createPromptRow(p));
}

function createPromptRow(p) {
    const id = p.identifier;
    const isMarker = !!p.marker;
    const isSystem = !!p.system_prompt;

    const row = document.createElement('div');
    row.className = 'prm_prompt';
    row.dataset.prmPromptId = id;
    if (isMarker) row.classList.add('is-marker');

    // Header (click to expand body)
    const head = document.createElement('div');
    head.className = 'prm_prompt_head';
    head.dataset.prmPromptAction = 'toggle';

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-right prm_prompt_chevron';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'prm_prompt_name';
    nameSpan.textContent = p.name || id || '(unnamed)';

    const tags = document.createElement('span');
    tags.className = 'prm_prompt_tags';
    if (isMarker) tags.innerHTML += '<span class="prm_tag is-marker">marker</span>';
    else if (p.role) tags.innerHTML += `<span class="prm_tag">${escapeHtml(p.role)}</span>`;
    if (isSystem) tags.innerHTML += '<span class="prm_tag is-system">system</span>';

    head.append(chevron, nameSpan, tags);

    // Row actions
    const actions = document.createElement('div');
    actions.className = 'prm_prompt_actions';

    const dup = promptActionBtn('duplicate', 'Duplicate', 'fa-copy');
    actions.appendChild(dup);

    if (!isSystem) {
        const del = promptActionBtn('delete', 'Delete', 'fa-trash-can');
        del.classList.add('prm_card_btn_danger');
        actions.appendChild(del);
    }
    head.appendChild(actions);
    row.appendChild(head);

    // Body
    const body = document.createElement('div');
    body.className = 'prm_prompt_body';

    if (isMarker) {
        body.innerHTML = '<div class="prm_prompt_markernote">Marker prompt — an injection placeholder with no editable content.</div>';
    } else {
        // Name
        body.appendChild(field('Name', () => {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'text_pole prm_prompt_field';
            inp.dataset.prmField = 'name';
            inp.value = p.name || '';
            return inp;
        }));

        // Role
        body.appendChild(field('Role', () => {
            const select = document.createElement('select');
            select.className = 'text_pole prm_prompt_field';
            select.dataset.prmField = 'role';
            for (const r of ['system', 'user', 'assistant']) {
                const opt = document.createElement('option');
                opt.value = r; opt.textContent = r;
                if ((p.role || 'system') === r) opt.selected = true;
                select.appendChild(opt);
            }
            return select;
        }));

        // Content + fullscreen button
        const contentField = document.createElement('div');
        contentField.className = 'prm_field';
        const labelRow = document.createElement('div');
        labelRow.className = 'prm_field_labelrow';
        const label = document.createElement('label');
        label.className = 'prm_field_label';
        label.textContent = 'Content';
        const fsBtn = promptActionBtn('fullscreen', 'Fullscreen editor', 'fa-expand');
        fsBtn.classList.add('prm_field_fs');
        labelRow.append(label, fsBtn);
        const ta = document.createElement('textarea');
        ta.className = 'text_pole prm_prompt_field prm_prompt_content';
        ta.dataset.prmField = 'content';
        ta.rows = 5;
        ta.value = p.content || '';
        ta.spellcheck = false;
        contentField.append(labelRow, ta);
        body.appendChild(contentField);

        // Detach / forbid overrides toggle
        body.appendChild(checkboxField(
            'Forbid character overrides (detach)',
            'forbid_overrides',
            !!p.forbid_overrides,
            'When on, a character card cannot override this prompt.',
        ));
    }

    row.appendChild(body);
    return row;
}

function field(labelText, makeInput) {
    const wrap = document.createElement('div');
    wrap.className = 'prm_field';
    const label = document.createElement('label');
    label.className = 'prm_field_label';
    label.textContent = labelText;
    wrap.append(label, makeInput());
    return wrap;
}

function checkboxField(labelText, fieldName, checked, desc) {
    const wrap = document.createElement('label');
    wrap.className = 'prm_check_row';
    const text = document.createElement('span');
    text.className = 'prm_check_text';
    const main = document.createElement('span');
    main.className = 'prm_check_label';
    main.textContent = labelText;
    text.appendChild(main);
    if (desc) {
        const d = document.createElement('span');
        d.className = 'prm_check_desc';
        d.textContent = desc;
        text.appendChild(d);
    }
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.dataset.prmField = fieldName;
    inp.checked = checked;
    wrap.append(text, inp);
    return wrap;
}

function promptActionBtn(action, label, icon) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu_button menu_button_icon interactable prm_prompt_btn';
    b.dataset.prmPromptAction = action;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    return b;
}

function onPromptsListClick(event) {
    const row = event.target.closest('.prm_prompt');
    if (!row) return;
    const id = row.dataset.prmPromptId;
    const actionEl = event.target.closest('[data-prm-prompt-action]');
    const action = actionEl?.dataset.prmPromptAction;

    if (action === 'toggle') { row.classList.toggle('is-open'); return; }
    if (action === 'duplicate') { duplicatePrompt(id); return; }
    if (action === 'delete') { deletePromptInEditor(id); return; }
    if (action === 'fullscreen') { openFullscreenForPrompt(id, row); return; }
}

function onPromptsListInput(event) {
    const fieldEl = event.target.closest('[data-prm-field]');
    if (!fieldEl) return;
    const row = event.target.closest('.prm_prompt');
    const p = getPromptById(row?.dataset.prmPromptId);
    if (!p) return;
    const key = fieldEl.dataset.prmField;
    if (key === 'name') {
        p.name = fieldEl.value;
        const nameSpan = row.querySelector('.prm_prompt_name');
        if (nameSpan) nameSpan.textContent = p.name || p.identifier || '(unnamed)';
    } else if (key === 'content') {
        p.content = fieldEl.value;
    }
}

function onPromptsListChange(event) {
    const fieldEl = event.target.closest('[data-prm-field]');
    if (!fieldEl) return;
    const row = event.target.closest('.prm_prompt');
    const p = getPromptById(row?.dataset.prmPromptId);
    if (!p) return;
    const key = fieldEl.dataset.prmField;
    if (key === 'role') p.role = fieldEl.value;
    else if (key === 'forbid_overrides') p.forbid_overrides = fieldEl.checked;
}

function duplicatePrompt(identifier) {
    const src = getPromptById(identifier);
    if (!src) return;
    const newId = uuid();
    const copy = structuredClone(src);
    copy.identifier = newId;
    copy.system_prompt = false;
    copy.marker = false;
    if (typeof copy.name === 'string') copy.name = copy.name + ' (copy)';

    const prompts = getPrompts();
    const srcIdx = prompts.findIndex((p) => p.identifier === identifier);
    if (srcIdx !== -1) prompts.splice(srcIdx + 1, 0, copy);
    else prompts.push(copy);

    // Mirror into prompt_order right after the source, disabled by default.
    const order = state.editing?.data?.prompt_order;
    if (Array.isArray(order)) {
        for (const block of order) {
            if (!Array.isArray(block?.order)) continue;
            const i = block.order.findIndex((e) => e?.identifier === identifier);
            const entry = { identifier: newId, enabled: i !== -1 ? !!block.order[i].enabled : false };
            if (i !== -1) block.order.splice(i + 1, 0, entry);
            else block.order.push(entry);
        }
    }
    renderPromptsList();
    toast('success', 'Prompt duplicated');
}

async function deletePromptInEditor(identifier) {
    const src = getPromptById(identifier);
    if (!src) return;
    if (src.system_prompt) { toast('warning', 'System prompts cannot be deleted'); return; }
    if (getSettings().confirmDelete) {
        const ok = await confirmDialog('Delete prompt', `Delete prompt "${src.name || identifier}"?`);
        if (!ok) return;
    }
    const prompts = getPrompts();
    const idx = prompts.findIndex((p) => p.identifier === identifier);
    if (idx !== -1) prompts.splice(idx, 1);

    const order = state.editing?.data?.prompt_order;
    if (Array.isArray(order)) {
        for (const block of order) {
            if (!Array.isArray(block?.order)) continue;
            for (let i = block.order.length - 1; i >= 0; i--) {
                if (block.order[i]?.identifier === identifier) block.order.splice(i, 1);
            }
        }
    }
    renderPromptsList();
    toast('success', 'Prompt deleted');
}

/* ── Parameters tab ───────────────────────────────────────────────────── */

function renderParamsList() {
    const wrap = state.dom.paramsList;
    if (!wrap || !state.editing) return;
    const data = state.editing.data;
    wrap.innerHTML = '';

    for (const group of PARAM_GROUPS) {
        const present = group.fields.filter(([key]) => key in data);
        if (!present.length) continue;
        wrap.appendChild(createParamSection(group.id, group.title, group.icon, group.open, present, data));
    }

    // "Other (advanced)" — every remaining scalar key not already shown/hidden.
    const others = Object.keys(data)
        .filter((k) => !KNOWN_PARAM_KEYS.has(k) && !PARAM_HIDDEN.has(k))
        .filter((k) => {
            const v = data[k];
            return v === null || ['string', 'number', 'boolean'].includes(typeof v);
        })
        .sort();
    if (others.length) {
        const fields = others.map((k) => {
            const v = data[k];
            const type = typeof v === 'boolean' ? 'checkbox'
                : typeof v === 'number' ? 'number'
                : (typeof v === 'string' && v.length > 60) ? 'textarea' : 'text';
            return [k, k, type];
        });
        wrap.appendChild(createParamSection('other', 'Other (advanced)', 'fa-gears', false, fields, data));
    }
}

function createParamSection(id, title, icon, open, fields, data) {
    const section = document.createElement('div');
    section.className = 'prm_param_section' + (open ? ' is-open' : '');
    section.dataset.prmSection = id;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'prm_param_header';
    header.dataset.prmSectionAction = 'toggle';
    header.innerHTML =
        `<i class="fa-solid ${icon} prm_param_icon"></i>` +
        `<span class="prm_param_title">${escapeHtml(title)}</span>` +
        '<i class="fa-solid fa-chevron-down prm_param_chevron"></i>';
    section.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'prm_param_body';

    for (const [key, label, type] of fields) {
        bodyEl.appendChild(createParamField(key, label, type, data[key]));
    }
    section.appendChild(bodyEl);
    return section;
}

function createParamField(key, label, type, value) {
    if (type === 'checkbox') {
        const wrap = document.createElement('label');
        wrap.className = 'prm_check_row prm_param_check';
        const text = document.createElement('span');
        text.className = 'prm_check_label';
        text.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.dataset.prmParam = key;
        inp.checked = !!value;
        wrap.append(text, inp);
        return wrap;
    }

    const wrap = document.createElement('div');
    wrap.className = 'prm_field prm_param_field';
    const lab = document.createElement('label');
    lab.className = 'prm_field_label';
    lab.textContent = label;

    if (type === 'textarea') {
        const labelRow = document.createElement('div');
        labelRow.className = 'prm_field_labelrow';
        const fsBtn = document.createElement('button');
        fsBtn.type = 'button';
        fsBtn.className = 'menu_button menu_button_icon interactable prm_prompt_btn prm_field_fs';
        fsBtn.dataset.prmParamFs = key;
        fsBtn.title = 'Fullscreen editor';
        fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        labelRow.append(lab, fsBtn);
        wrap.appendChild(labelRow);

        const ta = document.createElement('textarea');
        ta.className = 'text_pole prm_param_input';
        ta.dataset.prmParam = key;
        ta.rows = 3;
        ta.spellcheck = false;
        ta.value = value ?? '';
        wrap.appendChild(ta);
        return wrap;
    }

    wrap.appendChild(lab);
    const inp = document.createElement('input');
    inp.type = type === 'number' ? 'number' : 'text';
    if (type === 'number') inp.step = 'any';
    inp.className = 'text_pole prm_param_input';
    inp.dataset.prmParam = key;
    inp.dataset.prmType = type;
    inp.value = value ?? '';
    wrap.appendChild(inp);
    return wrap;
}

function onParamsClick(event) {
    const header = event.target.closest('[data-prm-section-action="toggle"]');
    if (header) {
        header.closest('.prm_param_section')?.classList.toggle('is-open');
        return;
    }
    const fsBtn = event.target.closest('[data-prm-param-fs]');
    if (fsBtn) {
        const key = fsBtn.dataset.prmParamFs;
        const ta = state.dom.paramsList.querySelector(`textarea[data-prm-param="${CSS.escape(key)}"]`);
        if (ta) openFullscreen(PARAM_LABELS.get(key) || key, () => ta.value, (v) => {
            ta.value = v;
            applyParamValue(key, ta);
        });
    }
}

function onParamsInput(event) {
    const el = event.target.closest('[data-prm-param]');
    if (!el) return;
    applyParamValue(el.dataset.prmParam, el);
}

function applyParamValue(key, el) {
    const data = state.editing?.data;
    if (!data) return;
    if (el.type === 'checkbox') {
        data[key] = el.checked;
        return;
    }
    if (el.dataset.prmType === 'number' || el.type === 'number') {
        const raw = el.value.trim();
        if (raw === '') { data[key] = null; return; }
        const num = Number(raw);
        data[key] = Number.isNaN(num) ? raw : num;
        return;
    }
    data[key] = el.value;
}

/* ── Fullscreen text editor ───────────────────────────────────────────── */

// Open SillyTavern's NATIVE maximized-textarea popup (the same one its own
// "expand editor" button uses). This means it looks and behaves exactly like
// the rest of ST, and editor extensions such as CodeMirror Pro — which hook
// into `dialog ... textarea.maximized_textarea` — light up automatically.
// `onCommit(value)` runs with the edited text only if the user confirms.
async function openFullscreen(title, getValue, onCommit) {
    const c = ctx();
    const callGenericPopup = c.callGenericPopup;
    const POPUP_TYPE = c.POPUP_TYPE;
    const POPUP_RESULT = c.POPUP_RESULT;
    if (!callGenericPopup || !POPUP_TYPE) {
        // Extremely old ST without the popup API — fall back to a prompt.
        const edited = window.prompt(title || 'Edit', getValue());
        if (edited !== null && edited !== undefined) onCommit(edited);
        return;
    }

    // Replicate ST's exact wrapper + maximized textarea structure.
    const wrapper = document.createElement('div');
    wrapper.classList.add('height100p', 'wide100p', 'flex-container',
        'flexFlowColumn', 'justifyCenter', 'alignitemscenter');

    if (title) {
        const h = document.createElement('h3');
        h.textContent = title;
        h.style.margin = '0 0 8px';
        h.style.flex = '0 0 auto';
        wrapper.appendChild(h);
    }

    const textarea = document.createElement('textarea');
    textarea.classList.add('height100p', 'wide100p', 'maximized_textarea', 'monospace');
    textarea.value = String(getValue() ?? '');
    wrapper.appendChild(textarea);

    const result = await callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
    });

    const affirmative = POPUP_RESULT ? result === POPUP_RESULT.AFFIRMATIVE : !!result;
    if (affirmative) onCommit(textarea.value);
}

function openFullscreenForPrompt(id, row) {
    const p = getPromptById(id);
    if (!p) return;
    const ta = row.querySelector('textarea[data-prm-field="content"]');
    openFullscreen(p.name || 'Content', () => p.content || '', (v) => {
        p.content = v;
        if (ta) ta.value = v;
    });
}

function closeFullscreen() {
    // Native popup manages its own lifecycle; nothing to tear down.
}

/* ── Open / close ─────────────────────────────────────────────────────── */

async function ensureDom() {
    if (state.dom.modal) return;

    const host = document.createElement('div');
    host.innerHTML = await ctx().renderExtensionTemplateAsync(EXTENSION_NAME, 'manager');
    const modal = host.firstElementChild;
    if (!modal) throw new Error('Failed to render Preset Manager template');

    document.body.appendChild(modal);

    state.dom = {
        modal,
        refresh: modal.querySelector('#prm_refresh'),
        search: modal.querySelector('#prm_search'),
        sort: modal.querySelector('#prm_sort'),
        summary: modal.querySelector('#prm_summary'),
        loading: modal.querySelector('#prm_loading'),
        empty: modal.querySelector('#prm_empty'),
        grid: modal.querySelector('#prm_grid'),
        selectBar: modal.querySelector('#prm_select_bar'),
        selectCount: modal.querySelector('#prm_select_count'),
        selectAll: modal.querySelector('#prm_select_all'),
        deselectAll: modal.querySelector('#prm_deselect_all'),
        bulkDelete: modal.querySelector('#prm_bulk_delete'),
        // Editor
        editor: modal.querySelector('#prm_editor'),
        editorBack: modal.querySelector('#prm_editor_back'),
        editorSave: modal.querySelector('#prm_editor_save'),
        editorName: modal.querySelector('#prm_editor_name'),
        promptSearch: modal.querySelector('#prm_prompt_search'),
        promptsList: modal.querySelector('#prm_prompts_list'),
        paramsList: modal.querySelector('#prm_params_list'),
        tabs: modal.querySelectorAll('.prm_tab'),
        panels: {
            prompts: modal.querySelector('#prm_panel_prompts'),
            params: modal.querySelector('#prm_panel_params'),
        },
    };

    bindEvents();
}

function bindEvents() {
    const d = state.dom;

    d.modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-prm-action="close"]')) closeManager();
    });
    d.refresh.addEventListener('click', () => refresh({ showLoader: true }));

    d.search.addEventListener('input', () => { state.search = d.search.value; renderList(); });
    d.sort.addEventListener('change', () => {
        state.sort = d.sort.value;
        getSettings().sort = state.sort;
        saveSettings();
        renderList();
    });

    d.grid.addEventListener('click', onGridClick);

    d.selectAll.addEventListener('click', onSelectAll);
    d.deselectAll.addEventListener('click', clearSelection);
    d.bulkDelete.addEventListener('click', bulkDelete);

    // Editor
    d.editorBack.addEventListener('click', closeEditor);
    d.editorSave.addEventListener('click', saveEditor);
    d.promptSearch.addEventListener('input', debounce(() => {
        state.promptSearch = d.promptSearch.value;
        renderPromptsList();
    }, 150));
    d.tabs.forEach((tab) => {
        tab.addEventListener('click', () => switchTab(tab.dataset.prmTab));
    });
    d.promptsList.addEventListener('click', onPromptsListClick);
    d.promptsList.addEventListener('input', onPromptsListInput);
    d.promptsList.addEventListener('change', onPromptsListChange);
    d.paramsList.addEventListener('input', onParamsInput);
    d.paramsList.addEventListener('change', onParamsInput);
    d.paramsList.addEventListener('click', onParamsClick);

    document.addEventListener('keydown', (e) => {
        if (!state.isOpen || e.key !== 'Escape') return;
        // If ST's native maximize popup is open, let it handle Escape itself.
        if (document.querySelector('dialog.popup[open] textarea.maximized_textarea')) return;
        if (!d.editor.classList.contains('prm_hidden')) { closeEditor(); return; }
        closeManager();
    });
}

async function openManager() {
    if (!getSettings().enabled) return;
    await ensureDom();
    state.isOpen = true;
    state.sort = getSettings().sort || 'name-asc';
    state.dom.modal.classList.remove('prm_hidden');
    // Lock the page behind the modal so it can't scroll horizontally/vertically
    // (same approach as Image Manager).
    document.body.classList.add('prm_modal_open');
    state.dom.sort.value = state.sort;
    state.dom.search.value = state.search;
    closeEditor();
    refresh({ showLoader: true });
}

function closeManager() {
    if (!state.dom.modal) return;
    state.isOpen = false;
    clearSelection();
    closeFullscreen();
    closeEditor();
    state.dom.modal.classList.add('prm_hidden');
    document.body.classList.remove('prm_modal_open');
}

/* ── Settings panel + entry points ────────────────────────────────────── */

function bindSettingsUI() {
    const s = getSettings();
    const $ = (id) => document.getElementById(id);

    const openBtn = $('prm_open_button');
    const enabled = $('prm_enabled');
    const confirmDelete = $('prm_confirm_delete');

    if (openBtn) openBtn.addEventListener('click', openManager);

    if (enabled) {
        enabled.checked = s.enabled;
        enabled.addEventListener('change', () => {
            s.enabled = enabled.checked;
            saveSettings();
            if (!s.enabled && state.isOpen) closeManager();
        });
    }
    if (confirmDelete) {
        confirmDelete.checked = s.confirmDelete;
        confirmDelete.addEventListener('change', () => {
            s.confirmDelete = confirmDelete.checked;
            saveSettings();
        });
    }
}

/* ── Wand (extensions) menu entry — opens manager directly on click ─────── */

// Close the wand / extensions dropdown the same way SillyTavern does (jQuery
// hide / fadeOut, not a CSS class), with plain-DOM fallbacks.
function closeExtensionsMenu() {
    try {
        if (window.jQuery) {
            const $ = window.jQuery;
            $('#extensionsMenu').fadeOut?.(150);
            $('#extensionsMenu').hide?.();
        }
    } catch (e) { /* ignore */ }
    const menu = document.getElementById('extensionsMenu');
    if (menu) menu.style.display = 'none';
}

function addWandButton() {
    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return false;
    if (document.getElementById('prm_wand_button')) return true;

    const btn = document.createElement('div');
    btn.id = 'prm_wand_button';
    btn.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    btn.tabIndex = 0;
    btn.setAttribute('role', 'button');
    btn.style.cursor = 'pointer';
    btn.title = 'Open Preset Manager';

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-sliders', 'extensionsMenuExtensionButton');
    const text = document.createElement('span');
    text.textContent = 'Preset Manager';

    btn.append(icon, text);

    // Guard against double-fire (touch devices fire touchend AND a synthetic click).
    let lastFire = 0;
    const activate = (e) => {
        // Only preventDefault — do NOT stopPropagation, so ST can auto-close the menu.
        e.preventDefault();
        const now = Date.now();
        if (now - lastFire < 400) return;
        lastFire = now;
        openManager();
        closeExtensionsMenu();
    };
    btn.addEventListener('click', activate);
    btn.addEventListener('touchend', activate, { passive: false });

    container.appendChild(btn);
    return true;
}

/* ── Bootstrap ────────────────────────────────────────────────────────── */

jQuery(async () => {
    console.log(`[${EXTENSION_NAME}] Loading...`);
    try {
        getSettings();
        const settingsHtml = await ctx().renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        const wrap = document.createElement('div');
        wrap.innerHTML = settingsHtml;
        document.getElementById('extensions_settings')?.append(...wrap.childNodes);

        bindSettingsUI();

        // The wand container may not exist yet at load — retry a few times.
        if (!addWandButton()) {
            let tries = 0;
            const timer = setInterval(() => {
                tries++;
                if (addWandButton() || tries > 40) clearInterval(timer);
            }, 500);
        }

        // Keep the active-card highlight fresh after preset switches.
        try {
            const { eventSource, eventTypes } = ctx();
            const evt = eventTypes?.OAI_PRESET_CHANGED_AFTER;
            if (eventSource && evt) {
                eventSource.on(evt, () => {
                    if (state.isOpen && state.dom.editor?.classList.contains('prm_hidden')) renderList();
                });
            }
        } catch (e) { /* ignore */ }

        console.log(`[${EXTENSION_NAME}] Loaded successfully`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to load:`, error);
    }
});
