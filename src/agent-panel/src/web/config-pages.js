// 四个配置页：角色与模型、角色资源、导入范围、模型档位。
// /api/selection 提供推荐行、模型档位与显示名；/api/config 提供资源白名单与 revision，
// /api/config/resources 独立探测资源候选。各页草稿独立；保存后回读基础数据，保留其它页草稿。
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item) => b.includes(item)) : a === b);
const copy = (value) => structuredClone(value);
const short = (model) => model.replace(/^[^/]+\//, '');
const provider = (model) => model.split('/')[0];
const ACCESS = [['off', '不开放'], ['optional', '可选'], ['default_on', '默认开启']];
const PROJECT_MODES = [['all', '全部提供'], ['none', '不提供'], ['list', '指定部分']];
const SECTIONS = { extensions: '插件', tools: '工具', skills: '技能' };
// 错误与警告按结构化字段转成界面用语，不显示配置字段名。
const PICK_TEXT = { id: '标识', when: '适用场景', model: '模型', effort_min: '最低档位', effort: '默认档位', effort_max: '最高档位', capability: '任务类型', default: '默认' };
const RESOURCE_TEXT = { tools: '工具', extensions: '插件', skills: '技能', project_skills: '项目技能' };
const IMPORT_TEXT = { access: '开放方式', label: '显示名', group: '分组' };
const NOTE_TEXT = { efforts: '可选档位', tag: '标签', description: '用途说明', effort_note: '备注' };
const PHRASES = [[/ ?effort_min/g, '最低档位'], [/ ?effort_max/g, '最高档位'], [/不带 capability 的推荐/g, '任务类型为「全部任务」的推荐'], [/设为 default/g, '设为默认']];
// 编译器把默认开启的工具无条件并入角色选择；唯一的条件依赖是后台长命令需要最终工具面含命令行（ops/tools/pi_worker_resources.mjs 的 workerSpawnTools）。
const TOOL_NEEDS = { command_job: 'bash' };

export function createConfigPages({ roots, request, notify, updateSync }) {
  let sel = null;
  let cfg = null;
  let loadError = '';
  let catalogError = '';
  let resourceLoading = false;
  let resourceRequested = false;
  let resourceInFlight = null;
  let syncInFlight = null;
  let syncGeneration = 0;
  const resResults = {};
  let loaded = false;
  let dragging = null;
  const drafts = { picks: {}, efforts: {}, notes: {}, res: {}, imports: {} };
  const pages = Object.fromEntries(Object.keys(roots).map((page) => [page, { busy: false, errors: [], notice: '' }]));
  const expanded = new Set();
  const narrowing = new Map();
  const openGroups = new Set();
  const openDescriptions = new Set();
  let selectedPickRole = 'executor-agent';
  let pickDetailsOpen = false;
  const missingNames = new Set();

  // ── 显示名与分组 ──
  const labels = () => sel?.labels || {};
  const roleLabel = (role) => labels().roles?.[role] || {};
  const roleName = (role) => {
    if (roleLabel(role).name) return roleLabel(role).name;
    if (!missingNames.has(role)) { console.warn(`面板缺少角色显示名：${role}`); missingNames.add(role); }
    return '名称待补';
  };
  const roleHead = (role, tail) => `<div class="role-name">${roleLabel(role).name ? `${html(roleLabel(role).name)}<span class="role-id">${html(role)}</span>` : `<span class="soft mono">${html(role)}</span>`}</div>
    <div class="role-does">${html(roleLabel(role).summary)}</div><div class="role-default">${tail}</div>`;
  const capText = (role, cap) => roleLabel(role).capabilities?.[cap];
  const capHtml = (role, cap) => html(capText(role, cap) || '名称待补');
  function grouped(roles) {
    const order = Object.keys(labels().roles || {});
    const rank = (role) => (order.includes(role) ? order.indexOf(role) : order.length);
    const groups = new Map((labels().group_order || []).map((group) => [group, []]));
    for (const role of [...roles].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const group = roleLabel(role).group || '未分组';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(role);
    }
    return [...groups].filter(([, list]) => list.length);
  }
  const header = (page, title, note, dirty, withDiscard = false) => {
    const state = pages[page];
    return `<div class="label-line"><h1>${title}</h1><span class="note">${note}</span><span class="grow"></span>
      ${withDiscard ? `<button type="button" class="secondary-button" data-act="discard"${dirty && !state.busy ? '' : ' disabled'}>放弃修改</button>` : ''}
      <button type="button" class="primary-button" data-act="save"${dirty && !state.busy && !state.conflict ? '' : ' disabled'}>${state.busy ? '保存中…' : '保存'}</button></div>
      ${messages(page)}`;
  };
  function fieldText(item) {
    const field = item.field || '';
    let match;
    if ((match = /^picks\[\d+\]\.(\w+)$/.exec(field))) return PICK_TEXT[match[1]] || '';
    if ((match = /^capabilities\.([^.]+)(?:\.(\w+))?$/.exec(field))) return `「${capText(item.role, match[1]) || match[1]}」${match[2] ? `的${RESOURCE_TEXT[match[2]]}` : ''}`;
    if ((match = /^notes\."(.+)"\.(efforts|tag|description|effort_note)$/.exec(field))) return `${match[1]} 的${NOTE_TEXT[match[2]]}`;
    if ((match = /^(tools|extensions|skills)\.(.+)\.(access|label|group)$/.exec(field))) return `${SECTIONS[match[1]]} ${match[2]} 的${IMPORT_TEXT[match[3]]}`;
    return RESOURCE_TEXT[field] || '';
  }
  function plain(item) {
    let text = PHRASES.reduce((out, [pattern, value]) => out.replace(pattern, value), item.message);
    for (const cap of item.role && sel ? capabilities(item.role) : []) text = text.replaceAll(cap.id, `「${capText(item.role, cap.id) || cap.id}」`);
    return text;
  }
  function describe(item) {
    const where = [item.role && roleName(item.role), item.pick_id, fieldText(item)].filter(Boolean).join(' · ');
    return where ? `${where}：${plain(item)}` : plain(item);
  }
  function messages(page) {
    const state = pages[page];
    const errors = state.errors.map((item) => `<li>${html(describe(page === 'picks' && item.pick_id && item.index !== undefined
      ? { ...item, pick_id: `第 ${item.index + 1} 行` } : item))}</li>`).join('');
    const reload = state.conflict ? '<button type="button" class="secondary-button" data-act="reload">重新读取</button>' : '';
    const stale = loadError ? `<div class="cfg-msg is-error">${html(loadError)}<button type="button" class="secondary-button" data-act="reload">重新读取</button></div>` : '';
    return `${stale}${errors ? `<ul class="cfg-msg is-error">${errors}</ul>` : ''}${state.notice ? `<div class="cfg-msg">${html(state.notice)}${reload}</div>` : ''}`;
  }

  // ── 角色与模型 ──
  const effortLevels = () => sel.effort_levels;
  // 模型的有效可选档位（笔记 efforts ∩ Pi 支持档），由服务端投影给出。
  const levelsOf = (model) => sel.catalog.models.find((entry) => entry.model === model)?.efforts ?? effortLevels();
  const piReady = () => sel.pi_catalog.available;
  const inPi = (model) => !piReady() || sel.pi_catalog.models.some((entry) => entry.value === model);
  function modelChoices(current) {
    const base = piReady() ? sel.pi_catalog.models.map((entry) => entry.value) : sel.catalog.models.map((entry) => entry.model);
    const values = [...new Set([...base, current])];
    return [...new Set(values.map(provider))].map((name) => `<optgroup label="${html(name)}">${values.filter((value) => provider(value) === name)
      .map((value) => `<option value="${html(value)}"${value === current ? ' selected' : ''}>${html(value)}${inPi(value) ? '' : '（不在 Pi 清单）'}</option>`).join('')}</optgroup>`).join('');
  }
  const pickLabel = (pick) => `${short(pick.model)} · ${pick.effort}`;
  const fixedPick = (role, pick) => (sel.fixed_picks[role] || []).includes(pick.id) && sel.editable.roles[role].some((saved) => saved.id === pick.id);
  const picksDirty = () => Object.keys(drafts.picks).some((role) => !same(drafts.picks[role], sel.editable.roles[role]));
  const capabilities = (role) => sel.catalog.roles.find((item) => item.role === role)?.capabilities || [];
  const invalid = (page, test) => pages[page].errors.some(test);

  function defaults(role, picks) {
    const caps = capabilities(role);
    const base = picks.find((pick) => !pick.capability && pick.default);
    const own = (cap) => picks.find((pick) => pick.capability === cap.id && pick.default);
    const needsBase = !caps.length || caps.some((cap) => cap.inherit_role_picks && !own(cap));
    return { caps, base, own, lacking: needsBase && !base };
  }
  function capChips(role, picks) {
    const { caps, base, own } = defaults(role, picks);
    return caps.map((cap) => {
      const mine = own(cap);
      const used = mine || (cap.inherit_role_picks ? base : null);
      const body = used ? `<span class="m">${html(pickLabel(used))}</span>${mine ? '' : '<span class="inh">角色默认</span>'}` : '<span class="miss">未设默认，无法派发</span>';
      return `<span class="cap${used ? '' : ' is-miss'}">${capHtml(role, cap.id)}<span class="arrow">→</span>${body}${cap.inherit_role_picks ? '' : '<span class="own">仅用专属推荐</span>'}</span>`;
    }).join('');
  }
  // 错误里的字段形如 picks[2].effort_min，取最后一段对应到行内控件。
  const fieldOf = (item) => item.field?.split('.').at(-1);
  function pickRow(role, pick, index, count, compact) {
    const caps = capabilities(role);
    const bad = (field) => invalid('picks', (item) => item.role === role && (item.pick_id === pick.id || item.index === index) && fieldOf(item) === field);
    const attrs = (field, extra = '') => {
      const classes = [extra, bad(field) && 'is-invalid'].filter(Boolean).join(' ');
      return `data-role="${html(role)}" data-i="${index}" data-f="${field}" aria-label="${html(PICK_TEXT[field])}"${classes ? ` class="${classes}"` : ''}`;
    };
    const levels = levelsOf(pick.model);
    const effort = (field) => `<select ${attrs(field)}>${[...new Set([...levels, pick[field]])].map((level) => `<option${level === pick[field] ? ' selected' : ''}>${html(level)}</option>`).join('')}</select>`;
    const fixed = fixedPick(role, pick);
    const text = (field, extra) => `<input type="text" ${attrs(field, extra)} value="${html(pick[field])}"${fixed && field === 'id' ? ' readonly title="分身工具固定引用，不能改名"' : ''}>`;
    return `<tr data-role="${html(role)}" data-i="${index}">
      <td class="order"><span class="grip" title="拖动排序">⋮⋮</span><button type="button" class="ic" data-act="up" title="上移" aria-label="上移"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" class="ic" data-act="down" title="下移" aria-label="下移"${index === count - 1 ? ' disabled' : ''}>↓</button></td>
      <td>${text('id', 'mono pid')}</td>
      ${compact ? '' : `<td>${text('when')}</td>`}
      <td><select ${attrs('model', inPi(pick.model) ? 'mono' : 'mono is-warn')}>${modelChoices(pick.model)}</select></td>
      <td>${effort('effort_min')}</td><td>${effort('effort')}</td><td>${effort('effort_max')}</td>
      ${compact ? '' : `<td><select ${attrs('capability')}><option value="">全部任务</option>${caps.map((cap) => `<option value="${html(cap.id)}"${cap.id === pick.capability ? ' selected' : ''}>${html(capText(role, cap.id) || cap.id)}</option>`).join('')}</select></td>`}
      <td class="c"><button type="button" class="dot${pick.default ? ' on' : ''}${bad('default') ? ' is-invalid' : ''}" data-act="default" title="设为默认" aria-label="设为默认"></button></td>
      <td class="c"><button type="button" class="danger-button" data-act="delete" title="${fixed ? '分身工具固定引用，不能删除' : '删除此推荐'}"${fixed ? ' disabled' : ''}>删除推荐</button></td>
    </tr>`;
  }
  function picksCard(role) {
    const picks = drafts.picks[role];
    const compact = !capabilities(role).length;
    const { lacking, base } = defaults(role, picks);
    const head = base ? html(pickLabel(base)) : lacking ? '缺少默认' : '按任务类型分别默认';
    const cols = compact
      ? '<col style="width:72px"><col style="width:150px"><col><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:76px"><col style="width:104px">'
      : '<col style="width:72px"><col style="width:150px"><col><col style="width:250px"><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:150px"><col style="width:76px"><col style="width:104px">';
    const thead = `<tr><th rowspan="2">顺序</th><th rowspan="2">标识</th>${compact ? '' : '<th rowspan="2">适用场景</th>'}<th rowspan="2">模型</th><th colspan="3" class="grp">档位</th>${compact ? '' : '<th rowspan="2">任务类型</th>'}<th rowspan="2" class="c">默认</th><th rowspan="2" class="c">删除</th></tr><tr><th class="sub">最低</th><th class="sub">默认</th><th class="sub">最高</th></tr>`;
    return `<details class="pick-details"${pickDetailsOpen ? ' open' : ''}><summary>展开配置详情 <span>编辑推荐、适用场景和技术标识</span></summary>
      <div class="pick-editor" data-card="${html(role)}">
        <p class="note">以下为技术配置编辑区。保存后下一次派发生效。</p>
        ${compact ? '' : `<div class="caps">${capChips(role, picks)}</div>`}
        <p class="note">默认 ${head}</p>
        <div class="table-scroll"><table class="picks${compact ? ' compact' : ''}"><colgroup>${cols}</colgroup><thead>${thead}</thead><tbody>${picks.map((pick, index) => pickRow(role, pick, index, picks.length, compact)).join('')}</tbody></table></div>
        <button type="button" class="add" data-act="add" data-role="${html(role)}">＋ 新增推荐</button>
      </div>
    </details>`;
  }
  function renderPicks() {
    const roles = Object.keys(drafts.picks);
    if (!roles.includes(selectedPickRole) && roles.length) selectedPickRole = roles[0];
    const role = selectedPickRole;
    const picks = drafts.picks[role] || [];
    const warnings = sel.catalog.warnings.filter((item) => item.role).map((item) => `<li>${html(describe(item))}</li>`).join('');
    const list = grouped(roles).map(([group, members]) => `<li class="pick-group">${html(group)}</li>${members.map((name) => `<li><button type="button" data-act="pick-role" data-role="${html(name)}" aria-current="${name === role}"><b>${html(roleName(name))}</b><small>${html(roleLabel(name).summary)}</small></button></li>`).join('')}`).join('');
    const rows = picks.map((pick) => `<tr><td><strong>${html(roleLabel(role).picks?.[pick.id] || pick.when || capText(role, pick.capability) || '常规任务')}</strong>${pick.default ? `<span class="task-note">${pick.capability ? `${capHtml(role, pick.capability)}的默认推荐` : '角色默认'}</span>` : ''}</td>
        <td class="model">${html(short(pick.model))}</td><td>${html(pick.effort)}</td><td>${html(pick.effort_min)} – ${html(pick.effort_max)}</td></tr>`).join('');
    return `<div class="pick-heading"><div><h1>角色与模型</h1><p class="note">先找到适合任务的角色，再查看它擅长什么、默认使用哪个模型和档位。修改配置后保存。</p></div>
      <div class="pick-heading-actions"><button type="button" class="secondary-button" data-act="reload">重新读取</button>
      <button type="button" class="secondary-button" data-act="discard"${picksDirty() && !pages.picks.busy ? '' : ' disabled'}>放弃修改</button>
      <button type="button" class="primary-button" data-act="save"${picksDirty() && !pages.picks.busy && !pages.picks.conflict ? '' : ' disabled'}>${pages.picks.busy ? '保存中…' : '保存更改'}</button></div></div>
      ${messages('picks')}${warnings ? `<ul class="cfg-msg is-warn">${warnings}</ul>` : ''}
      <div class="pick-layout"><aside class="pick-panel pick-nav"><div class="pick-panel-head"><h2>角色</h2><p>选择角色，查看任务类型与模型推荐。</p></div><ul>${list}</ul></aside>
      <section class="pick-panel pick-main"><div class="pick-eyebrow">当前角色</div><div class="pick-title"><h2>${html(roleName(role))}</h2><span class="pick-badge">${html(roleLabel(role).group || '未分组')}</span></div>
      <div class="pick-intro"><strong>擅长</strong><p>${html(roleLabel(role).summary || '名称待补')}</p></div>
      <div class="pick-section-head"><h3>任务类型与模型推荐</h3><p>先看常用配置，再按任务选择其它推荐。</p></div>
      <div class="table-scroll"><table class="pick-summary"><thead><tr><th scope="col">任务类型</th><th scope="col">推荐模型</th><th scope="col">默认档位</th><th scope="col">可调范围</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="pick-foot">档位由 off 至 max 递增；可选档位在「模型档位」页维护。</p>${picksCard(role)}</section></div>`;
  }
  function nearest(levels, value) {
    const rank = (level) => effortLevels().indexOf(level);
    return levels.includes(value) ? value : [...levels].sort((a, b) => Math.abs(rank(a) - rank(value)) - Math.abs(rank(b) - rank(value)))[0];
  }
  function editPick(role, index, field, value) {
    const pick = drafts.picks[role][index];
    if (field === 'model') {
      pick.model = value;
      for (const key of ['effort_min', 'effort', 'effort_max']) pick[key] = nearest(levelsOf(value), pick[key]);
    } else if (field === 'when' || field === 'capability') {
      if (value) pick[field] = value; else delete pick[field];
      // 默认行随任务类型移动时，新任务类型里原有的默认让出。
      if (field === 'capability' && pick.default) drafts.picks[role].forEach((other) => { if (other !== pick && (other.capability || '') === value) delete other.default; });
    } else pick[field] = value;
  }
  function checkIds() {
    const errors = [];
    for (const [role, picks] of Object.entries(drafts.picks)) {
      picks.forEach((pick, index) => {
        const message = !pick.id ? '不能为空' : picks.findIndex((other) => other.id === pick.id) !== index ? '与其它推荐行重复' : '';
        if (message) errors.push({ role, pick_id: pick.id || `第 ${index + 1} 行`, field: `picks[${index}].id`, index, message });
      });
    }
    return errors;
  }

  // ── 角色资源 ──
  const resourceRoles = () => cfg.roles.filter((record) => !record.missing);
  const record = (role) => cfg.roles.find((item) => item.role === role);
  const emptyValue = (field) => (field === 'project_skills' ? 'none' : []);
  const roleValue = (rec, field) => (Object.hasOwn(drafts.res[rec.role] || {}, field) ? drafts.res[rec.role][field] : rec[field] ?? emptyValue(field));
  const capValue = (rec, cap, field) => {
    const draft = drafts.res[rec.role]?.capabilities?.[cap];
    return draft && Object.hasOwn(draft, field) ? draft[field] : rec.capabilities.find((item) => item.id === cap)?.[field] ?? null;
  };
  // 角色值变化时，任务类型收窄里越出角色的项随之移除，收窄到与角色相同时回到继承。
  function clamp(value, override) {
    if (override === 'none' || value === 'all') return override;
    if (!Array.isArray(value) || override === 'all') return null;
    const kept = override.filter((name) => value.includes(name));
    return sameSet(kept, value) ? null : kept;
  }
  const commitRes = (role, draft) => { if (Object.keys(draft).length) drafts.res[role] = draft; else delete drafts.res[role]; };
  // 任务类型级取值：null 表示与角色相同（删除该键）。
  function setCapValue(rec, cap, field, value) {
    const draft = copy(drafts.res[rec.role] || {});
    const entry = { ...(draft.capabilities?.[cap] || {}) };
    const saved = rec.capabilities.find((item) => item.id === cap)?.[field] ?? null;
    if (sameSet(value, saved) && !pages.res.busy) delete entry[field]; else entry[field] = value;
    draft.capabilities = { ...(draft.capabilities || {}), [cap]: entry };
    if (!Object.keys(entry).length) delete draft.capabilities[cap];
    if (!Object.keys(draft.capabilities).length) delete draft.capabilities;
    commitRes(rec.role, draft);
  }
  function setRoleValue(rec, field, value) {
    const draft = copy(drafts.res[rec.role] || {});
    if (sameSet(value, rec[field] ?? emptyValue(field)) && !pages.res.busy) delete draft[field]; else draft[field] = value;
    commitRes(rec.role, draft);
    for (const cap of rec.capabilities) {
      const override = capValue(rec, cap.id, field);
      if (override !== null) setCapValue(rec, cap.id, field, clamp(value, override));
    }
  }
  // 收窄后与角色值相同即回到继承。
  const narrowTo = (rec, cap, field, value) => setCapValue(rec, cap, field, sameSet(value, roleValue(rec, field)) ? null : value);
  const catalog = () => cfg.resource_catalog;
  // 工具分组按显示名文件的 tool_group_order 排列，未列出的分组按出现顺序排在后面。
  function groupOrder(groups) {
    const order = labels().tool_group_order || [];
    const rank = (group) => (order.includes(group) ? order.indexOf(group) : order.length);
    return [...new Set(groups)].map((group, index) => ({ group, index })).sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index).map(({ group }) => group);
  }
  const itemLabel = (item) => (item?.label ? html(item.label) : '<span class="soft">未填写显示名</span>');
  const catalogFailure = () => `<div class="cfg-msg is-warn">${html(catalog().error)}<button type="button" class="secondary-button" data-act="reload">重试</button></div>`;
  // 默认开启的工具在该角色（或所选任务类型）上是否可用；只有依赖其它工具的项目可能不可用，返回原因。
  function toolBlocked(rec, cap, name) {
    const need = catalog().tools.find((item) => item.name === TOOL_NEEDS[name]);
    if (!need || need.access === 'default_on' || (need.access === 'optional' && levelValue(rec, cap, 'tools').includes(need.name))) return '';
    return `需勾选${need.label || need.name}`;
  }
  function resourceTag(field, name) {
    const item = catalog()[field].find((entry) => entry.name === name);
    if (!item || !item.installed) return '未安装';
    return item.access === 'off' ? '不开放' : item.access === 'default_on' ? '默认开启' : '';
  }
  // cap 为空时编辑角色值；选中任务类型时编辑该任务类型的收窄值。
  const levelValue = (rec, cap, field) => (cap ? capValue(rec, cap, field) ?? roleValue(rec, field) : roleValue(rec, field));
  const capAttr = (cap) => (cap ? ` data-cap="${html(cap)}"` : '');
  function checklist(rec, cap, field, names) {
    const value = levelValue(rec, cap, field);
    const editable = catalog().available;
    return names.map((name) => {
      const item = catalog()[field].find((entry) => entry.name === name);
      const tag = resourceTag(field, name);
      return `<label class="item"><input type="checkbox" data-role="${html(rec.role)}"${capAttr(cap)} data-field="${field}" data-name="${html(name)}"${value.includes(name) ? ' checked' : ''}${editable ? '' : ' disabled'}><span><span class="n">${itemLabel(item)}</span> <span class="d mono">${html(name)}</span>${tag ? ` <span class="tag">${tag}</span>` : ''}</span></label>`;
    }).join('');
  }
  // 角色级列出导入范围中可选的项；任务类型级只列角色已勾选的项。
  function candidates(rec, cap, field) {
    if (cap) return roleValue(rec, field);
    const optional = catalog()[field].filter((item) => item.access === 'optional' && item.installed).map((item) => item.name);
    return [...new Set([...optional, ...roleValue(rec, field)])];
  }
  function toolColumns(rec, cap) {
    const names = candidates(rec, cap, 'tools');
    const groupOf = (name) => catalog().tools.find((item) => item.name === name)?.group || '未分组';
    const blocks = groupOrder(names.map(groupOf)).map((group) => ({ title: group, body: checklist(rec, cap, 'tools', names.filter((name) => groupOf(name) === group)), size: names.filter((name) => groupOf(name) === group).length + 1 }));
    const extensions = candidates(rec, cap, 'extensions');
    blocks.push({ title: '插件', body: checklist(rec, cap, 'extensions', extensions), size: extensions.length + 1 });
    // 工具分组与插件按条数均分到前两栏。
    const total = blocks.reduce((sum, block) => sum + block.size, 0);
    let split = 0;
    for (let acc = 0; split < blocks.length && Math.abs(total - 2 * (acc + blocks[split].size)) <= Math.abs(total - 2 * acc); split += 1) acc += blocks[split].size;
    const column = (list) => `<div class="res">${list.map((block) => `<h3>${html(block.title)}</h3>${block.body}`).join('')}</div>`;
    return column(blocks.slice(0, split)) + column(blocks.slice(split));
  }
  function projectColumn(rec, cap) {
    const role = roleValue(rec, 'project_skills');
    const value = levelValue(rec, cap, 'project_skills');
    const mode = Array.isArray(value) ? 'list' : value;
    const editable = catalog().available;
    // 任务类型级只能收窄：角色全部提供时三种都可选，角色指定部分时只能不提供或在其中挑选，角色不提供时只能不提供。
    const modes = PROJECT_MODES.filter(([id]) => !cap || id === 'none' || (id === 'all' ? role === 'all' : role !== 'none'));
    const pool = cap && Array.isArray(role) ? role : [...new Set([...catalog().project_skills.map((item) => item.name), ...(Array.isArray(value) ? value : [])])];
    const listed = mode === 'list' ? pool.map((name) => `<label class="item"><input type="checkbox" data-role="${html(rec.role)}"${capAttr(cap)} data-field="project_skills" data-name="${html(name)}"${value.includes(name) ? ' checked' : ''}${editable ? '' : ' disabled'}><span class="d mono">${html(name)}</span></label>`).join('') : '';
    return `<h3>项目技能</h3><div class="radio">${modes.map(([id, text]) => `<label><input type="radio" name="pm-${html(rec.role)}" data-role="${html(rec.role)}"${capAttr(cap)} data-mode="${id}"${mode === id ? ' checked' : ''}${editable ? '' : ' disabled'}> ${text}</label>`).join('')}</div>${listed}
      <div class="sub">按角色工作所在工程，提供该工程自带的技能</div>`;
  }
  function resourceSummary(rec) {
    const count = (field) => roleValue(rec, field).length;
    const project = roleValue(rec, 'project_skills');
    return `工具 ${count('tools')} · 插件 ${count('extensions')} · 技能 ${count('skills')} · 项目技能 ${PROJECT_MODES.find(([id]) => id === (Array.isArray(project) ? 'list' : project))[1]}`;
  }
  function resourceCard(role) {
    const rec = record(role);
    const open = expanded.has(role) || invalid('res', (item) => item.role === role);
    const result = resResults[role];
    const status = result === 'saved' ? '已保存' : result === 'conflict' ? '版本冲突 · 草稿保留' : result === 'unsaved' ? '未保存' : '';
    const actions = result === 'conflict' ? `<button type="button" class="secondary-button" data-act="recover-role" data-role="${html(role)}">保留草稿并更新版本</button><button type="button" class="secondary-button" data-act="reload-role" data-role="${html(role)}">仅重载此角色</button>` : '';
    const head = `<div class="role-head" data-act="fold">${roleHead(role, html(resourceSummary(rec)))}${status ? `<span class="note" data-result="${result}">${status}</span>${actions}` : ''}</div>`;
    if (!open) return `<article class="role collapsed" data-card="${html(role)}">${head}</article>`;
    // 交卷工具属于运行通道，不列入默认开启。
    const defaultOn = ['tools', 'extensions', 'skills'].flatMap((field) => catalog()[field].filter((item) => item.access === 'default_on' && item.installed && !catalog().required_tools.includes(item.name)).map((item) => ({ ...item, field })));
    const narrowed = (id) => ['tools', 'extensions', 'skills', 'project_skills'].some((field) => capValue(rec, id, field) !== null);
    const active = rec.capabilities.some((item) => item.id === narrowing.get(role)) ? narrowing.get(role) : '';
    const caps = rec.capabilities.length > 1
      ? `<div class="note cap-line">按任务类型收窄：${rec.capabilities.map((cap) => `<button type="button" class="cap cap-toggle${cap.id === active ? ' on' : ''}" data-act="cap" data-role="${html(role)}" data-cap="${html(cap.id)}">${capHtml(role, cap.id)} · ${narrowed(cap.id) ? '已收窄' : '与角色相同'}</button>`).join(' ')}
        ${active ? `<button type="button" class="secondary-button" data-act="cap-reset" data-role="${html(role)}" data-cap="${html(active)}"${narrowed(active) ? '' : ' disabled'}>恢复与角色相同</button>` : ''}</div>`
      : '<div class="note">仅一种任务类型，无需单独收窄。</div>';
    const scope = active ? `<div class="note scope-note">以下为「${capHtml(role, active)}」的资源，只列出角色已勾选的项目；取消勾选即收窄。</div>` : '';
    return `<article class="role" data-card="${html(role)}">${head}
      <div class="role-body">
        <div class="defon"><span class="defon-t">默认开启</span>${defaultOn.map((item) => {
          const blocked = item.field === 'tools' && toolBlocked(rec, active, item.name);
          return `<span class="chip${blocked ? ' is-off' : ''}" data-field="${item.field}" data-name="${html(item.name)}"><input type="checkbox"${blocked ? '' : ' checked'} disabled>${item.label ? html(item.label) : `<span class="mono">${html(item.name)}</span>`}${blocked ? `<span class="why">${html(blocked)}</span>` : ''}</span>`;
        }).join('')}<span class="note">在「导入范围」中修改</span></div>
        ${scope}
        <div class="res-cols${active ? ' is-narrowing' : ''}">${toolColumns(rec, active)}<div class="res"><h3>技能</h3>${checklist(rec, active, 'skills', candidates(rec, active, 'skills'))}${projectColumn(rec, active)}</div></div>
        ${caps}
      </div>
    </article>`;
  }
  function renderRes() {
    const blocked = resourceLoading ? '<div class="cfg-msg">正在读取 Pi 插件与技能目录…</div>' : catalog().available ? '' : catalogFailure();
    return `${header('res', '角色资源', '勾选的资源才会提供给该角色；此处只列出「导入范围」中设为可选的项目。', Object.keys(drafts.res).some((role) => resResults[role] !== 'conflict'))}
      ${blocked}
      ${grouped(resourceRoles().map((rec) => rec.role)).map(([group, list]) => `<div class="group"><h2>${html(group)}</h2>${list.map(resourceCard).join('')}</div>`).join('')}`;
  }

  // ── 导入范围 ──
  // 行按导入配置的键（可含 *）归并，同一键匹配到的多个资源共用一行；未记录的资源（key 为空）按名字各占一行，保存时补建条目。
  function importRows(section) {
    const rows = new Map();
    for (const item of catalog()[section]) {
      const key = item.key ?? item.name;
      const row = rows.get(key) || { key, access: item.access, label: item.label, group: item.group || '', installed: false };
      row.installed ||= item.installed;
      rows.set(key, row);
    }
    if (section === 'tools') for (const name of catalog().required_tools) if (!rows.has(name)) rows.set(name, { key: name, access: 'default_on', label: '', group: '', installed: true });
    return [...rows.values()];
  }
  const importBase = (section, row) => ({ access: row.access, label: row.label, ...(section === 'tools' && { group: row.group }) });
  const importValue = (section, row) => drafts.imports[section]?.[row.key] ?? importBase(section, row);
  function setImport(section, row, patch) {
    const next = { ...importValue(section, row), ...patch };
    const entries = { ...(drafts.imports[section] || {}) };
    if (same(next, importBase(section, row)) && !pages.import.busy) delete entries[row.key]; else entries[row.key] = next;
    if (Object.keys(entries).length) drafts.imports[section] = entries; else delete drafts.imports[section];
  }
  function seg(section, key, access, locked) {
    return `<div class="seg${locked ? ' locked' : ''}">${ACCESS.map(([id, text]) => `<button type="button" class="${id === access ? 'on' : ''}" data-act="access" data-section="${section}" data-key="${html(key)}" data-v="${id}"${locked ? ' disabled' : ''}>${text}</button>`).join('')}</div>`;
  }
  function importRow(section, row, groups) {
    const value = importValue(section, row);
    const locked = section === 'tools' && catalog().required_tools.includes(row.key);
    const bad = (field) => (invalid('import', (item) => item.field === `${section}.${row.key}.${field}`) ? ' is-invalid' : '');
    const name = `<td><input type="text" class="${bad('label')}" data-section="${section}" data-key="${html(row.key)}" data-f="label" value="${html(value.label)}" placeholder="未填写显示名"></td>
      <td class="raw mono" title="${html(row.key)}">${html(row.key)}${row.installed ? '' : ' <span class="tag">未安装</span>'}</td>`;
    const group = section === 'tools'
      ? `<td><select class="${bad('group')}" data-section="tools" data-key="${html(row.key)}" data-f="group"${locked ? ' disabled' : ''}>${['', ...groups].map((item) => `<option value="${html(item)}"${item === value.group ? ' selected' : ''}>${html(item || '未分组')}</option>`).join('')}</select></td>` : '';
    return `<tr>${name}${group}<td>${seg(section, row.key, value.access, locked)}</td></tr>`;
  }
  function toolRows() {
    const rows = importRows('tools');
    const groups = groupOrder(rows.map((row) => row.group).filter(Boolean));
    const order = (row) => (groups.includes(row.group) ? groups.indexOf(row.group) : groups.length);
    const sorted = rows.map((row, index) => ({ row, index })).sort((a, b) => order(a.row) - order(b.row) || a.index - b.index).map(({ row }) => row);
    // 整组不开放的工具（主代理工具）默认折叠成一行，展开后逐项编辑。
    const folded = groups.filter((group) => !openGroups.has(group) && rows.filter((row) => row.group === group).every((row) => importValue('tools', row).access === 'off'));
    const done = new Set();
    return sorted.map((row) => {
      if (!folded.includes(row.group)) return importRow('tools', row, groups);
      if (done.has(row.group)) return '';
      done.add(row.group);
      const members = rows.filter((item) => item.group === row.group);
      return `<tr class="fold-row"><td><button type="button" class="link" data-act="open-group" data-group="${html(row.group)}">▸ ${html(row.group)}工具</button></td>
        <td class="raw mono" title="${html(members.map((item) => item.key).join(' · '))}">${html(members.map((item) => item.key).join(' · '))}</td><td>${html(row.group)}</td><td class="soft">${members.length} 项 · 不开放</td></tr>`;
    }).join('');
  }
  function importTable(section) {
    const rows = importRows(section);
    const count = section === 'tools' ? `${rows.length} 项` : section === 'skills' ? `${rows.length} 个 · 各工程自带的技能在「角色资源」中按工程提供` : `${rows.length} 个`;
    const cols = section === 'tools' ? '<col><col style="width:30%"><col style="width:124px"><col style="width:220px">' : '<col><col style="width:38%"><col style="width:220px">';
    const head = section === 'tools' ? '<th>显示名</th><th>标识</th><th>分组</th><th>开放方式</th>' : '<th>显示名</th><th>标识</th><th>开放方式</th>';
    const body = section === 'tools' ? toolRows() : rows.map((row) => importRow(section, row, [])).join('');
    return `<article class="role"><div class="role-head simple"><div class="role-name">${SECTIONS[section]}</div><div class="role-does">${count}</div></div><div class="role-body">
      <table class="imp"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></article>`;
  }
  function renderImport() {
    const notes = catalog().diagnostics.map((item) => `<li>${html(item.message)}</li>`).join('');
    const blocked = resourceLoading ? '<div class="cfg-msg">正在读取 Pi 插件与技能目录…</div>' : !catalog().available ? catalogFailure() : notes ? `<ul class="cfg-msg is-warn">${notes}</ul>` : '';
    return `${header('import', '导入范围', '列出本机 Pi 已安装的插件、工具与技能。设为「可选」的在「角色资源」中逐项勾选；设为「默认开启」的无需在角色上逐项勾选，派发时仍按任务再收窄；新安装的项目默认为「不开放」。', Object.keys(drafts.imports).length > 0)}
      ${blocked}<div class="imp-grid">${importTable('extensions')}${importTable('tools')}${importTable('skills')}</div>`;
  }

  // ── 模型档位 ──
  const modelLevels = (model) => drafts.efforts[model] ?? levelsOf(model);
  const noteBase = (model, field) => sel.editable.notes?.[model]?.[field] ?? '';
  const noteValue = (model, field) => drafts.notes[model]?.[field] ?? noteBase(model, field);
  const modelsDirty = () => Object.keys(drafts.efforts).length > 0 || Object.keys(drafts.notes).length > 0;
  // Pi 收到不支持的档位时先向上找最近的支持档，找不到再向下。
  function clampLevel(levels, level) {
    const all = effortLevels();
    const index = all.indexOf(level);
    return all.slice(index + 1).find((item) => levels.includes(item)) ?? all.slice(0, index).reverse().find((item) => levels.includes(item)) ?? 'off';
  }
  function setNote(model, field, value) {
    const entry = { ...(drafts.notes[model] || {}) };
    if (value === noteBase(model, field) && !pages.models.busy) delete entry[field]; else entry[field] = value;
    if (Object.keys(entry).length) drafts.notes[model] = entry; else delete drafts.notes[model];
  }
  function renderModels() {
    const models = sel.catalog.models;
    const pi = sel.pi_catalog;
    const failure = catalogError || pi.error;
    const status = pi.available ? '' : pi.loading || !failure ? '<div class="cfg-msg">正在读取 Pi 模型清单…</div>'
      : `<div class="cfg-msg is-warn">Pi 模型清单读取失败：${html(failure)}<button type="button" class="secondary-button" data-act="retry-catalog">重试</button></div>`;
    const row = (entry) => {
      const { model } = entry;
      const levels = modelLevels(model);
      const bad = (field) => invalid('models', (item) => item.field === `notes."${model}".${field}`);
      const attrs = (field) => `data-model="${html(model)}" data-note="${field}" aria-label="${html(`${model} ${NOTE_TEXT[field]}`)}"${bad(field) ? ' class="is-invalid"' : ''}`;
      const toggles = entry.in_pi === false ? `<span class="soft">${html(levels.join(' / '))}</span>`
        : `<div class="lv">${effortLevels().map((level) => {
          const on = levels.includes(level);
          const blocked = entry.pi_levels && !entry.pi_levels.includes(level) ? ` disabled title="Pi 会改按 ${clampLevel(entry.pi_levels, level)} 运行"` : '';
          return `<button type="button" class="${on ? 'on' : ''}" data-act="level" data-model="${html(model)}" data-v="${level}" aria-pressed="${on}"${blocked}>${level}</button>`;
        }).join('')}</div>`;
      const vision = entry.in_pi && entry.supports_vision !== null ? (entry.supports_vision ? '支持' : '不支持') : '<span class="soft">—</span>';
      const mapped = Object.entries(entry.level_map || {}).map(([level, sent]) => `<div>${html(level)} 实际发送 ${html(sent)}</div>`).join('') || '<span class="soft">—</span>';
      const description = noteValue(model, 'description');
      const invalidRow = invalid('models', (item) => item.field?.startsWith(`notes."${model}".`));
      return `<tr${invalidRow ? ' class="is-invalid"' : ''}><td class="mono model-name">${html(model)}${entry.in_pi === false ? ' <span class="tag">不在 Pi 清单</span>' : ''}</td>
        <td>${toggles}</td><td>${vision}</td><td class="mapped">${mapped}</td>
        <td><input type="text" ${attrs('tag')} value="${html(noteValue(model, 'tag'))}"></td>
        <td><input type="text" ${attrs('effort_note')} value="${html(noteValue(model, 'effort_note'))}"></td>
        <td><details class="desc" data-model="${html(model)}"${openDescriptions.has(model) ? ' open' : ''}><summary>${description ? html(description) : '<span class="soft">未填写</span>'}</summary>
          <textarea rows="5" ${attrs('description')}>${html(description)}</textarea></details></td></tr>`;
    };
    const providers = [...new Set(models.map((entry) => provider(entry.model)))];
    return `${header('models', '模型档位', '勾选各模型可选的档位，「角色与模型」的档位下拉只列出这里勾选的档位；置灰的档位 Pi 不支持。', modelsDirty())}
      ${status}
      <article class="role"><div class="role-body">
      <table class="imp models"><colgroup><col style="width:15%"><col style="width:30%"><col style="width:5%"><col style="width:11%"><col style="width:10%"><col style="width:11%"><col></colgroup>
      <thead><tr><th>模型</th><th>可选档位</th><th>图像</th><th>实际映射</th><th>标签</th><th>备注</th><th>用途说明</th></tr></thead><tbody>
      ${providers.map((name) => `<tr class="prov"><td colspan="7">${html(name)}</td></tr>${models.filter((entry) => provider(entry.model) === name).map(row).join('')}`).join('')}
      </tbody></table></div></article>`;
  }

  // ── 渲染 ──
  const renderers = { picks: renderPicks, res: renderRes, import: renderImport, models: renderModels };
  function focusKey(root) {
    const el = document.activeElement;
    if (!el || !root.contains(el)) return null;
    const keys = ['role', 'i', 'f', 'section', 'key', 'field', 'name', 'act', 'model', 'note', 'v', 'mode'].filter((key) => el.dataset[key] !== undefined);
    return keys.length ? keys.map((key) => `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(el.dataset[key])}"]`).join('') : null;
  }
  function render(page) {
    const root = roots[page];
    const focus = focusKey(root);
    root.classList.toggle('is-busy', pages[page].busy);
    if (!loaded) root.innerHTML = `<div class="cfg-msg${loadError ? ' is-error' : ''}">${html(loadError || '读取中…')}${loadError ? '<button type="button" class="secondary-button" data-act="reload">重新读取</button>' : ''}</div>`;
    else root.innerHTML = renderers[page]();
    if (focus) root.querySelector(focus)?.focus();
  }
  const renderAll = () => Object.keys(roots).forEach(render);

  async function load() {
    loadError = '';
    if (!loaded) renderAll();
    try {
      // 两份数据并发读取；选型配置无效时优先报它的定位错误。
      const [selection, config] = await Promise.allSettled([request('/api/selection'), request('/api/config')]);
      if (selection.status === 'rejected') throw selection.reason;
      if (config.status === 'rejected') throw config.reason;
      sel = selection.value.selection;
      const previousResources = cfg?.resource_catalog;
      cfg = config.value.config;
      cfg.resource_catalog = previousResources || { available: false, error: '', tools: [], extensions: [], skills: [], project_skills: [], required_tools: [], diagnostics: [] };
      for (const role of Object.keys(sel.editable.roles)) if (!drafts.picks[role] || same(drafts.picks[role], sel.editable.roles[role])) drafts.picks[role] = copy(sel.editable.roles[role]);
      loaded = true;
      if (!resourceRequested) resourceLoading = true;
      syncGeneration += 1;
      updateSync(sel.sync_status);
    } catch (error) {
      loadError = `读取失败：${error.body?.error?.details?.message ? describe(error.body.error.details) : error.message}`;
      updateSync(null);
    }
    renderAll();
    if (loaded && !resourceRequested) void refreshResources();
    if (loaded && !sel.pi_catalog.available && !sel.pi_catalog.loading) void refreshCatalog();
  }
  async function refreshResources() {
    if (resourceInFlight) return resourceInFlight;
    resourceRequested = true;
    resourceLoading = true;
    renderAll();
    resourceInFlight = (async () => {
      try {
        cfg.resource_catalog = (await request('/api/config/resources', { timeoutMs: 40000 })).resource_catalog;
      } catch (error) {
        cfg.resource_catalog = { ...cfg.resource_catalog, available: false, error: '无法读取本机 Pi 的插件与技能目录，请确认 Pi 已安装后重试' };
      } finally {
        resourceLoading = false;
        resourceInFlight = null;
        renderAll();
      }
    })();
    return resourceInFlight;
  }
  // 只刷新横幅，不以外部编辑覆盖四页尚未提交的草稿或基线。
  async function refreshSync() {
    if (!loaded || Object.values(pages).some((page) => page.busy) || syncInFlight) return;
    const generation = syncGeneration;
    syncInFlight = request('/api/config').then(({ config }) => {
      if (generation === syncGeneration) updateSync(config.sync_status);
    }).catch(() => { if (generation === syncGeneration) updateSync(null); }).finally(() => { syncInFlight = null; });
    return syncInFlight;
  }
  async function refreshCatalog() {
    catalogError = '';
    try {
      await request('/api/config/catalogs?refresh=1', { timeoutMs: 40000 });
      sel = (await request('/api/selection')).selection;
    } catch (error) { catalogError = error.message; }
    renderAll();
  }
  const draftOf = (page) => ({ picks: drafts.picks, models: { efforts: drafts.efforts, notes: drafts.notes }, res: drafts.res, import: drafts.imports })[page];
  function resetPage(page) {
    if (page === 'picks') drafts.picks = copy(sel.editable.roles);
    if (page === 'models') { drafts.efforts = {}; drafts.notes = {}; }
    if (page === 'res') { drafts.res = {}; for (const role of Object.keys(resResults)) delete resResults[role]; }
    if (page === 'import') drafts.imports = {};
  }
  // 回读后去掉与新基线一致的草稿；保存期间的新编辑（包括改回旧值）保留。推荐行草稿由 load 按角色处理。
  function prune(page, savedRoles = null) {
    if (page === 'models') {
      for (const [model, levels] of Object.entries(drafts.efforts)) if (same(levels, levelsOf(model))) delete drafts.efforts[model];
      for (const [model, entry] of Object.entries(drafts.notes)) {
        for (const [field, value] of Object.entries(entry)) if (value === noteBase(model, field)) delete entry[field];
        if (!Object.keys(entry).length) delete drafts.notes[model];
      }
    }
    if (page === 'import') {
      for (const [section, entries] of Object.entries(drafts.imports)) {
        for (const row of importRows(section)) if (entries[row.key] && same(entries[row.key], importBase(section, row))) delete entries[row.key];
        if (!Object.keys(entries).length) delete drafts.imports[section];
      }
    }
    if (page === 'res') {
      for (const [role, draft] of Object.entries(drafts.res)) {
        if (savedRoles && !savedRoles.includes(role)) continue;
        const rec = record(role);
        for (const field of Object.keys(draft)) if (field !== 'capabilities' && sameSet(draft[field], rec[field] ?? emptyValue(field))) delete draft[field];
        for (const [cap, entry] of Object.entries(draft.capabilities || {})) {
          const saved = rec.capabilities.find((item) => item.id === cap);
          for (const field of Object.keys(entry)) if (sameSet(entry[field], saved?.[field] ?? null)) delete entry[field];
          if (!Object.keys(entry).length) delete draft.capabilities[cap];
        }
        if (draft.capabilities && !Object.keys(draft.capabilities).length) delete draft.capabilities;
        if (!Object.keys(draft).length) delete drafts.res[role];
      }
    }
  }
  async function save(page, send) {
    const state = pages[page];
    const sent = copy(draftOf(page));
    state.busy = true; state.errors = []; state.notice = ''; state.conflict = false;
    render(page);
    try {
      const warnings = await send(sent);
      await load();
      if (same(draftOf(page), sent)) resetPage(page); else prune(page);
      state.notice = warnings.join('；');
      notify(sel.sync_status.length ? '本次配置已保存；运行环境仍有未同步改动' : '已保存，下一次派发生效');
      if (page === 'import') void refreshResources();
    } catch (error) {
      const outcome = error.body?.outcome;
      if (outcome?.state === 'validation_error') state.errors = outcome.errors;
      else if (outcome?.state === 'revision_conflict') { state.notice = '配置已在页面外修改。重新读取后再编辑，当前草稿会被放弃。'; state.conflict = true; }
      else if (error.outcomeUnknown) {
        state.notice = '结果待确认：未收到保存响应，已重新读取，请核对后再操作。';
        await load();
        prune(page);
      } else state.errors = [{ message: `保存失败：${error.body?.error?.message || error.message}` }];
    } finally {
      state.busy = false;
      if (page === 'picks' && state.errors.length) {
        selectedPickRole = state.errors[0].role || selectedPickRole;
        pickDetailsOpen = true;
      }
      renderAll();
    }
    roots[page].querySelector('.is-invalid, .cfg-msg.is-error')?.scrollIntoView({ block: 'center' });
  }
  function savePicks() {
    const errors = checkIds();
    if (errors.length) {
      pages.picks.errors = errors;
      selectedPickRole = errors[0].role;
      pickDetailsOpen = true;
      renderAll();
      return;
    }
    const roles = Object.fromEntries(Object.entries(drafts.picks).filter(([role, picks]) => !same(picks, sel.editable.roles[role])));
    void save('picks', async () => {
      await request('/api/selection', { method: 'PUT', body: JSON.stringify({ draft: { roles: copy(roles) }, expected_revision: sel.revisions }) });
      return [];
    });
  }
  function saveModels() {
    void save('models', async (draft) => {
      await request('/api/selection', { method: 'PUT', body: JSON.stringify({ draft, expected_revision: sel.revisions }) });
      return [];
    });
  }
  // 每个角色是独立事务。失败后只裁掉确认已保存的角色，其他草稿与状态继续留在页面。
  function saveRes() {
    void (async () => {
      const state = pages.res;
      const sent = copy(drafts.res);
      const savedRoles = [];
      state.busy = true; state.errors = []; state.notice = '';
      for (const role of Object.keys(sent)) if (resResults[role] !== 'conflict') resResults[role] = 'unsaved';
      render('res');
      try {
        for (const [role, updates] of Object.entries(sent)) {
          if (resResults[role] === 'conflict') continue;
          try {
            const response = await request(`/api/config/roles/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify({ updates, expected_revision: record(role).revision }) });
            savedRoles.push(role);
            resResults[role] = 'saved';
            const warnings = response.outcome.warnings.map((item) => describe({ ...item, role }));
            if (warnings.length) state.notice = warnings.join('；');
          } catch (error) {
            const outcome = error.body?.outcome;
            if (outcome?.state === 'revision_conflict') {
              resResults[role] = 'conflict';
              state.notice = `${roleName(role)} 的版本已变化；保留草稿并更新版本后可再次保存，或仅重载此角色。`;
            } else if (outcome?.state === 'validation_error') {
              state.errors = outcome.errors.map((item) => ({ ...item, role }));
            } else if (error.body?.error) {
              state.errors = [{ role, field: error.body.error.details?.location, message: error.body.error.message }];
            } else if (error.outcomeUnknown) {
              state.notice = `${roleName(role)} 的保存结果待确认；请核对后再操作。`;
            } else state.errors = [{ role, message: `保存失败：${error.message}` }];
            break;
          }
        }
        if (savedRoles.length) {
          await load();
          prune('res', savedRoles);
          for (const role of savedRoles) if (drafts.res[role]) resResults[role] = 'unsaved';
        }
        if (savedRoles.length && Object.keys(drafts.res).length === 0) state.notice ||= '已保存';
      } finally {
        state.busy = false;
        renderAll();
        if (savedRoles.length) notify(Object.keys(drafts.res).length
          ? `部分角色已保存；其余草稿待处理${sel.sync_status.length ? '，运行环境仍有未同步改动' : ''}`
          : sel.sync_status.length ? '本次角色已保存；运行环境仍有未同步改动' : '已保存，下一次派发生效');
      }
    })();
  }
  // 冲突角色单独换基线：恢复保留原草稿，重载只放弃该角色草稿。
  async function resolveRole(role, discard) {
    const state = pages.res;
    state.busy = true;
    render('res');
    try {
      const latest = (await request('/api/config')).config;
      const fresh = latest.roles.find((item) => item.role === role);
      if (!fresh) throw new Error('角色已不存在');
      cfg.roles = cfg.roles.map((item) => item.role === role ? fresh : item);
      syncGeneration += 1;
      updateSync(latest.sync_status);
      if (discard) delete drafts.res[role];
      if (discard) delete resResults[role]; else resResults[role] = 'unsaved';
      state.notice = discard ? `${roleName(role)} 已重载；其它角色草稿未变。` : `${roleName(role)} 的草稿已保留，点击保存重试。`;
    } catch (error) { state.errors = [{ role, message: `读取失败：${error.message}` }]; }
    finally { state.busy = false; renderAll(); }
  }
  function saveImports() {
    // 运行必需的工具只提交显示名。
    const updates = Object.fromEntries(Object.entries(drafts.imports).map(([section, entries]) => [section, Object.fromEntries(Object.entries(entries)
      .map(([key, value]) => [key, section === 'tools' && catalog().required_tools.includes(key) ? { label: value.label } : value]))]));
    void save('import', async () => {
      await request('/api/config/imports', { method: 'PUT', body: JSON.stringify({ updates, expected_revision: cfg.imports_revision }) });
      return [];
    });
  }
  const savers = { picks: savePicks, res: saveRes, import: saveImports, models: saveModels };

  function onClick(page, event) {
    const target = event.target.closest('[data-act]');
    if (!target || target.disabled || pages[page].busy) return;
    const act = target.dataset.act;
    if (act === 'pick-role') { selectedPickRole = target.dataset.role; pickDetailsOpen = false; render(page); return; }
    if (act === 'save') { savers[page](); return; }
    if (act === 'reload' && (page === 'res' || page === 'import') && !catalog().available) { void refreshResources(); return; }
    // 主动重新读取丢弃本页草稿，由 load() 按新读到的配置重建。
    if (act === 'reload') { if (page === 'picks') drafts.picks = {}; else resetPage(page); pages[page] = { busy: false, errors: [], notice: '' }; void load(); return; }
    if (act === 'recover-role' || act === 'reload-role') { void resolveRole(target.dataset.role, act === 'reload-role'); return; }
    if (act === 'retry-catalog') { void refreshCatalog(); return; }
    if (act === 'discard') { resetPage(page); pages[page].errors = []; }
    if (act === 'fold') {
      if (event.target.closest('input, select, button')) return;
      const role = target.closest('[data-card]').dataset.card;
      if (expanded.has(role)) expanded.delete(role); else expanded.add(role);
    }
    const row = target.closest('tr[data-i]');
    if (row) {
      const picks = drafts.picks[row.dataset.role];
      const index = Number(row.dataset.i);
      if (act === 'up' || act === 'down') {
        const other = index + (act === 'up' ? -1 : 1);
        [picks[index], picks[other]] = [picks[other], picks[index]];
      }
      if (act === 'delete') picks.splice(index, 1);
      if (act === 'default') picks.forEach((pick) => { if ((pick.capability || '') === (picks[index].capability || '')) { if (pick === picks[index]) pick.default = true; else delete pick.default; } });
    }
    if (act === 'add') {
      const picks = drafts.picks[target.dataset.role];
      const base = picks.find((pick) => pick.default && !pick.capability) || picks[0];
      picks.push({ id: '', model: base.model, effort: base.effort, effort_min: base.effort_min, effort_max: base.effort_max });
      render(page);
      roots.picks.querySelector(`tr[data-role="${CSS.escape(target.dataset.role)}"][data-i="${picks.length - 1}"] [data-f="id"]`).focus();
      return;
    }
    if (act === 'access') {
      const row = importRows(target.dataset.section).find((item) => item.key === target.dataset.key);
      setImport(target.dataset.section, row, { access: target.dataset.v });
    }
    if (act === 'open-group') openGroups.add(target.dataset.group);
    if (act === 'cap') narrowing.set(target.dataset.role, narrowing.get(target.dataset.role) === target.dataset.cap ? '' : target.dataset.cap);
    if (act === 'cap-reset') for (const field of ['tools', 'extensions', 'skills', 'project_skills']) setCapValue(record(target.dataset.role), target.dataset.cap, field, null);
    if (act === 'level') {
      const { model, v } = target.dataset;
      const current = modelLevels(model);
      const next = effortLevels().filter((level) => (level === v ? !current.includes(v) : current.includes(level)));
      if (!next.length) return;
      if (same(next, levelsOf(model)) && !pages.models.busy) delete drafts.efforts[model]; else drafts.efforts[model] = next;
    }
    if (page === 'res' && target.dataset.role && resResults[target.dataset.role] === 'saved') resResults[target.dataset.role] = 'unsaved';
    if (!['fold', 'open-group', 'cap'].includes(act)) pages[page].errors = [];
    render(page);
  }
  function onChange(page, event) {
    const target = event.target;
    const data = target.dataset;
    if (page === 'picks' && data.f) editPick(data.role, Number(data.i), data.f, target.value.trim());
    if (page === 'res' && (data.mode || data.field)) {
      const rec = record(data.role);
      const set = data.cap ? (field, value) => narrowTo(rec, data.cap, field, value) : (field, value) => setRoleValue(rec, field, value);
      if (data.mode) {
        const current = levelValue(rec, data.cap, 'project_skills');
        const role = roleValue(rec, 'project_skills');
        set('project_skills', data.mode !== 'list' ? data.mode : Array.isArray(current) ? current : data.cap && Array.isArray(role) ? role : []);
      } else {
        const list = levelValue(rec, data.cap, data.field).filter((name) => name !== data.name);
        set(data.field, target.checked ? [...list, data.name] : list);
      }
    }
    if (page === 'models' && data.note) setNote(data.model, data.note, target.value.trim());
    if (page === 'import' && data.f) setImport(data.section, importRows(data.section).find((row) => row.key === data.key), { [data.f]: target.value.trim() });
    if (page === 'res' && data.role && resResults[data.role] === 'saved') resResults[data.role] = 'unsaved';
    pages[page].errors = [];
    render(page);
  }
  // 拖动排序：按住行首把手才让整行可拖，避免输入框里选字被当成拖动。
  function onDrag(event) {
    const row = event.target.closest?.('tr[data-i]');
    if (event.type === 'mousedown') { if (event.target.closest('.grip')) row.draggable = true; return; }
    if (event.type === 'mouseup') { roots.picks.querySelectorAll('tr[draggable="true"]').forEach((tr) => { tr.draggable = false; }); return; }
    if (event.type === 'dragstart') { dragging = { role: row.dataset.role, from: Number(row.dataset.i) }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ''); return; }
    if (event.type === 'dragover') { if (dragging && row?.dataset.role === dragging.role) event.preventDefault(); return; }
    if (event.type === 'drop' && dragging && row?.dataset.role === dragging.role) {
      event.preventDefault();
      const picks = drafts.picks[dragging.role];
      picks.splice(Number(row.dataset.i), 0, picks.splice(dragging.from, 1)[0]);
    }
    dragging = null;
    render('picks');
  }

  for (const [page, root] of Object.entries(roots)) {
    root.addEventListener('click', (event) => onClick(page, event));
    root.addEventListener('change', (event) => onChange(page, event));
  }
  roots.picks.addEventListener('toggle', (event) => {
    if (event.target.matches?.('.pick-details')) pickDetailsOpen = event.target.open;
  }, true);
  roots.models.addEventListener('toggle', (event) => {
    if (!event.target.matches?.('.desc')) return;
    if (event.target.open) openDescriptions.add(event.target.dataset.model); else openDescriptions.delete(event.target.dataset.model);
  }, true);
  for (const type of ['mousedown', 'mouseup', 'dragstart', 'dragover', 'drop', 'dragend']) roots.picks.addEventListener(type, onDrag);

  // 同步详情里的受管文件用界面名称显示。
  function fileLabel(file) {
    const role = /^ops\/agents\/(.+)\.toml$/.exec(file)?.[1];
    if (role) return `角色配置：${roleName(role)}`;
    return { 'ops/model-notes.toml': '模型档位', 'ops/templates/worker-resources.json': '导入范围' }[file] || file;
  }

  return { load: () => (loaded ? refreshSync() : load()), refreshSync, fileLabel };
}
