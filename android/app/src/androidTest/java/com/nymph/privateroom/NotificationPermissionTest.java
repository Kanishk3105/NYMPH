package com.nymph.privateroom;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Arrays;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NotificationPermissionTest {

    @Test
    @SuppressWarnings("deprecation")
    public void declaresRuntimeNotificationPermission() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo packageInfo = context.getPackageManager().getPackageInfo(
            context.getPackageName(),
            PackageManager.GET_PERMISSIONS
        );

        assertNotNull(packageInfo.requestedPermissions);
        assertTrue(Arrays.asList(packageInfo.requestedPermissions)
            .contains(Manifest.permission.POST_NOTIFICATIONS));
    }
}
