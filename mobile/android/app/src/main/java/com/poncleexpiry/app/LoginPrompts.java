package com.poncleexpiry.app;

import android.app.Activity;
import android.app.AlertDialog;

import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSession.PromptDelegate;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Poncle's alert() / confirm() on the Gecko login screen, shown as the app-styled
 * dialog (R.style.PoncleDialog: rounded card, app blue buttons, follows the system
 * light/dark mode) with Korean 확인/취소 instead of an unstyled or English default
 * (audit 1-21). Every prompt's GeckoResult is completed EXACTLY once on every
 * path — 확인, 취소, back/outside cancel, dismiss (incl. the activity going away),
 * the page withdrawing the prompt, or a failure to show — otherwise the page's
 * script would stay blocked. Prompts while the top document is not Poncle are
 * answered immediately (dismiss / 취소). prompt() is never used by Poncle's login
 * and is dismissed; leaving the page (beforeunload) is always allowed. A
 * {@code <select>} (choice prompt) opens an app-styled list (audit L40): single
 * choice for a plain select / menu, checkboxes for a multiple select.
 */
final class LoginPrompts implements PromptDelegate {

    /** Whether a prompt may be shown right now (activity alive, top frame Poncle). */
    interface Gate {
        boolean canShow();
    }

    /** One way of answering a prompt (java.util.function needs API 24; minSdk is 23). */
    private interface Responder {
        PromptResponse get();
    }

    private final Activity activity;
    private final Gate gate;
    private AlertDialog current;

    LoginPrompts(Activity activity, Gate gate) {
        this.activity = activity;
        this.gate = gate;
    }

    @Override
    public GeckoResult<PromptResponse> onAlertPrompt(GeckoSession session, AlertPrompt prompt) {
        return show(prompt, prompt.message, false, prompt::dismiss, prompt::dismiss);
    }

    @Override
    public GeckoResult<PromptResponse> onButtonPrompt(GeckoSession session, ButtonPrompt prompt) {
        return show(prompt, prompt.message, true,
            () -> prompt.confirm(ButtonPrompt.Type.POSITIVE),
            () -> prompt.confirm(ButtonPrompt.Type.NEGATIVE));
    }

    /**
     * {@code <select>} / menu (audit L40). Without this delegate method Gecko
     * dismisses the prompt and the select cannot be changed (it worked in the
     * WebView-era login). Optgroups are flattened (their label is not
     * selectable); separators and disabled options are skipped.
     */
    @Override
    public GeckoResult<PromptResponse> onChoicePrompt(GeckoSession session, ChoicePrompt prompt) {
        final GeckoResult<PromptResponse> result = new GeckoResult<>();
        final AtomicBoolean settled = new AtomicBoolean(false);
        final List<ChoicePrompt.Choice> items = new ArrayList<>();
        flatten(prompt.choices, items);
        if (!gate.canShow() || items.isEmpty()) {
            settle(result, settled, prompt::dismiss);
            return result;
        }
        final String[] labels = new String[items.size()];
        final boolean[] checked = new boolean[items.size()];
        int selected = -1;
        for (int i = 0; i < items.size(); i++) {
            ChoicePrompt.Choice c = items.get(i);
            labels[i] = c.label == null ? "" : c.label;
            checked[i] = c.selected;
            if (c.selected && selected < 0) selected = i;
        }
        final boolean multiple = prompt.type == ChoicePrompt.Type.MULTIPLE;
        try {
            AlertDialog.Builder b = new AlertDialog.Builder(activity, R.style.PoncleDialog)
                .setOnCancelListener(d -> settle(result, settled, prompt::dismiss))
                .setOnDismissListener(d -> {
                    settle(result, settled, prompt::dismiss);
                    if (current == d) current = null;
                });
            if (prompt.title != null && !prompt.title.isEmpty()) b.setTitle(prompt.title);
            if (multiple) {
                b.setMultiChoiceItems(labels, checked, (d, which, isChecked) -> checked[which] = isChecked)
                    .setPositiveButton("확인", (d, w) -> settle(result, settled, () -> {
                        List<ChoicePrompt.Choice> picked = new ArrayList<>();
                        for (int i = 0; i < checked.length; i++) if (checked[i]) picked.add(items.get(i));
                        return prompt.confirm(picked.toArray(new ChoicePrompt.Choice[0]));
                    }))
                    .setNegativeButton("취소", (d, w) -> settle(result, settled, prompt::dismiss));
            } else {
                b.setSingleChoiceItems(labels, selected, (d, which) -> {
                    settle(result, settled, () -> prompt.confirm(items.get(which)));
                    d.dismiss();
                });
            }
            final AlertDialog dialog = b.create();
            dialog.setCanceledOnTouchOutside(true);
            prompt.setDelegate(new PromptInstanceDelegate() {
                @Override
                public void onPromptDismiss(BasePrompt p) {
                    settled.set(true); // Gecko already discarded it; nothing to answer
                    try { dialog.dismiss(); } catch (Exception ignored) { }
                }
            });
            current = dialog;
            dialog.show();
        } catch (Exception e) {
            current = null;
            settle(result, settled, prompt::dismiss);
        }
        return result;
    }

    /** Selectable options in display order (optgroup children inlined). */
    private static void flatten(ChoicePrompt.Choice[] choices, List<ChoicePrompt.Choice> out) {
        if (choices == null) return;
        for (ChoicePrompt.Choice c : choices) {
            if (c == null || c.separator) continue;
            if (c.items != null) {
                flatten(c.items, out); // optgroup: its label is not an option
                continue;
            }
            if (!c.disabled) out.add(c);
        }
    }

    @Override
    public GeckoResult<PromptResponse> onTextPrompt(GeckoSession session, TextPrompt prompt) {
        return GeckoResult.fromValue(prompt.dismiss());
    }

    @Override
    public GeckoResult<PromptResponse> onBeforeUnloadPrompt(GeckoSession session, BeforeUnloadPrompt prompt) {
        return GeckoResult.fromValue(prompt.confirm(AllowOrDeny.ALLOW)); // allow leaving the page
    }

    /**
     * @param onOk     response for 확인
     * @param onCancel response for 취소 / back / outside tap / dismiss; for an
     *                 alert that is the same acknowledgement as 확인
     */
    private GeckoResult<PromptResponse> show(BasePrompt prompt, String message, boolean isConfirm,
                                             Responder onOk, Responder onCancel) {
        final GeckoResult<PromptResponse> result = new GeckoResult<>();
        final AtomicBoolean settled = new AtomicBoolean(false);
        if (!gate.canShow()) {
            settle(result, settled, onCancel);
            return result;
        }
        try {
            AlertDialog.Builder b = new AlertDialog.Builder(activity, R.style.PoncleDialog)
                .setTitle("폰클 안내")
                .setMessage(message == null ? "" : message)
                .setPositiveButton("확인", (d, w) -> settle(result, settled, onOk))
                .setOnCancelListener(d -> settle(result, settled, onCancel))
                .setOnDismissListener(d -> {
                    settle(result, settled, onCancel);
                    if (current == d) current = null;
                });
            if (isConfirm) b.setNegativeButton("취소", (d, w) -> settle(result, settled, onCancel));
            final AlertDialog dialog = b.create();
            dialog.setCanceledOnTouchOutside(!isConfirm); // a confirm needs an explicit choice
            // The page withdrew the prompt (navigated away / closed): close ours too.
            prompt.setDelegate(new PromptInstanceDelegate() {
                @Override
                public void onPromptDismiss(BasePrompt p) {
                    settled.set(true); // Gecko already discarded it; nothing to answer
                    try { dialog.dismiss(); } catch (Exception ignored) { }
                }
            });
            current = dialog;
            dialog.show();
        } catch (Exception e) {
            // e.g. BadTokenException while the window is going away — never leave
            // the page's script blocked.
            current = null;
            settle(result, settled, onCancel);
        }
        return result;
    }

    private static void settle(GeckoResult<PromptResponse> result, AtomicBoolean settled,
                               Responder response) {
        if (!settled.compareAndSet(false, true)) return;
        try {
            result.complete(response.get());
        } catch (Exception ignored) {
            // the session may already be gone; nothing left to unblock
        }
    }

    /** Dismiss a still-open prompt (its dismiss listener answers it). */
    void dismissAll() {
        AlertDialog d = current;
        current = null;
        if (d != null) {
            try { d.dismiss(); } catch (Exception ignored) { }
        }
    }
}
