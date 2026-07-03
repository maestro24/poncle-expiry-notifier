package com.poncleexpiry.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the app's native plugins before the bridge initializes.
        registerPlugin(SmsPlugin.class);
        registerPlugin(PonclePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
