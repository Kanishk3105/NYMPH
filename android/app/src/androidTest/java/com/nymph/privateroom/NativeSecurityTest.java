package com.nymph.privateroom;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.view.WindowManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeSecurityTest {

    @Test
    public void disablesApplicationDataBackup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ApplicationInfo applicationInfo = context.getPackageManager().getApplicationInfo(
            context.getPackageName(),
            0
        );

        assertEquals(0, applicationInfo.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
    }

    @Test
    public void protectsActivityWindowFromOrdinaryCapture() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> org.junit.Assert.assertNotEquals(
                0,
                activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE
            ));
        }
    }
}
