// The team may browse independently. Only explicit room commands affect players.
import { api, esc as escapeHTML, toast } from "./common.js";

const typeNames = { rating: "评分", choice: "单选", text: "开放文本" };

function labelForTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false
  }).format(date);
}

function byId(items, id) {
  return items.find(item => String(item.id) === String(id));
}

function setMarkup(element, html) {
  if (element && element._rendered !== html) {
    element.innerHTML = html;
    element._rendered = html;
  }
}

function option(value, label, current) {
  return `<option value="${escapeHTML(value)}"${String(value) === String(current) ? " selected" : ""}>${escapeHTML(label)}</option>`;
}

function actionButton(action, text, { value = "", style = "secondary", disabled = false } = {}) {
  return `<button type="button" class="btn ${style}" data-action="${action}" data-value="${escapeHTML(value)}"${disabled ? " disabled" : ""}>${escapeHTML(text)}</button>`;
}

async function copyValue(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Ordinary LAN HTTP and restricted browser policies need the selection fallback.
    }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  return copied;
}

function createDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "panel admin-dialog";
  dialog.setAttribute("aria-labelledby", "dialog-heading");
  document.body.append(dialog);
  const onClose = () => {
    dialog.replaceChildren();
    delete dialog.dataset.kind;
  };
  dialog.addEventListener("close", onClose);
  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-close]")) dialog.close();
  });
  return dialog;
}

function showDialog(dialog, kind, title, content) {
  dialog.dataset.kind = kind;
  dialog.innerHTML = `<div class="section-head"><h2 id="dialog-heading">${escapeHTML(title)}</h2>
    <button type="button" class="btn secondary" data-close aria-label="关闭">关闭</button></div>
    <div class="dialog-content">${content}</div><p class="error" data-dialog-error role="alert" hidden></p>`;
  if (!dialog.open) dialog.showModal();
}

const key = location.hash.slice(1);
const state = {
  room: null, tab: "overview", form: null, interview: null, qid: null, targets: null, previewDirty: false,
  detail: null, detailPlayer: null, detailRequest: 0,
  editor: null, busy: false, qr: new Map(), qrEpoch: 0, reading: 0
};
const $ = selector => document.querySelector(selector);
const adminRead = path => api(path, undefined, key);
const post = body => api("/api/manage/action", body, key);
let dialog;

function playerLink(player) {
  return new URL("/play#" + encodeURIComponent(player.code), state.room.base).href;
}
function currentForm() {
  return byId(state.room.forms, state.form) || state.room.forms[0];
}
function questions() {
  return state.room.forms.flatMap(form => form.questions.map(question => ({ ...question, form })));
}
function completeCount(form) {
  return state.room.players.filter(player => player.submitted.includes(form.id)).length;
}
function statusBadge(text, good = false) {
  return `<span class="badge${good ? " good" : ""}">${escapeHTML(text)}</span>`;
}
function formatAnswer(value, type) {
  if (value == null || value === "") return "未填写";
  return type === "rating" ? `${value} 分` : value;
}

async function loadRoom() {
  const sequence = ++state.reading;
  const room = await adminRead("/api/manage");
  if (!Array.isArray(room.interviews)) {
    throw new Error("后台服务需要更新。请在主机重启新版 Fieldroom，再重新连接。");
  }
  if (sequence !== state.reading || (state.room && room.rev < state.room.rev)) return;
  if (state.room?.id !== room.id) {
    try { state.interview = sessionStorage.getItem("fieldroom.host.group." + room.id); }
    catch { state.interview = null; }
  }
  state.room = room;
  if (!state.previewDirty) synchronizePreview();
  if (!state.form) state.form = room.forms[0]?.id;
  render();
  if (dialog.open && dialog.dataset.kind === "detail") await loadDetail(state.detailPlayer);
}

function shell() {
  $("#app").innerHTML = `<div class="wrap admin-wrap">
    <section class="admin-heading"><div><a class="workbench-link no-print" href="/">场次工作台</a><h1 id="room-title"></h1></div>
      <div class="row no-print" id="room-actions"></div></section>
    <nav class="tabs no-print" aria-label="场次管理" id="admin-nav"></nav>
    <div id="admin-view"></div></div>`;
  $("#app").addEventListener("click", dispatchClick);
  $("#app").addEventListener("change", dispatchChange);
  dialog = createDialog();
  dialog.addEventListener("click", dispatchClick);
  dialog.addEventListener("change", dispatchChange);
  dialog.addEventListener("submit", event => {
    event.preventDefault();
    if (state.busy) return;
    const form = event.target;
    if (form.id === "form-editor") runAction(saveForm);
    if (form.id === "supplement-form") runAction(saveSupplement);
  });
}

const sections = [
  ["overview", "场次概览"], ["forms", "问卷编排"], ["interview", "访谈控制"], ["cards", "玩家卡"]
];
function render() {
  const room = state.room;
  $("#room-title").textContent = room.title;
  setMarkup($("#room-actions"), actionButton("share-admin", "复制管理链接") +
    actionButton(room.sealed ? "reopen" : "seal", room.sealed ? "重新开放场次" : "封存场次", {disabled: !room.sealed && room.interviews.length > 0}));
  setMarkup($("#admin-nav"), sections.map(([id, label]) =>
    `<button type="button" class="tab${state.tab === id ? " active" : ""}" data-action="tab" data-value="${id}" aria-current="${state.tab === id ? "page" : "false"}">${label}</button>`).join(""));
  if (state.tab === "cards" && $("#cards-grid")) return;
  const views = {overview: overviewView, forms: formsView, interview: interviewView, cards: cardsView};
  setMarkup($("#admin-view"), views[state.tab]());
  if (state.tab === "cards") fillQRCodes();
}

function overviewView() {
  const {players, forms, sealed, interviews} = state.room;
  const cards = forms.map((form, i) => {
    const count = completeCount(form);
    return `<article class="card progress-card">
      <div class="section-head"><span class="eyebrow">问卷 ${String(i + 1).padStart(2, "0")}</span>
      ${statusBadge(form.open ? "已开放" : "待开放", form.open)}</div>
      <h3>${escapeHTML(form.title)}</h3>
      <div class="progress-text"><b>${count}</b><span>/ ${players.length} 人已交</span></div>
      <progress value="${count}" max="${players.length}" aria-label="${escapeHTML(form.title)}交卷进度"></progress></article>`;
  }).join("");
  const rows = players.map(player => `<tr><th scope="row">${escapeHTML(player.name)}</th>
    ${forms.map(form => `<td>${player.submitted.includes(form.id) ? statusBadge("已交",true) : (form.open ? "未交" : "待开放")}</td>`).join("")}
    <td>${actionButton("detail", "查看记录", {value: player.id})}</td></tr>`).join("");
  return `<section class="stack"><div class="section-head"><h2>交卷进度</h2>
    ${statusBadge(sealed ? "场次已封存" : interviews.length ? `${interviews.length} 组访谈进行中` : "场次进行中", !sealed)}</div>
    <div class="progress-grid">${cards}</div></section>
    <section class="panel admin-section"><div class="section-head"><h2>玩家记录</h2><span class="muted">共 ${players.length} 人</span></div>
    <div class="table-wrap"><table><thead><tr><th>玩家</th>${forms.map(form => `<th>${escapeHTML(form.title)}</th>`).join("")}<th>记录</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}
function formsView() {
  const {forms, players, sealed} = state.room;
  const form = currentForm();
  if (!form) return "";
  const next = forms.find(item => !item.open);
  const nav = forms.map((item, i) => `<button type="button" class="form-nav ${item.id === form.id ? "selected" : ""}"
    data-action="pick-form" data-value="${escapeHTML(item.id)}"><span class="eyebrow">问卷 ${String(i + 1).padStart(2, "0")}</span>
    <strong>${escapeHTML(item.title)}</strong><small>${item.open ? `${completeCount(item)} / ${players.length} 人已交` : "待开放"}</small></button>`).join("");
  const list = form.questions.map((q, i) => `<li class="question-row"><span class="question-number">${String(i + 1).padStart(2, "0")}</span>
    <div><div class="question-meta">${escapeHTML(typeNames[q.type])} · ${q.required ? "必答" : "选答"}</div>
    <strong>${escapeHTML(q.label)}</strong>${q.type === "choice" ? `<p class="muted">${q.options.map(escapeHTML).join("　/　")}</p>` : ""}</div></li>`).join("");
  return `<div class="form-layout"><aside class="form-sidebar" aria-label="选择问卷">${nav}</aside>
    <section class="panel"><div class="section-head"><div><p class="eyebrow">${form.questions.length} 道题</p><h2>${escapeHTML(form.title)}</h2></div>
    <div class="row">${actionButton("edit-form", "编辑问卷", {value:form.id,disabled:sealed})}
    ${form.id === next?.id && !sealed ? actionButton("open", "开放问卷", {value:form.id,style:"primary"}) : ""}</div></div>
    <ol class="question-list">${list}</ol></section></div>`;
}
function activeInterview() {
  return state.room.interviews.find(item => item.id === state.interview);
}
function otherInterviewMembers() {
  const taken = new Set();
  for (const group of state.room.interviews) {
    if (group.id !== state.interview) group.players.forEach(id => taken.add(id));
  }
  return taken;
}
function synchronizePreview() {
  const group = activeInterview();
  if (group) {
    state.targets = new Set(group.players);
    state.qid = group.qid;
  } else if (!state.interview) {
    const taken = otherInterviewMembers();
    const free = state.room.players.filter(p => !taken.has(p.id));
    state.targets = new Set(free.slice(0,6).map(p => p.id));
    const open = state.room.forms.filter(f => f.open);
    if (!open.some(f => byId(f.questions,state.qid))) state.qid = open[0]?.questions[0]?.id;
  }
  // Keep a remotely ended selection pinned until its host chooses another group.
}
function rememberInterview(id) {
  state.interview = id;
  const storageKey = "fieldroom.host.group." + state.room.id;
  try {
    if (id) sessionStorage.setItem(storageKey,id);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The selection still works for this page when browser storage is unavailable.
  }
}
function selectInterview(id) {
  rememberInterview(id);
  state.previewDirty = false;
  state.qid = null;
  synchronizePreview();
  render();
}
function groupDirectory(questionSet) {
  const {room} = state;
  const names = new Map(room.players.map(p => [p.id,p.name]));
  const labels = new Map(questionSet.map(q => [q.id,q.label]));
  const groups = room.interviews.map(group => {
    const selected = group.id === state.interview;
    return `<button type="button" class="group-pick${selected ? " selected" : ""}" data-action="pick-interview"
      data-value="${escapeHTML(group.id)}" aria-pressed="${selected}"><strong>${escapeHTML(group.players.map(id => names.get(id)).join("、"))}</strong>
      <small>正在展示 · ${escapeHTML(labels.get(group.qid) || "已调整的题目")}</small></button>`;
  }).join("");
  return `<section class="panel group-directory"><div class="section-head">
    <h2>进行中的访谈 <span class="group-count">${room.interviews.length}</span></h2>
    ${actionButton("new-interview","新建访谈",{disabled:room.sealed})}</div>
    ${groups ? `<div class="group-grid">${groups}</div>` : ""}</section>`;
}
function interviewView() {
  const {room, targets} = state;
  const all = questions();
  const group = activeInterview();
  const directory = groupDirectory(all);
  if (state.interview && !group) {
    return directory + '<section class="panel admin-section"><h2>所选访谈已结束</h2><p class="muted">可以选择进行中的访谈，或新建访谈。</p></section>';
  }
  const available = all.filter(q => q.form.open);
  const question = byId(available, state.qid);
  const otherMembers = otherInterviewMembers();
  const selected = room.players.filter(p => targets.has(p.id));
  const conflicts = selected.filter(p => otherMembers.has(p.id));
  const missing = question ? selected.filter(p => !p.submitted.includes(question.form.id)) : [];
  const progress = selected.length ? `${selected.length - missing.length}/${selected.length} 人已交卷` : "请选择受访者";
  const liveQuestion = byId(all, group?.qid);
  const caption = group ? `正在展示 · ${liveQuestion?.label || "已调整的题目"}` : "新访谈";
  const pickers = room.players.map(p => {
    const occupied = otherMembers.has(p.id);
    const checked = targets.has(p.id);
    return `<label class="target-chip${checked ? " selected" : ""}${occupied ? " occupied" : ""}"><input type="checkbox" name="target"
      value="${escapeHTML(p.id)}"${checked ? " checked" : ""}${occupied || room.sealed ? " disabled" : ""}>${escapeHTML(p.name)}${occupied ? " · 在其他组" : ""}</label>`;
  }).join("");
  const options = room.forms.filter(f => f.open).map(f =>
    `<optgroup label="${escapeHTML(f.title)}">${f.questions.map(q => option(q.id,q.label,state.qid)).join("")}</optgroup>`).join("");
  const unavailable = room.sealed || !question || !selected.length || selected.length > 6 || conflicts.length > 0;
  return directory + `<section class="panel admin-section interview-control"><div class="section-head"><h2>${escapeHTML(caption)}</h2>
    ${group ? actionButton("end","结束访谈") : ""}</div>
    <div class="control-group"><h3>受访者</h3><div class="row target-list">${pickers}</div></div>
    ${conflicts.length ? `<div class="row"><small>所选玩家中有人已加入其他组。</small>${actionButton("remove-occupied","移除已占用的选择")}</div>` : ""}
    <label class="field">访谈题目<select id="preview-question"${room.sealed || !options ? " disabled" : ""}>
    ${question ? "" : `<option value="" selected>${options ? "请选择题目" : "请先开放一份问卷"}</option>`}${options}</select></label>
    <div class="preview-line"><div><strong>${escapeHTML(progress)}</strong>
    ${missing.length ? `<small>未交卷 · ${escapeHTML(missing.map(p=>p.name).join("、"))}</small>` : ""}</div>
    ${actionButton("show","向受访者展示",{style:"primary",disabled:unavailable})}</div>
    ${selected.length > 6 ? '<p class="muted">每次访谈最多选择六位玩家。</p>' : ""}</section>
    ${group ? supplementList(group) : ""}`;
}
function supplementList(group) {
  const {room} = state;
  return `<section class="panel admin-section"><div class="section-head"><h2>访谈补充</h2></div>
    ${room.players.filter(p => group.players.includes(p.id)).map(p => `<div class="list-row"><strong>${escapeHTML(p.name)}</strong>
    <div class="row">${actionButton("detail","查看记录",{value:p.id})}
    ${actionButton("supplement","追加记录",{value:p.id,disabled:room.sealed})}</div></div>`).join("")}</section>`;
}
async function showInterview() {
  const response = await post({op:"show",interview:state.interview,qid:state.qid,players:[...state.targets]});
  rememberInterview(response.interview);
  state.previewDirty = false;
  await loadRoom();
  toast("已向受访者展示");
}
async function endInterview() {
  await post({op:"end",interview:state.interview});
  rememberInterview(null);
  state.previewDirty = false;
  await loadRoom();
  toast("访谈已结束，玩家可继续填写");
}
function cardsView() {
  return `<section class="stack"><div class="section-head no-print"><h2>玩家入场卡</h2>${actionButton("print","打印玩家卡")}</div>
    <p class="muted no-print">让玩家连接场内 Wi-Fi，扫描自己的卡。换机时重新扫码。</p>
    <div id="cards-grid" class="player-cards">${state.room.players.map(p => `<article class="card player-card">
    <p class="eyebrow">${escapeHTML(state.room.title)}</p><h3>${escapeHTML(p.name)}</h3>
    <div class="card-qr" data-qr-for="${escapeHTML(p.id)}" aria-label="${escapeHTML(p.name)}的二维码">二维码生成中…</div>
    <div class="no-print">${actionButton("copy-player", "复制玩家链接", {value:p.id})}</div></article>`).join("")}</div></section>`;
}
async function fillQRCodes() {
  const epoch = ++state.qrEpoch;
  for (const player of state.room.players) {
    if (state.tab !== "cards" || epoch !== state.qrEpoch) break;
    const node = document.querySelector(`[data-qr-for="${CSS.escape(player.id)}"]`);
    if (!node) continue;
    try {
      let src = state.qr.get(player.id);
      if (!src) {
        const {svg} = await api("/api/manage/qr", {player:player.id}, key);
        src = URL.createObjectURL(new Blob([svg], {type:"image/svg+xml"}));
        state.qr.set(player.id,src);
      }
      const img = new Image();
      img.alt = player.name + "入场二维码";
      img.src = src;
      node.replaceChildren(img);
    } catch {
      setMarkup(node, actionButton("retry-qr","重新生成二维码"));
    }
  }
}
function startEditing(id) {
  const form = byId(state.room.forms, id);
  state.editor = {
    id: form.id, title: form.title, version: form.version,
    questions: form.questions.map(q => ({...q, options:[...q.options]}))
  };
  drawEditor();
}
function editorRow(q, index, length) {
  return `<fieldset class="editor-row" data-index="${index}">
    <legend>第 ${index + 1} 题</legend>
    <label class="field">题目<input name="label" required maxlength="500" value="${escapeHTML(q.label)}"></label>
    <div class="editor-tools"><label class="field">题型<select name="type">
    ${Object.entries(typeNames).map(([id,label]) => option(id,label,q.type)).join("")}</select></label>
    <label class="inline-check"><input type="checkbox" name="required"${q.required ? " checked" : ""}>必答</label></div>
    ${q.type === "choice" ? `<label class="field">选项（每行一项）<textarea name="options" required rows="3">${escapeHTML(q.options.join("\n"))}</textarea></label>` : ""}
    <div class="row row-actions">${actionButton("up","上移",{value:index,disabled:index===0})}
    ${actionButton("down","下移",{value:index,disabled:index===length-1})}
    ${actionButton("delete-q","移除",{value:index,disabled:length===1})}</div></fieldset>`;
}
function drawEditor() {
  const {editor} = state;
  const content = `<form id="form-editor" class="stack">
    <label class="field">问卷名称<input name="title" required maxlength="100" value="${escapeHTML(editor.title)}"></label>
    <div class="stack">${editor.questions.map((q,i,all)=>editorRow(q,i,all.length)).join("")}</div>
    <div class="section-head">${actionButton("add-q","添加题目")}
    <button type="submit" class="btn primary">保存问卷</button></div></form>`;
  showDialog(dialog,"edit","编辑问卷",content);
}
function captureEditor() {
  const form = $("#form-editor");
  state.editor.title = form.elements.title.value;
  for (const field of form.querySelectorAll(".editor-row")) {
    const q = state.editor.questions[Number(field.dataset.index)];
    q.label = field.querySelector("[name=label]").value;
    q.type = field.querySelector("[name=type]").value;
    q.required = field.querySelector("[name=required]").checked;
    const options = field.querySelector("[name=options]");
    if (options) q.options = options.value.split(/\r?\n/);
  }
}
function editQuestion(action,index) {
  captureEditor();
  const items = state.editor.questions;
  if (action === "add-q") items.push({type:"text",label:"",required:true,options:[]});
  if (action === "delete-q" && items.length > 1) items.splice(index,1);
  if (action === "up" && index > 0) [items[index],items[index-1]] = [items[index-1],items[index]];
  if (action === "down" && index < items.length-1) [items[index],items[index+1]] = [items[index+1],items[index]];
  const scroll = dialog.scrollTop;
  drawEditor();
  dialog.scrollTop = scroll;
  if (action === "add-q") dialog.querySelector(".editor-row:last-child [name=label]").focus();
}

async function saveForm() {
  captureEditor();
  const editor = state.editor;
  const cleaned = editor.questions.map(q => {
    const opts = q.type === "choice" ? q.options.map(s=>s.trim()).filter(Boolean) : [];
    if (q.type === "choice" && (opts.length < 2 || new Set(opts).size !== opts.length)) {
      throw new Error("每道单选题至少需要两个不同选项，请检查重复项。");
    }
    return {...(q.id ? {id:q.id} : {}),label:q.label.trim(),type:q.type,required:q.required,options:opts};
  });
  await post({op:"form",form:editor.id,title:editor.title.trim(),questions:cleaned,expectedVersion:editor.version});
  dialog.close();
  await loadRoom();
  toast("问卷已保存");
}
async function loadDetail(playerId) {
  const ticket = ++state.detailRequest;
  const record = await adminRead("/api/manage/player?id=" + encodeURIComponent(playerId));
  if (ticket !== state.detailRequest || dialog.dataset.kind !== "detail" || !dialog.open) return;
  const previous = state.detail;
  const ids = new Set(record.history.map(item => item.id));
  if (previous?.expandedPages && ids.has(previous.history[0]?.id)) {
    record.history.push(...previous.history.filter(old => !ids.has(old.id)));
    record.nextHistory = previous.nextHistory;
    record.expandedPages = true;
  }
  state.detail = record;
  paintDetail();
}
function paintDetail() {
  const content = dialog.querySelector(".dialog-content");
  const expandedHistory = content.querySelector("details.history")?.open || false;
  setMarkup(content, detailView(state.detail));
  const history = content.querySelector("details.history");
  if (history && expandedHistory) history.open = true;
}
async function moreHistory() {
  const {detail, detailPlayer} = state;
  if (!detail?.nextHistory) return;
  const query = new URLSearchParams({id:detailPlayer, beforeHistory:String(detail.nextHistory)});
  const page = await adminRead("/api/manage/player?" + query);
  if (!dialog.open || dialog.dataset.kind !== "detail" || state.detailPlayer !== detailPlayer) return;
  const ids = new Set(state.detail.history.map(item => item.id));
  state.detail.history.push(...page.history.filter(item => !ids.has(item.id)));
  state.detail.expandedPages = true;
  state.detail.nextHistory = page.nextHistory;
  paintDetail();
}
function historyRow(entry) {
  const q = entry.question || {};
  const context = [q.formTitle, q.formVersion && "第 " + q.formVersion + " 版", labelForTime(entry.at)].filter(Boolean);
  const choices = q.type === "choice" && q.options?.length ? `<small>当时选项 · ${q.options.map(escapeHTML).join(" / ")}</small>` : "";
  return `<li><small>${escapeHTML(context.join(" · "))}</small><div>${escapeHTML(entry.label)}</div>
    <b>${escapeHTML(formatAnswer(entry.value, q.type))}</b>${choices}</li>`;
}
function detailView(detail) {
  const {forms} = state.room;
  const answers = forms.map(form => {
    if (!detail.submitted.includes(form.id)) return `<div class="list-row"><h3>${escapeHTML(form.title)}</h3>${statusBadge(form.open ? "未交卷" : "待开放")}</div>`;
    const originals = (detail.snapshots || []).filter(snap => snap.form === form.id);
    const ordered = new Map(originals.map(snap => [snap.qid, snap]));
    const current = new Set(form.questions.map(q => q.id));
    const display = form.questions.map(q => ordered.get(q.id) || {...q,value:detail.answers[q.id]});
    display.push(...originals.filter(snap => !current.has(snap.qid)));
    const rows = display.map(q => `<div class="answer-row"><span>${escapeHTML(q.label)}
      ${q.formVersion && q.formVersion !== form.version ? `<small>作答时版本 · ${escapeHTML(q.formVersion)}</small>` : ""}</span>
      <strong>${escapeHTML(formatAnswer(q.value, q.type))}</strong></div>`).join("");
    return `<section class="record-form"><div class="section-head"><h3>${escapeHTML(form.title)}</h3>${statusBadge("已交卷",true)}</div>${rows}</section>`;
  }).join("");
  const notes = detail.notes.filter(note => note.text.trim()).map(note =>
    `<div class="record-entry">${statusBadge(note.submitted ? "已提交" : "草稿",note.submitted)}<p>${escapeHTML(note.text)}</p></div>`).join("");
  const all = questions();
  const supp = detail.supplements.map(entry =>
    `<div class="record-entry"><small>${escapeHTML(entry.label || byId(all,entry.qid)?.label || "原题")} · ${escapeHTML(labelForTime(entry.at))}</small>
    ${entry.score ? `<strong>访谈评分 · ${escapeHTML(entry.score)} 分</strong>` : ""}<p>${escapeHTML(entry.reason)}</p></div>`).join("");
  const history = detail.history.map(historyRow).join("");
  return `<div class="stack">${answers}
    ${notes ? `<section><h3>体验问题</h3>${notes}</section>` : ""}
    ${supp ? `<section><h3>访谈补充</h3>${supp}</section>` : ""}
    ${history ? `<details class="history"><summary>作答历史</summary><ol>${history}</ol>${detail.nextHistory ? actionButton("more-history","查看更早记录") : ""}</details>` : ""}</div>`;
}
async function showDetail(id) {
  state.detailPlayer = id;
  state.detail = null;
  const name = byId(state.room.players,id).name;
  showDialog(dialog,"detail",name + "的记录","<p>正在读取…</p>");
  await loadDetail(id);
}
async function showSupplement(id) {
  const live = activeInterview();
  const question = byId(questions(), live?.qid);
  if (!question || !live.players.includes(id)) throw new Error("访谈题目已更改，请重新选择玩家。");
  const p = byId(state.room.players, id);
  const details = await adminRead("/api/manage/player?id=" + encodeURIComponent(id));
  const submitted = details.submitted.includes(question.form.id);
  const snapshot = details.snapshots?.find(answer => answer.qid === question.id);
  const original = submitted ? formatAnswer(details.answers[question.id], snapshot?.type || question.type) : "暂无已提交答案";
  const score = question.type === "rating" ? `<label class="field">访谈评分<select name="score">
    <option value="">仅记录解释</option>${[1,2,3,4,5].map(v=>option(v,v + " 分","")).join("")}</select></label>` : "";
  showDialog(dialog,"supplement",p.name + " · 访谈补充",`<form class="stack" id="supplement-form" data-interview="${escapeHTML(live.id)}" data-player="${escapeHTML(id)}" data-qid="${escapeHTML(question.id)}">
    <div><h3>${escapeHTML(snapshot?.label || question.label)}</h3><p class="muted">答卷记录 · ${escapeHTML(original)}</p></div>
    ${score}<label class="field">原因或口头回答<textarea name="reason" required rows="3"></textarea></label>
    <div class="row"><button type="submit" class="btn primary">保存补充</button></div></form>`);
}
async function saveSupplement() {
  const form = $("#supplement-form");
  const reason = form.elements.reason.value.trim();
  if (!reason) throw new Error("请填写原因或口头回答。");
  await post({op:"supplement",interview:form.dataset.interview,player:form.dataset.player,qid:form.dataset.qid,score:form.elements.score?.value || "",reason});
  dialog.close();
  await loadRoom();
  toast("访谈补充已保存");
}
async function share(value) {
  if (await copyValue(value)) { toast("链接已复制"); return; }
  showDialog(dialog,"share","复制链接",`<input aria-label="待复制链接" readonly value="${escapeHTML(value)}">`);
  dialog.querySelector("input").select();
}

function presentError(error) {
  if (dialog?.open) {
    const alert = dialog.querySelector("[data-dialog-error]");
    alert.textContent = error.message;
    alert.hidden = false;
    alert.scrollIntoView({block:"nearest"});
  } else {
    toast(error.message || "操作失败，请重试");
  }
}
async function runAction(action) {
  if (state.busy) return;
  state.busy = true;
  try { await action(); }
  catch (error) { presentError(error); }
  finally { state.busy = false; }
}
function dispatchChange(event) {
  if (event.target.matches("[name=target]")) {
    state.previewDirty = true;
    if (event.target.checked) state.targets.add(event.target.value);
    else state.targets.delete(event.target.value);
    render();
  } else if (event.target.matches("#preview-question")) {
    state.previewDirty = true;
    state.qid = event.target.value;
    render();
  } else if (event.target.matches(".editor-row select[name=type]")) {
    const scroll = dialog.scrollTop;
    captureEditor();
    drawEditor();
    dialog.scrollTop = scroll;
  }
}
function dispatchClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const {action,value} = button.dataset;
  runAction(async () => {
    switch (action) {
      case "tab":
        state.tab = value;
        history.replaceState({fieldroomTab: value},"");
        render();
        break;
      case "pick-form": state.form = value; render(); break;
      case "edit-form": startEditing(value); break;
      case "add-q": case "up": case "down": case "delete-q": editQuestion(action,Number(value)); break;
      case "share-admin": await share(new URL("/manage#" + key,state.room.base).href); break;
      case "copy-player": await share(playerLink(byId(state.room.players,value))); break;
      case "retry-qr": await fillQRCodes(); break;
      case "print":
        if ([...document.querySelectorAll(".card-qr")].some(node => !node.querySelector("img")?.naturalWidth)) {
          throw new Error("请等待全部二维码生成后再打印。");
        }
        window.print(); break;
      case "detail": await showDetail(value); break;
      case "more-history": await moreHistory(); break;
      case "supplement": await showSupplement(value); break;
      case "open": await post({op:"open",form:value}); await loadRoom(); toast("问卷已开放"); break;
      case "pick-interview": selectInterview(value); break;
      case "new-interview": selectInterview(null); break;
      case "remove-occupied":
        for (const id of otherInterviewMembers()) state.targets.delete(id);
        state.previewDirty = true;
        render();
        break;
      case "show": await showInterview(); break;
      case "end": await endInterview(); break;
      case "seal":
        showDialog(dialog,"seal","封存整场？",`<div class="stack"><p>封存后，所有问卷和体验问题转为只读。需要更正时可重新开放。</p>
          <ul>${state.room.forms.map(form=>`<li>${escapeHTML(form.title)} · ${completeCount(form)}/${state.room.players.length} 人已交</li>`).join("")}</ul>
          <div class="row">${actionButton("confirm-seal","确认封存",{style:"primary"})}</div></div>`); break;
      case "confirm-seal": await post({op:"seal"}); dialog.close(); await loadRoom(); toast("场次已封存"); break;
      case "reopen": await post({op:"reopen"}); await loadRoom(); toast("场次已重新开放"); break;
    }
  });
}

let polling = false;
async function poll() {
  if (polling || state.busy || document.hidden) return;
  polling = true;
  try {
    const {rev} = await adminRead("/api/rev");
    if (!state.room || rev !== state.room.rev) await loadRoom();
    $("#status").textContent = "后台已连接";
  } catch {
    $("#status").textContent = "连接中断 · 正在重试";
  } finally { polling = false; }
}
export async function start() {
  if (!key) throw new Error("请使用本场的完整管理链接。");
  const previousTab = history.state?.fieldroomTab;
  if (sections.some(([id]) => id === previousTab)) state.tab = previousTab;
  shell();
  await loadRoom();
  $("#status").textContent = "后台已连接";
  window.setInterval(poll, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
}
