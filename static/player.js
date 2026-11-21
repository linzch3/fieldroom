// A card opens a lease for this browsing session. Refresh uses the existing lease;
// a late write can never reclaim a device that the server has already replaced.
import { api, esc, toast } from "./common.js";

const idleDelay = 550;
const uploadInterval = 2000;
const pollInterval = 950;
const $ = selector => document.querySelector(selector);
const app = () => $("#app");

let code, lease, room, queue = [], failed = [], view = {}, previousPlace;
let timer, active, mustRead = false, forceSave = false, nextPoll = 0;
let templateKey = "", networkDown = false, signedOut = false, composing = false;
let noteId, storageWarning = false, resumeRequested = false;

function uuid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function read(key, fallback) {
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch { return fallback; }
}

function store(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); }
  catch { storageWarning = true; }
}

function key(suffix) { return "fieldroom.device." + lease + "." + suffix; }
function saveQueue() { store(key("queue"), queue); }

function forget() {
  signedOut = true;
  clearTimeout(timer);
  for (const item of ["queue", "state", "view", "return", "failed"]) sessionStorage.removeItem(key(item));
  sessionStorage.removeItem("fieldroom.card." + code);
  app().replaceChildren();
  location.replace("/join");
}

function equivalent(a, b) {
  if (a.op !== b.op) return false;
  if (a.op === "answer") return a.qid === b.qid;
  return a.op === "note" && a.id === b.id && a.submitted === b.submitted;
}

function enqueue(command, immediate = false) {
  const now = Date.now();
  // Only coalesce an operation which has never left this device. A lost reply
  // is retried with its original id and payload, even if a newer change exists.
  let tail = queue.at(-1);
  if (tail && !tail.sent && equivalent(tail.body, command)) {
    tail.body = { ...command, requestId: tail.body.requestId };
  } else {
    tail = { body: { ...command, requestId: uuid() }, first: now, due: now, sent: false };
    queue.push(tail);
  }
  tail.due = immediate ? now : Math.min(now + idleDelay, tail.first + uploadInterval);
  saveQueue();
  showStatus();
  schedule(Math.max(0, Math.min(tail.due, nextPoll || now) - now));
}

function applyCommand(data, command) {
  if (command.op === "answer") data.answers[command.qid] = command.value;
  if (command.op === "submit" && !data.submitted.includes(command.form)) data.submitted.push(command.form);
  if (command.op === "note") {
    const note = { id: command.id, text: command.text, submitted: command.submitted };
    const index = data.notes.findIndex(item => item.id === note.id);
    if (index < 0) data.notes.push(note);
    else data.notes[index] = note;
  }
}

function inputs() {
  const data = { answers: { ...room.answers }, submitted: [...room.submitted], notes: room.notes.map(n => ({ ...n })) };
  for (const item of queue) {
    if (item.body.op !== "submit") applyCommand(data, item.body);
  }
  return data;
}

function schedule(delay = 0) {
  if (signedOut || active) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

function showStatus() {
  const element = $("#status");
  if (!element) return;
  const label = storageWarning ? "浏览器存储不可用，请保持页面打开"
    : networkDown ? (queue.length ? "已存本机 · 待同步" : "连接中断 · 正在重连")
    : queue.length ? "正在同步…" : room?.sealed ? "场次已封存" : "已同步";
  if (element.textContent !== label) element.textContent = label;
}

async function playState() { return api("/api/play", undefined, lease); }

async function sendReady(force) {
  while (queue.length && (force || queue[0].due <= Date.now())) {
    const item = queue[0];
    item.sent = true;
    saveQueue();
    try {
      await api("/api/play/action", item.body, lease);
      if (room) applyCommand(room, item.body);
    } catch (error) {
      if (![400, 404, 409, 422, 423].includes(error.status)) throw error;
      // Sealing or a researcher editing a form can invalidate a pending write.
      // Retain rejected text for recovery and continue with unrelated changes.
      const text = item.body.text ?? item.body.value ?? "";
      failed.push({ text, message: error.message });
      store(key("failed"), failed);
    }
    queue.shift();
    saveQueue();
    if (room) store(key("state"), room);
    mustRead = true;
  }
}

function reviewing(live) {
  return live && live.qid === view.reviewQuestion && live.interviewId === view.reviewInterview;
}

function follows(live) {
  return live && (resumeRequested || !reviewing(live));
}

async function cycle() {
  const force = forceSave;
  forceSave = false;
  if (room) await sendReady(force);
  let refresh = !room || mustRead;
  if (!refresh && Date.now() >= nextPoll) {
    const result = await api("/api/rev", undefined, lease);
    refresh = result.rev !== room.rev;
    nextPoll = Date.now() + pollInterval;
  }
  if (refresh) {
    let fresh = await playState();
    // Participant selection and question jump arrive in one snapshot. Delay
    // presentation until every local edit has an acknowledgement.
    if (follows(fresh.live) && !composing) {
      while (queue.length) {
        await sendReady(true);
        fresh = await playState();
      }
    }
    if (follows(fresh.live) && composing) {
      mustRead = true;
    } else {
      if (view.reviewQuestion && (resumeRequested || !reviewing(fresh.live))) {
        delete view.reviewQuestion;
        delete view.reviewInterview;
        rememberView();
      }
      resumeRequested = false;
      room = fresh;
      store(key("state"), room);
      mustRead = false;
    }
    nextPoll = Date.now() + pollInterval;
  }
  networkDown = false;
  if (refresh || !templateKey) render();
}

async function run() {
  if (signedOut || active) return;
  active = true;
  try {
    await cycle();
  } catch (error) {
    if (error.status === 401 || error.status === 403) return forget();
    networkDown = true;
    if (!room) room = read(key("state"), null);
    if (room) render();
    else app().innerHTML = '<div class="wrap"><section class="panel empty">正在连接场次，请确认已连接现场网络。</section></div>';
  } finally {
    active = false;
    showStatus();
    if (!signedOut) {
      const delay = networkDown ? 1800 : Math.min(
        Math.max(0, (nextPoll || Date.now()) - Date.now()),
        queue.length ? Math.max(0, queue[0].due - Date.now()) : pollInterval
      );
      schedule(delay);
    }
  }
}

function pickForm() {
  return room.forms.find(f => f.id === view.form)
    || room.forms.find(f => !room.submitted.includes(f.id)) || room.forms[0];
}

function rememberView() { store(key("view"), view); }

function chip(label, good = false) {
  return '<span class="badge' + (good ? " good" : "") + '">' + esc(label) + "</span>";
}

function heading() {
  return '<header class="player-head"><div><div class="eyebrow">' + esc(room.title) +
    '</div><h1>' + esc(room.name) + '</h1></div>' +
    (room.sealed ? chip("已封存") : "") + '</header>';
}

function tabs() {
  return '<nav class="player-tabs" aria-label="玩家工作区">' +
    [["form", "我的问卷"], ["notes", "体验问题"]].map(([id, title]) =>
      '<button type="button" data-tab="' + id + '" aria-pressed="' + (view.tab === id) + '">' + title + "</button>"
    ).join("") + "</nav>";
}

function question(q, index) {
  const label = esc(q.label), qid = esc(q.id);
  const questionLabel = '<legend><span class="question-index">' + String(index + 1).padStart(2, "0") +
    '</span><span>' + label + '</span>' +
    (!q.required ? '<small class="question-optional">选填</small>' : "") + '</legend>';
  const disabled = room.sealed ? " disabled" : "";
  const required = q.required ? " required" : "";
  let input;
  if (q.type === "text") {
    input = '<textarea rows="3" data-q="' + qid + '" maxlength="20000" aria-label="' + label + '"' + required + disabled +
      ' placeholder="写下你的回答"></textarea>';
  } else {
    const options = q.type === "rating" ? ["1", "2", "3", "4", "5"] : q.options;
    input = '<div class="' + (q.type === "rating" ? "rating-options" : "choice-options") + '">' +
      options.map(value => '<label><input type="radio" data-q="' + qid + '" name="q-' + qid +
        '" value="' + esc(value) + '"' + required + disabled + '><span>' + esc(value) + '</span></label>').join("") + '</div>';
  }
  return '<fieldset class="player-question" aria-label="' + label + '">' + questionLabel + input + '</fieldset>';
}

function earlierQuestions(form) {
  const current = new Map(form.questions.map(q => [q.id, q]));
  const changed = (room.snapshots || []).filter(snapshot => {
    if (snapshot.form !== form.id) return false;
    const q = current.get(snapshot.qid);
    return !q || q.label !== snapshot.label || q.type !== snapshot.type
      || JSON.stringify(q.options) !== JSON.stringify(snapshot.options);
  });
  if (!changed.length) return "";
  return '<details class="older-questions"><summary>查看作答时的题目（' + changed.length + '）</summary>' +
    changed.map(q => '<div><strong>' + esc(q.label) + '</strong><p>' + esc(q.value || "未作答") + '</p></div>').join("") +
    "</details>";
}

function survey(form) {
  if (!form) return '<section class="panel empty"><h2>等待问卷开放</h2><p>研究员开放问卷后会自动出现。</p></section>';
  const sent = room.submitted.includes(form.id);
  const pending = queue.some(item => item.body.op === "submit" && item.body.form === form.id);
  const nav = '<nav class="form-list" aria-label="已开放问卷">' + room.forms.map((f, i) =>
    '<button type="button" data-form="' + esc(f.id) + '" aria-pressed="' + (form.id === f.id) + '"><span>' +
    String(i + 1).padStart(2, "0") + '</span>' + esc(f.title) +
    (room.submitted.includes(f.id) ? '<small>已交</small>' : "") + "</button>").join("") + "</nav>";
  return nav + '<form id="player-survey" class="panel player-paper"><div class="section-head"><h2>' + esc(form.title) +
    '</h2>' + chip(sent ? "已提交" : "未交卷", sent) + '</div>' +
    (sent && !room.sealed ? '<p class="muted edit-hint">修改会自动保存。</p>' : "") +
    earlierQuestions(form) + form.questions.map(question).join("") +
    (room.sealed || sent ? "" : '<div class="survey-footer"><button class="btn primary" type="submit"' +
      (pending ? " disabled" : "") + '>' + (pending ? "正在交卷…" : "提交问卷") + "</button></div>") + "</form>";
}

function notes(data) {
  const draft = data.notes.find(n => !n.submitted);
  noteId = draft?.id || noteId || uuid();
  const sent = data.notes.filter(n => n.submitted).slice().reverse();
  const editor = !room.sealed ? '<form id="player-note" class="panel player-paper"><label class="note-label" for="issue-text">记下体验问题</label>' +
    '<textarea id="issue-text" maxlength="20000" rows="4" placeholder="刚刚在哪一步遇到了什么？"></textarea>' +
    '<div class="note-footer"><small class="muted">草稿自动同步给研究员</small><button class="btn primary" type="submit">提交问题</button></div></form>' : "";
  const archivedDraft = room.sealed && draft?.text ? '<article class="issue-item">' + chip("草稿") + '<p>' +
    esc(draft.text) + '</p></article>' : "";
  const list = sent.map(n => '<article class="issue-item">' + chip("已提交", true) + '<p>' + esc(n.text) + '</p></article>').join("");
  return editor + (archivedDraft || list ? '<section class="panel player-paper"><h2>问题记录</h2>' + archivedDraft + list + "</section>"
    : room.sealed ? '<div class="panel empty">没有体验问题记录。</div>' : "");
}

function liveView(live) {
  const form = room.forms.find(f => f.id === live.form);
  const hasAnswer = live.value !== null && live.value !== undefined && live.value !== "";
  const submitted = room.submitted.includes(live.form);
  return '<article class="live-sheet"><div class="live-meta"><span class="live-indicator">访谈进行中</span><span>' +
    esc(form?.title || "") + '</span></div><h2 class="live-question">' + esc(live.label) +
    '</h2><div class="live-response"><div class="live-caption">我的问卷答案</div><div class="live-answer' +
    (hasAnswer && /^([1-5])$/.test(live.value) ? " numeric" : "") + '">' +
    esc(hasAnswer ? live.value : submitted ? "此题未作答" : "暂无已提交答案") + '</div></div></article>' +
    '<button type="button" class="btn live-review" data-review>回看我的问卷</button>';
}

function failures() {
  if (!failed.length) return "";
  return '<aside class="panel save-warning" role="status"><strong>有修改未同步</strong>' +
    failed.map(f => '<p>' + esc(f.message) + (f.text ? '<br><span>' + esc(f.text) + '</span>' : "") + "</p>").join("") +
    '<button type="button" class="btn" data-dismiss>知道了</button></aside>';
}

function capture() {
  const el = document.activeElement;
  return { y: window.scrollY, q: el?.dataset?.q, note: el?.id === "issue-text",
    radioValue: el?.type === "radio" ? el.value : undefined,
    start: el?.tagName === "TEXTAREA" ? el.selectionStart : null,
    end: el?.tagName === "TEXTAREA" ? el.selectionEnd : null };
}

function restore(place) {
  if (!place) return;
  const target = place.note ? $("#issue-text") : [...app().querySelectorAll("[data-q]")].find(el =>
    el.dataset.q === place.q && (place.radioValue === undefined || el.value === place.radioValue));
  if (target && !target.disabled) {
    target.focus({ preventScroll: true });
    if (place.start !== null && target.tagName === "TEXTAREA") target.setSelectionRange(place.start, place.end);
  }
  window.scrollTo(0, place.y || 0);
}

function patchValues(data) {
  for (const el of app().querySelectorAll("[data-q]")) {
    const value = data.answers[el.dataset.q] ?? "";
    if (el.type === "radio") el.checked = value === el.value;
    else if (el.value !== value && !(composing && document.activeElement === el)) el.value = value;
  }
  const draft = data.notes.find(n => !n.submitted);
  const box = $("#issue-text");
  if (box && box.value !== (draft?.text || "") && !(composing && document.activeElement === box)) {
    box.value = draft?.text || "";
  }
}

function render() {
  if (!room) return;
  const data = inputs();
  const form = pickForm();
  if (form && !view.form) { view.form = form.id; rememberView(); }
  const live = reviewing(room.live) ? null : room.live;
  const entering = live && !app().querySelector(".live-sheet");
  const leaving = !live && !!app().querySelector(".live-sheet");
  // Structural changes can affect controls; ordinary autosave/poll replies only
  // patch values. The focused input and composition survive steady-state polling.
  const markup = '<div class="wrap player-wrap">' + heading() + failures() +
    (live ? liveView(live) :
      (room.live ? '<div class="review-bar"><span>访谈进行中</span><button type="button" class="btn" data-resume>返回访谈</button></div>' : "") +
      tabs() + (view.tab === "notes" ? notes(data) : survey(form))) + "</div>";
  if (templateKey !== markup) {
    let place = capture();
    if (entering && templateKey) { previousPlace = place; store(key("return"), place); }
    if (leaving) place = previousPlace || read(key("return"), null);
    app().innerHTML = markup;
    templateKey = markup;
    patchValues(data);
    if (entering) window.scrollTo(0, 0);
    else if (leaving || !live) restore(place);
    if (leaving) { previousPlace = null; store(key("return"), null); }
  } else patchValues(data);
  showStatus();
}

function bind() {
  app().addEventListener("click", event => {
    const el = event.target.closest("button");
    if (!el) return;
    if (el.hasAttribute("data-resume")) {
      resumeRequested = true;
      forceSave = true;
      mustRead = true;
      schedule();
      return;
    }
    if (el.hasAttribute("data-review") && room.live) {
      view.reviewQuestion = room.live.qid;
      view.reviewInterview = room.live.interviewId;
      view.form = room.live.form;
      view.tab = "form";
      previousPlace = { y: 0 };
    } else if (el.hasAttribute("data-tab")) view.tab = el.dataset.tab;
    else if (el.hasAttribute("data-form")) { view.form = el.dataset.form; view.tab = "form"; }
    else if (el.hasAttribute("data-dismiss")) { failed = []; store(key("failed"), failed); }
    else return;
    rememberView();
    render();
  });

  app().addEventListener("input", event => {
    const el = event.target;
    if (room?.sealed) return;
    if (el.matches("[data-q]")) {
      if (el.type !== "radio" || el.checked) {
        enqueue({ op: "answer", qid: el.dataset.q, value: el.value, expectedVersion: pickForm()?.version }, el.type === "radio");
      }
    } else if (el.id === "issue-text") {
      enqueue({ op: "note", id: noteId, text: el.value, submitted: false });
    }
  });

  app().addEventListener("submit", event => {
    event.preventDefault();
    if (!room || room.sealed) return;
    if (event.target.id === "player-survey") {
      const form = pickForm();
      if (!form || room.submitted.includes(form.id) || queue.some(i => i.body.op === "submit" && i.body.form === form.id)) return;
      enqueue({ op: "submit", form: form.id, expectedVersion: form.version }, true);
    } else if (event.target.id === "player-note") {
      const text = $("#issue-text").value;
      if (!text.trim()) { toast("先写下遇到的问题"); return; }
      enqueue({ op: "note", id: noteId, text, submitted: true }, true);
      noteId = null;
    } else return;
    forceSave = true;
    render();
    schedule();
  });

  app().addEventListener("compositionstart", () => { composing = true; });
  app().addEventListener("compositionend", () => { composing = false; if (mustRead) schedule(); });
  window.addEventListener("online", () => { mustRead = true; schedule(); });
  window.addEventListener("offline", () => { networkDown = true; showStatus(); });
  window.addEventListener("pageshow", () => { mustRead = true; schedule(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) forceSave = true;
    else mustRead = true;
    schedule();
  });
}

export async function start() {
  code = location.hash.slice(1);
  if (!code) return location.replace("/join");
  const cardKey = "fieldroom.card." + code;
  lease = read(cardKey, null);
  if (!lease) {
    try {
      const result = await api("/api/claim", { code });
      lease = result.device;
      store(cardKey, lease);
    } catch (error) {
      if (error.status === 401 || error.status === 403 || error.status === 404) return location.replace("/join");
      app().innerHTML = '<section class="wrap panel empty"><h2>暂时无法连接场次</h2><p>连接现场网络后，再试一次。</p><button class="btn primary" id="retry-claim">重新连接</button></section>';
      $("#retry-claim").onclick = () => location.reload();
      return;
    }
  }
  queue = read(key("queue"), []);
  failed = read(key("failed"), []);
  view = read(key("view"), { tab: "form" });
  previousPlace = read(key("return"), null);
  bind();
  await run();
}
