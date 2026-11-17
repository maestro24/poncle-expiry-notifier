/**
 * 발송 문구 템플릿: list, reorder, editor, delete with undo.
 */
import { saveConfig } from "../domain/config";
import { unknownTemplateTokens } from "../domain/sender";
import { conditionSummary } from "../domain/template-match";
import { MILESTONE_SOURCES, STATUSES, TELECOMS, type MessageTemplate, type MilestoneSource, type StatusCode, type TelecomCode } from "../domain/types";
import { appConfirm } from "../ui/dialog";
import { removeTemplate, restoreTemplateAt } from "../ui/template-undo";
import { templateVarChips } from "../ui/var-chips";
import { CONFIG_READ_FAILED_MESSAGE, S } from "../app/state";
import { hooks } from "../app/hooks";
import { $, $$, esc, toast, setPressed } from "../app/dom";

/** Variable chips insert the Korean token they show ({고객명}) — I8. */
function buildVarChips(): void {
  for (const holder of $$(".varchips")) {
    const targetId = holder.dataset.target!;
    holder.innerHTML = "";
    for (const { token } of templateVarChips()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "varchip";
      b.textContent = token;
      b.onclick = () => insertToken(targetId, token);
      holder.appendChild(b);
    }
  }
}
function insertToken(targetId: string, token: string): void {
  const ta = $<HTMLTextAreaElement>("#" + targetId);
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
  const pos = start + token.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
}

/* ---------- templates (발송 문구) sub-screens ---------- */
let editingId: string | null = null;
function newTemplateId(): string {
  return "tpl_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export function renderTemplateList(): void {
  const list = $("#tpl-list");
  const tpls = S.CFG.templates || [];
  $("#tpl-empty").classList.toggle("hidden", tpls.length > 0);
  list.innerHTML = "";
  tpls.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = "listcard tpl-card";
    const preview = t.body.trim().replace(/\s+/g, " ").slice(0, 80);
    card.innerHTML = `
      <div class="tpl-row">
        <div class="tpl-main">
          <div class="lc-top"><span class="lc-name">${esc(t.name) || "(이름 없음)"}</span>
            <span class="lc-tag tag-open">${esc(conditionSummary(t))}</span></div>
          <div class="lc-meta">${esc(preview) || "(내용 없음)"}</div>
        </div>
        <div class="tpl-order">
          <button type="button" class="tpl-move tpl-up" aria-label="위로 (먼저 선택)">▲</button>
          <button type="button" class="tpl-move tpl-down" aria-label="아래로">▼</button>
        </div>
      </div>`;
    card.onclick = () => openTemplateEdit(t.id);
    const up = card.querySelector(".tpl-up") as HTMLButtonElement;
    const down = card.querySelector(".tpl-down") as HTMLButtonElement;
    up.disabled = i === 0;
    down.disabled = i === tpls.length - 1;
    up.onclick = (e) => { e.stopPropagation(); void moveTemplate(i, -1); };
    down.onclick = (e) => { e.stopPropagation(); void moveTemplate(i, 1); };
    list.appendChild(card);
  });
}
/** Swap a template with its neighbour (list order breaks ties between equally
 *  specific matches — the upper one is pre-selected on the send sheet). */
async function moveTemplate(index: number, dir: -1 | 1): Promise<void> {
  const tpls = [...(S.CFG.templates || [])];
  const j = index + dir;
  if (j < 0 || j >= tpls.length) return;
  if (S.CONFIG_READ_FAILED) { toast(CONFIG_READ_FAILED_MESSAGE, { err: true }); return; }
  [tpls[index], tpls[j]] = [tpls[j], tpls[index]];
  try {
    S.CFG = await saveConfig({ ...S.CFG, templates: tpls });
  } catch {
    toast("순서를 저장하지 못했습니다 — 다시 시도하세요", { err: true });
    return;
  }
  renderTemplateList();
}
/** 시점(source) chip labels — the stored value is keepdate/term, shown human-readable. */
const SOURCE_LABEL: Record<MilestoneSource, string> = { keepdate: "요금제 유지", term: "약정 만료" };

function buildCheckChips(
  holderId: string,
  options: readonly string[],
  selected: string[],
  labelOf?: (opt: string) => string,
): void {
  const box = $("#" + holderId);
  box.innerHTML = "";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "checkchip";
    setPressed(b, selected.includes(opt));
    b.dataset.val = opt;
    b.textContent = labelOf ? labelOf(opt) : opt;
    b.onclick = () => setPressed(b, !b.classList.contains("on"));
    box.appendChild(b);
  }
}
function gatherCheck(holderId: string): string[] {
  return $$("#" + holderId + " .checkchip")
    .filter((c) => c.classList.contains("on"))
    .map((c) => c.dataset.val!);
}
function openTemplateEdit(id: string | null): void {
  editingId = id;
  const t = id ? (S.CFG.templates || []).find((x) => x.id === id) : null;
  $("#te-title").textContent = t ? "템플릿 수정" : "새 템플릿";
  $<HTMLInputElement>("#te-name").value = t?.name || "";
  $<HTMLTextAreaElement>("#te-body").value = t?.body || "";
  buildCheckChips("te-sources", MILESTONE_SOURCES, t?.sources ?? [], (s) => SOURCE_LABEL[s as MilestoneSource]);
  buildCheckChips("te-telecoms", TELECOMS, t?.telecoms ?? []);
  buildCheckChips("te-statuses", STATUSES, t?.statuses ?? []);
  buildVarChips();
  $("#te-msg").textContent = "";
  $("#btn-te-delete").classList.toggle("hidden", !t);
  editSnapshot = templateFormState();
  hooks.showScreen("template-edit");
}
/** The editor form as opened — leaving with a different form asks first (#30). */
let editSnapshot = "";
function templateFormState(): string {
  return JSON.stringify([
    $<HTMLInputElement>("#te-name").value,
    $<HTMLTextAreaElement>("#te-body").value,
    gatherCheck("te-sources"),
    gatherCheck("te-telecoms"),
    gatherCheck("te-statuses"),
  ]);
}
export function templateEditDirty(): boolean {
  return templateFormState() !== editSnapshot;
}
async function saveTemplate(): Promise<void> {
  const name = $<HTMLInputElement>("#te-name").value.trim();
  const body = $<HTMLTextAreaElement>("#te-body").value.trim();
  if (!body) { $("#te-msg").textContent = "문구를 입력하세요"; return; }
  // {이름} 같은 모르는 변수는 고객 정보로 바뀌지 않는다 — 저장 전에 알린다 (#38).
  const unknown = unknownTemplateTokens(body);
  if (unknown.length) {
    const keep = await appConfirm(
      `알 수 없는 변수가 있습니다: ${unknown.join(", ")}\n\n` +
      `이 부분은 고객 정보로 바뀌지 않습니다. 변수 버튼({고객명} 등)으로 넣은 것만 바뀝니다.\n그래도 저장할까요?`,
      { title: "문구 확인", okLabel: "그대로 저장", cancelLabel: "고치기" },
    );
    if (!keep) { $("#te-msg").textContent = `확인 필요: ${unknown.join(", ")}`; return; }
  }
  const telecoms = gatherCheck("te-telecoms") as TelecomCode[];
  const statuses = gatherCheck("te-statuses") as StatusCode[];
  const sources = gatherCheck("te-sources") as MilestoneSource[];
  if (S.CONFIG_READ_FAILED) {
    $("#te-msg").textContent = CONFIG_READ_FAILED_MESSAGE;
    toast(CONFIG_READ_FAILED_MESSAGE, { err: true });
    return;
  }
  // Re-read the live list after the awaited confirm (U7): the template being edited
  // may be gone (a restore replaced the list) — then it is added back as new
  // instead of the edit vanishing behind a '저장했습니다'.
  const current: MessageTemplate[] = S.CFG.templates || [];
  const i = editingId ? current.findIndex((x) => x.id === editingId) : -1;
  const missing = !!editingId && i < 0;
  const id = editingId && !missing ? editingId : newTemplateId();
  const tpl: MessageTemplate = { id, name, telecoms, statuses, sources, body };
  const tpls = i >= 0 ? current.map((x, k) => (k === i ? tpl : x)) : [...current, tpl];
  try {
    S.CFG = await saveConfig({ ...S.CFG, templates: tpls });
  } catch {
    $("#te-msg").textContent = "저장하지 못했습니다 — 다시 시도하세요";
    toast("템플릿을 저장하지 못했습니다 — 다시 시도하세요", { err: true });
    return; // stay in the editor with the text intact
  }
  editingId = id;
  editSnapshot = templateFormState(); // saved: leaving must not ask about unsaved edits
  toast(missing ? "편집하던 템플릿이 목록에 없어 새 템플릿으로 저장했습니다" : "템플릿을 저장했습니다");
  hooks.showScreen("templates");
}
/** 이 템플릿 삭제 (#54): in-app confirm first, then an undo toast that puts the
 *  template back at its old position (order breaks auto-selection ties). */
async function deleteTemplate(): Promise<void> {
  const id = editingId;
  if (!id) return;
  const found = removeTemplate(S.CFG.templates || [], id);
  if (!found) return;
  const ok = await appConfirm(`‘${found.removed.name || "(이름 없음)"}’ 템플릿을 삭제할까요?`, {
    title: "템플릿 삭제",
    okLabel: "삭제",
    danger: true,
  });
  if (!ok || S.CURRENT !== "template-edit" || editingId !== id) return;
  if (S.CONFIG_READ_FAILED) { toast(CONFIG_READ_FAILED_MESSAGE, { err: true }); return; }
  // Re-derive from the live list: the confirm was async.
  const r = removeTemplate(S.CFG.templates || [], id);
  if (!r) return;
  try {
    S.CFG = await saveConfig({ ...S.CFG, templates: r.list });
  } catch {
    toast("템플릿을 삭제하지 못했습니다 — 다시 시도하세요", { err: true });
    return;
  }
  editSnapshot = templateFormState(); // deleted: leaving must not ask about unsaved edits
  hooks.showScreen("templates");
  toast("템플릿을 삭제했습니다", { undo: () => void undoTemplateDelete(r.removed, r.index) });
}
async function undoTemplateDelete(tpl: MessageTemplate, index: number): Promise<void> {
  if (S.CONFIG_READ_FAILED) { toast(CONFIG_READ_FAILED_MESSAGE, { err: true }); return; }
  try {
    S.CFG = await saveConfig({ ...S.CFG, templates: restoreTemplateAt(S.CFG.templates || [], tpl, index) });
  } catch {
    toast("템플릿을 되돌리지 못했습니다", { err: true });
    return;
  }
  if (S.CURRENT === "templates") renderTemplateList();
  toast("템플릿을 되돌렸습니다");
}

/** Template list/editor buttons. */
export function bindTemplates(): void {
  // Templates
  $("#btn-tpl-new").onclick = () => openTemplateEdit(null);
  $("#btn-te-save").onclick = () => void saveTemplate();
  $("#btn-te-delete").onclick = () => void deleteTemplate();
}
