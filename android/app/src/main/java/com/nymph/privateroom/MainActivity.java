package com.nymph.privateroom;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.view.WindowManager;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        protectWindow();
    }

    @Override
    public void onResume() {
        super.onResume();
        protectWindow();
    }

    private void protectWindow() {
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
