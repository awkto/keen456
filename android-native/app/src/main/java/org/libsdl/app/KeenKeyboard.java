package org.libsdl.app;

/**
 * Keen addition — NOT part of upstream SDL's Java glue (everything else in
 * this package is stock). The ⌨ pill needs SDLActivity's soft-keyboard
 * machinery, but sendCommand / COMMAND_TEXTEDIT_HIDE are package-private, so
 * this shim lives in the package and exposes just the toggle the app needs.
 * Going through sendCommand keeps SDL's own bookkeeping (mScreenKeyboardShown,
 * surface refocus) consistent instead of replicating the handler's body.
 */
public final class KeenKeyboard {
    private KeenKeyboard() {}

    public static boolean isShown() {
        return SDLActivity.mScreenKeyboardShown;
    }

    /** Raise the IME. The 1x1 DummyEdit at the top-left keeps it from panning the game. */
    public static void show() {
        SDLActivity.showTextInput(0, 0, 1, 1);
    }

    public static void hide() {
        if (SDLActivity.mSingleton != null) {
            SDLActivity.mSingleton.sendCommand(SDLActivity.COMMAND_TEXTEDIT_HIDE, null);
        }
    }
}
