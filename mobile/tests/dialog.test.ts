// @vitest-environment happy-dom
/**
 * #64: the in-app dialog that replaces window.confirm / alert / prompt. Styled like
 * the app's .modal-overlay sheets, Korean buttons (취소 / 확인), Promise-based,
 * focus-safe (focus moves in, is trapped, and returns), Escape = 취소.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { appAlert, appConfirm, dismissAppDialog, isAppDialogOpen } from "../src/ui/dialog";

const flush = () => new Promise((r) => setTimeout(r, 0));
const q = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const key = (k: string, shift = false) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = `<button id="opener">open</button>`;
});

describe("appConfirm", () => {
  it("shows a modal-overlay with the message and Korean 취소/확인, resolves true on 확인", async () => {
    const p = appConfirm("정말 보낼까요?\n두 번째 줄", { title: "확인 필요" });
    await flush();
    const overlay = q("#app-dialog");
    expect(overlay.classList.contains("modal-overlay")).toBe(true);
    expect(overlay.classList.contains("hidden")).toBe(false);
    expect(overlay.getAttribute("role")).toBe("alertdialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(q("#app-dialog-title").textContent).toBe("확인 필요");
    expect(q("#app-dialog-msg").textContent).toBe("정말 보낼까요?\n두 번째 줄");
    expect(q("#app-dialog-cancel").textContent).toBe("취소");
    expect(q("#app-dialog-ok").textContent).toBe("확인");
    expect(isAppDialogOpen()).toBe(true);
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await expect(p).resolves.toBe(true);
    expect(overlay.classList.contains("hidden")).toBe(true);
    expect(isAppDialogOpen()).toBe(false);
  });

  it("resolves false on 취소, on Escape, and on a backdrop tap", async () => {
    let p = appConfirm("a");
    await flush();
    q<HTMLButtonElement>("#app-dialog-cancel").click();
    await expect(p).resolves.toBe(false);

    p = appConfirm("b");
    await flush();
    key("Escape");
    await expect(p).resolves.toBe(false);

    p = appConfirm("c");
    await flush();
    q("#app-dialog").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  it("dismissAppDialog (Android back key) cancels an open confirm; false when none is open", async () => {
    expect(dismissAppDialog()).toBe(false);
    const p = appConfirm("뒤로가기");
    await flush();
    expect(dismissAppDialog()).toBe(true);
    await expect(p).resolves.toBe(false);
    expect(isAppDialogOpen()).toBe(false);
    expect(dismissAppDialog()).toBe(false);
  });

  it("never uses the native window.confirm / alert", async () => {
    let nativeCalls = 0;
    window.confirm = (() => { nativeCalls++; return true; }) as typeof window.confirm;
    window.alert = (() => { nativeCalls++; }) as typeof window.alert;
    const p = appConfirm("x");
    await flush();
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await p;
    expect(nativeCalls).toBe(0);
  });

  it("supports custom labels (e.g. 설정 열기)", async () => {
    const p = appConfirm("권한", { okLabel: "설정 열기", cancelLabel: "나중에" });
    await flush();
    expect(q("#app-dialog-ok").textContent).toBe("설정 열기");
    expect(q("#app-dialog-cancel").textContent).toBe("나중에");
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await p;
    // labels reset for the next dialog
    const p2 = appConfirm("y");
    await flush();
    expect(q("#app-dialog-ok").textContent).toBe("확인");
    expect(q("#app-dialog-cancel").textContent).toBe("취소");
    q<HTMLButtonElement>("#app-dialog-cancel").click();
    await p2;
  });

  it("focuses 취소 (safe default), traps Tab inside, and restores focus on close", async () => {
    const opener = q<HTMLButtonElement>("#opener");
    opener.focus();
    const p = appConfirm("x");
    await flush();
    expect(document.activeElement?.id).toBe("app-dialog-cancel");
    key("Tab");
    expect(document.activeElement?.id).toBe("app-dialog-ok");
    key("Tab");
    expect(document.activeElement?.id).toBe("app-dialog-cancel");
    key("Tab", true);
    expect(document.activeElement?.id).toBe("app-dialog-ok");
    q<HTMLButtonElement>("#app-dialog-cancel").click();
    await p;
    expect(document.activeElement).toBe(opener);
  });

  it("queues overlapping dialogs (one at a time, in order)", async () => {
    const p1 = appConfirm("first");
    const p2 = appConfirm("second");
    await flush();
    expect(q("#app-dialog-msg").textContent).toBe("first");
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await expect(p1).resolves.toBe(true);
    await flush();
    expect(q("#app-dialog-msg").textContent).toBe("second");
    q<HTMLButtonElement>("#app-dialog-cancel").click();
    await expect(p2).resolves.toBe(false);
  });
});

describe("appAlert", () => {
  it("shows only 확인 and resolves when it is pressed", async () => {
    const p = appAlert("저장되었습니다");
    await flush();
    expect(q("#app-dialog-cancel").classList.contains("hidden")).toBe(true);
    expect(document.activeElement?.id).toBe("app-dialog-ok");
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await expect(p).resolves.toBeUndefined();
    expect(q("#app-dialog").classList.contains("hidden")).toBe(true);
  });
});

describe("focus return when the opener is gone (L30)", () => {
  it("the list the opener lived in gets focus when the card was re-rendered away", async () => {
    document.body.innerHTML = `<div id="due-list"><div class="listcard"><button id="card-send">보내기</button></div></div>`;
    q<HTMLButtonElement>("#card-send").focus();
    const p = appConfirm("보낼까요?");
    await flush();
    // the list re-renders while the dialog is up (a send result, a refresh)
    q("#due-list").innerHTML = `<div class="listcard"><button>보내기</button></div>`;
    q<HTMLButtonElement>("#app-dialog-ok").click();
    await p;
    expect(document.activeElement).toBe(q("#due-list"));
    expect(q("#due-list").getAttribute("tabindex")).toBe("-1");
  });

  it("an opener still on the page gets focus back as before", async () => {
    document.body.innerHTML = `<div id="wrap"><button id="opener">open</button></div>`;
    q<HTMLButtonElement>("#opener").focus();
    const p = appConfirm("a");
    await flush();
    q<HTMLButtonElement>("#app-dialog-cancel").click();
    await p;
    expect(document.activeElement?.id).toBe("opener");
    expect(q("#wrap").hasAttribute("tabindex")).toBe(false);
  });
});
